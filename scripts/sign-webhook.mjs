#!/usr/bin/env node
// Sends a correctly signed fake Jobber webhook to a running worker (local `wrangler dev` or deployed).
// Usage:
//   JOBBER_CLIENT_SECRET=... node scripts/sign-webhook.mjs <topic> <itemId> <accountId> [url]
// Example:
//   node scripts/sign-webhook.mjs VISIT_UPDATE Z2lkOi8vSm9iYmVyL1Zpc2l0LzEyMw== <accountId> http://localhost:8787/webhooks/jobber
import { createHmac } from "node:crypto";

const [topic, itemId, accountId, url = "http://localhost:8787/webhooks/jobber"] = process.argv.slice(2);
const secret = process.env.JOBBER_CLIENT_SECRET;
if (!topic || !itemId || !accountId || !secret) {
  console.error("Usage: JOBBER_CLIENT_SECRET=... node scripts/sign-webhook.mjs <topic> <itemId> <accountId> [url]");
  process.exit(1);
}

const body = JSON.stringify({
  data: { webHookEvent: { topic, appId: "local-test", accountId, itemId, occurredAt: new Date().toISOString() } },
});
const signature = createHmac("sha256", secret).update(body).digest("base64");

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Jobber-Hmac-SHA256": signature },
  body,
});
console.log(res.status, await res.text());
