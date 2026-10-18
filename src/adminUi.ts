import type { Env } from "./env";
import * as repo from "./db/repo";
import { jobberGraphQL, USERS_QUERY } from "./jobber/graphql";
import { startJobberOAuth } from "./jobber/oauth";
import { timingSafeEqual } from "./util/crypto";

/**
 * Browser-friendly admin pages. The admin token is typed into a password box and POSTed,
 * so tokens containing #, &, + or $ never have to be URL-encoded.
 *   GET/POST /oauth/jobber/start   connect a Jobber account
 *   GET/POST /admin                map Jobber users -> Google Calendar IDs, see recent sync log
 */

function tokenOk(env: Env, key: string | null | undefined): boolean {
  return Boolean(env.ADMIN_API_TOKEN) && typeof key === "string" && key.length > 0 && timingSafeEqual(key, env.ADMIN_API_TOKEN);
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--accent:#2f6f4f;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ededea;--muted:#a3a39c;--line:#2e2e2b;--accent:#6fc196;--err:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 24px}
input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);width:100%}
button{font:inherit;padding:8px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse;margin:8px 0 24px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}code{font-size:12px;word-break:break-all;color:var(--muted)}
.err{color:var(--err)}.ok{color:var(--accent)}.row{display:flex;gap:8px;max-width:420px}.small{font-size:13px;color:var(--muted)}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } },
  );
}

function loginForm(action: string, title: string, sub: string, error?: string): Response {
  return page(
    title,
    `<h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${esc(action)}" class="row">
<input type="password" name="key" placeholder="ADMIN_API_TOKEN" autocomplete="current-password" required autofocus>
<button type="submit">Continue</button></form>`,
    error ? 401 : 200,
  );
}

async function formData(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

/** /oauth/jobber/start */
export async function handleJobberStartPage(env: Env, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET") {
    if (tokenOk(env, url.searchParams.get("key"))) return startJobberOAuth(env);
    return loginForm("/oauth/jobber/start", "Connect Jobber", "Enter the admin token to connect a Jobber account.");
  }
  const f = await formData(request);
  if (!tokenOk(env, f.get("key"))) return loginForm("/oauth/jobber/start", "Connect Jobber", "Enter the admin token to connect a Jobber account.", "That token didn't match ADMIN_API_TOKEN.");
  return startJobberOAuth(env);
}

/** /admin */
export async function handleAdminPage(env: Env, request: Request): Promise<Response> {
  const title = "Jobber → Google Calendar";
  if (request.method === "GET") return loginForm("/admin", title, "Enter the admin token to manage team calendars.");

  const f = await formData(request);
  const key = f.get("key");
  if (!tokenOk(env, key)) return loginForm("/admin", title, "Enter the admin token to manage team calendars.", "That token didn't match ADMIN_API_TOKEN.");

  let notice = "";
  if (f.get("action") === "save") {
    const accountId = f.get("accountId") ?? "";
    let saved = 0;
    for (const [name, value] of f) {
      if (!name.startsWith("cal:")) continue;
      const userId = name.slice(4);
      const label = f.get(`label:${userId}`) ?? null;
      const cal = value.trim();
      if (cal) {
        await repo.upsertMapping(env.DB, { accountId, jobberUserId: userId, googleCalendarId: cal, label, now: Date.now() });
        saved++;
      } else {
        await repo.deleteMapping(env.DB, accountId, userId);
      }
    }
    notice = `<p class="ok">Saved ${saved} calendar mapping${saved === 1 ? "" : "s"}.</p>`;
  }

  const accounts = await repo.listAccounts(env.DB);
  if (accounts.length === 0) {
    return page(title, `<h1>${title}</h1><p class="sub">No Jobber account is connected yet.</p><p><a href="/oauth/jobber/start">Connect Jobber →</a></p>`);
  }

  let sections = "";
  for (const a of accounts) {
    const mappings = await repo.listMappings(env.DB, a.account_id);
    let users: { id: string; name?: { full?: string } }[] = [];
    let usersError = "";
    if (a.status === "active") {
      try {
        users = (await jobberGraphQL<{ users: { nodes: { id: string; name: { full: string } }[] } }>(env, a.account_id, USERS_QUERY, { first: 100 })).users.nodes;
      } catch (e) {
        usersError = String((e as Error).message ?? e);
      }
    }
    // Include mapped users that the API didn't return (e.g. deactivated).
    for (const m of mappings) if (!users.some((u) => u.id === m.jobber_user_id)) users.push({ id: m.jobber_user_id, name: { full: m.label ?? "(not in Jobber list)" } });

    const rows = users
      .map((u) => {
        const m = mappings.find((x) => x.jobber_user_id === u.id);
        const name = u.name?.full ?? "";
        return `<tr><td>${esc(name)}<br><code>${esc(u.id)}</code><input type="hidden" name="label:${esc(u.id)}" value="${esc(name)}"></td>
<td><input name="cal:${esc(u.id)}" value="${esc(m?.google_calendar_id ?? "")}" placeholder="estimator@company.com"></td></tr>`;
      })
      .join("");

    sections += `<h2 style="font-size:17px;margin:24px 0 4px">${esc(a.account_name ?? "Jobber account")}</h2>
<p class="small">Status: <b>${esc(a.status)}</b>${a.status !== "active" ? ` — <a href="/oauth/jobber/start">reconnect</a>` : ""}<br>Account ID: <code>${esc(a.account_id)}</code></p>
${usersError ? `<p class="err">Couldn't load Jobber users: ${esc(usersError)}</p>` : ""}
<form method="post" action="/admin"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="action" value="save"><input type="hidden" name="accountId" value="${esc(a.account_id)}">
<table><thead><tr><th>Jobber team member</th><th>Google Calendar ID (leave blank to stop syncing)</th></tr></thead><tbody>${rows || `<tr><td colspan="2" class="small">No users found.</td></tr>`}</tbody></table>
<button type="submit">Save mappings</button></form>`;
  }

  const log = (await repo.recentSyncLog(env.DB, 25)) as Record<string, unknown>[];
  const logRows = log
    .map(
      (r) =>
        `<tr><td class="small">${esc(new Date(Number(r.at)).toLocaleString("en-US"))}</td><td>${esc(r.action)}</td><td class="small">${esc(r.topic)}</td><td class="small">${esc(String(r.detail ?? "").slice(0, 160))}</td></tr>`,
    )
    .join("");

  return page(
    title,
    `<h1>${title}</h1><p class="sub">Each team member's Jobber visits are written to the Google Calendar listed here. Share that calendar with <code>${esc(env.GOOGLE_SA_CLIENT_EMAIL ?? "the service account")}</code> ("Make changes to events") first.</p>
${notice}${sections}
<h2 style="font-size:17px;margin:32px 0 4px">Recent activity</h2>
<table><thead><tr><th>When</th><th>Action</th><th>Topic</th><th>Detail</th></tr></thead><tbody>${logRows || `<tr><td colspan="4" class="small">Nothing yet.</td></tr>`}</tbody></table>`,
  );
}
