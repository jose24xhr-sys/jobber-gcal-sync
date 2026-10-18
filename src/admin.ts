import type { Env } from "./env";
import * as repo from "./db/repo";
import { jobberGraphQL, USERS_QUERY } from "./jobber/graphql";
import { timingSafeEqual } from "./util/crypto";

export function isAdmin(env: Env, request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(env.ADMIN_API_TOKEN) && token.length > 0 && timingSafeEqual(token, env.ADMIN_API_TOKEN);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

/**
 * Admin API (Bearer ADMIN_API_TOKEN):
 *   GET    /admin/accounts
 *   GET    /admin/jobber/users?accountId=…            Jobber users with IDs, to build the mapping
 *   GET    /admin/mappings[?accountId=…]
 *   PUT    /admin/mappings  {accountId, jobberUserId, googleCalendarId, label?, active?}
 *   DELETE /admin/mappings?accountId=…&jobberUserId=…
 *   GET    /admin/visits?accountId=…&visitId=…        stored visit -> event rows
 *   POST   /admin/resync {accountId, visitId}         re-run a visit through the queue
 *   GET    /admin/log?limit=50
 */
export async function handleAdmin(env: Env, request: Request, url: URL): Promise<Response> {
  if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
  const path = url.pathname;
  const q = url.searchParams;

  if (path === "/admin/accounts" && request.method === "GET") return json(await repo.listAccounts(env.DB));

  if (path === "/admin/jobber/users" && request.method === "GET") {
    const accountId = q.get("accountId");
    if (!accountId) return json({ error: "accountId required" }, 400);
    const data = await jobberGraphQL<{ users: { nodes: { id: string; name: { full: string } }[] } }>(env, accountId, USERS_QUERY, { first: 100 });
    const mapped = await repo.listMappings(env.DB, accountId);
    return json(
      data.users.nodes.map((u) => ({
        jobberUserId: u.id,
        name: u.name?.full,
        googleCalendarId: mapped.find((m) => m.jobber_user_id === u.id)?.google_calendar_id ?? null,
      })),
    );
  }

  if (path === "/admin/mappings") {
    if (request.method === "GET") return json(await repo.listMappings(env.DB, q.get("accountId") ?? undefined));
    if (request.method === "PUT") {
      const b = (await request.json().catch(() => null)) as {
        accountId?: string;
        jobberUserId?: string;
        googleCalendarId?: string;
        label?: string;
        active?: boolean;
      } | null;
      if (!b?.accountId || !b.jobberUserId || !b.googleCalendarId) {
        return json({ error: "accountId, jobberUserId and googleCalendarId are required" }, 400);
      }
      await repo.upsertMapping(env.DB, { ...b, accountId: b.accountId, jobberUserId: b.jobberUserId, googleCalendarId: b.googleCalendarId, now: Date.now() });
      return json({ ok: true });
    }
    if (request.method === "DELETE") {
      const accountId = q.get("accountId");
      const jobberUserId = q.get("jobberUserId");
      if (!accountId || !jobberUserId) return json({ error: "accountId and jobberUserId required" }, 400);
      await repo.deleteMapping(env.DB, accountId, jobberUserId);
      return json({ ok: true });
    }
  }

  if (path === "/admin/visits" && request.method === "GET") {
    const accountId = q.get("accountId");
    const visitId = q.get("visitId");
    if (!accountId || !visitId) return json({ error: "accountId and visitId required" }, 400);
    return json(await repo.listVisitEvents(env.DB, accountId, visitId));
  }

  if (path === "/admin/resync" && request.method === "POST") {
    const b = (await request.json().catch(() => null)) as { accountId?: string; visitId?: string } | null;
    if (!b?.accountId || !b.visitId) return json({ error: "accountId and visitId required" }, 400);
    await env.SYNC_QUEUE.send({ topic: "VISIT_UPDATE", accountId: b.accountId, itemId: b.visitId, receivedAt: Date.now() });
    return json({ ok: true, queued: true });
  }

  if (path === "/admin/log" && request.method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 50) || 50));
    return json(await repo.recentSyncLog(env.DB, limit));
  }

  return json({ error: "not found" }, 404);
}
