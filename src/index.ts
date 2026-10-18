import type { Env, SyncMessage } from "./env";
import { classifyTopic } from "./config";
import { JOBBER_SIGNATURE_HEADER, parseJobberWebhook, verifyJobberSignature } from "./jobber/webhook";
import { handleJobberCallback, startJobberOAuth } from "./jobber/oauth";
import { handleAdmin, isAdmin } from "./admin";
import { processMessage } from "./sync/processor";
import { PermanentError, RetryableError, queueBackoffSeconds } from "./util/retry";
import * as repo from "./db/repo";
import { log } from "./log";

/**
 * Jobber webhook -> verify HMAC -> enqueue IDs -> 200 (well under Jobber's 1s limit).
 * All Jobber/Google API work happens in the queue consumer.
 */
async function handleWebhook(env: Env, request: Request): Promise<Response> {
  const raw = await request.text();
  const ok = await verifyJobberSignature(raw, request.headers.get(JOBBER_SIGNATURE_HEADER), env.JOBBER_CLIENT_SECRET);
  if (!ok) {
    log("warn", "Rejected webhook: invalid or missing signature", { bytes: raw.length });
    return new Response("invalid signature", { status: 401 });
  }

  const evt = parseJobberWebhook(raw);
  if (!evt) {
    log("warn", "Rejected webhook: unrecognized payload");
    return new Response("bad payload", { status: 400 });
  }

  const kind = classifyTopic(evt.topic, env);
  if (kind === "ignored") {
    log("info", "Skipped non-job event", { topic: evt.topic, itemId: evt.itemId, accountId: evt.accountId });
    return new Response("ignored", { status: 200 });
  }

  const msg: SyncMessage = { topic: evt.topic, accountId: evt.accountId, itemId: evt.itemId, occurredAt: evt.occurredAt, receivedAt: Date.now() };
  await env.SYNC_QUEUE.send(msg);
  log("info", "webhook queued", { topic: evt.topic, itemId: evt.itemId, accountId: evt.accountId, kind });
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/webhooks/jobber" && request.method === "POST") return await handleWebhook(env, request);

      if (url.pathname === "/oauth/jobber/start" && request.method === "GET") {
        // Accept the admin token as ?key= so the link can be opened in a browser.
        const key = url.searchParams.get("key");
        const authed = isAdmin(env, request) || (key !== null && isAdmin(env, new Request(request.url, { headers: { authorization: `Bearer ${key}` } })));
        if (!authed) return new Response("unauthorized", { status: 401 });
        return await startJobberOAuth(env);
      }
      if (url.pathname === "/oauth/jobber/callback" && request.method === "GET") return await handleJobberCallback(env, request);
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(env, request, url);
      return new Response("not found", { status: 404 });
    } catch (err) {
      log("error", "request failed", { path: url.pathname, error: String(err) });
      return new Response("internal error", { status: 500 });
    }
  },

  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    // Collapse duplicates inside a batch (Jobber can fire the same topic ~1s apart for one action).
    const seen = new Set<string>();
    for (const message of batch.messages) {
      const m = message.body;
      const key = `${classifyTopic(m.topic, env)}|${m.accountId}|${m.itemId}`;
      if (seen.has(key)) {
        log("info", "duplicate in batch collapsed", { topic: m.topic, itemId: m.itemId });
        message.ack();
        continue;
      }
      seen.add(key);

      try {
        await processMessage(env, m);
        message.ack();
      } catch (err) {
        if (err instanceof PermanentError) {
          log("error", "sync failed permanently (not retried)", { topic: m.topic, itemId: m.itemId, accountId: m.accountId, error: err.message });
          await repo.writeSyncLog(env.DB, { at: Date.now(), topic: m.topic, accountId: m.accountId, itemId: m.itemId, action: "error", detail: err.message });
          message.ack();
        } else {
          const hint = err instanceof RetryableError ? err.retryAfterSeconds : undefined;
          const delaySeconds = queueBackoffSeconds(message.attempts, hint);
          log("warn", "sync failed; will retry", { topic: m.topic, itemId: m.itemId, attempts: message.attempts, delaySeconds, error: String(err) });
          message.retry({ delaySeconds });
        }
      }
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await repo.prune(env.DB, Date.now());
  },
} satisfies ExportedHandler<Env, SyncMessage>;
