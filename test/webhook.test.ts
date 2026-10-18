import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import worker from "../src/index";
import { verifyJobberSignature, parseJobberWebhook } from "../src/jobber/webhook";
import { classifyTopic } from "../src/config";
import { gid, setup, signedWebhook, webhookBody, CLIENT_SECRET } from "./helpers/fakes";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(() => vi.unstubAllGlobals());

describe("webhook signature", () => {
  it("matches Jobber's documented Node.js algorithm (createHmac sha256 -> base64 over the raw body)", async () => {
    // Same computation as the Node example on developer.getjobber.com "Verifying webhook authenticity".
    // (The sample signature string in the docs is illustrative and does not derive from the placeholder secrets shown.)
    const body = '{"data":{"webHookEvent":{"topic":"APP_CONNECT","appId":"id","accountId":"id","itemId":"id","occurredAt":"ISO8601DateTime"}}}';
    const secret = "your app's OAuth client secret";
    const reference = createHmac("sha256", secret).update(body).digest("base64");
    expect(await verifyJobberSignature(body, reference, secret)).toBe(true);
    expect(await verifyJobberSignature(body, reference, "other secret")).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const body = webhookBody("VISIT_CREATE", gid("Visit", 1));
    const req = await signedWebhook(body);
    const sig = req.headers.get("X-Jobber-Hmac-SHA256");
    expect(await verifyJobberSignature(body.replace("VISIT_CREATE", "VISIT_DESTROY"), sig, CLIENT_SECRET)).toBe(false);
  });
});

describe("POST /webhooks/jobber", () => {
  it("returns 401 and enqueues nothing without a valid signature", async () => {
    const h = await setup();
    const body = webhookBody("VISIT_CREATE", gid("Visit", 1));
    const missing = new Request("https://worker.test/webhooks/jobber", { method: "POST", body });
    expect((await worker.fetch(missing, h.env, ctx)).status).toBe(401);
    const wrong = await signedWebhook(body, "not-the-secret");
    expect((await worker.fetch(wrong, h.env, ctx)).status).toBe(401);
    expect(h.queue.sent).toHaveLength(0);
  });

  it("verifies, enqueues the Visit ID and returns 200 without calling Jobber or Google", async () => {
    const h = await setup();
    const res = await worker.fetch(await signedWebhook(webhookBody("VISIT_CREATE", gid("Visit", 1))), h.env, ctx);
    expect(res.status).toBe(200);
    expect(h.queue.sent).toEqual([expect.objectContaining({ topic: "VISIT_CREATE", itemId: gid("Visit", 1) })]);
    expect(h.jobber.graphqlCalls).toHaveLength(0);
    expect(h.google.calls).toHaveLength(0);
  });

  it("accepts the legacy `occuredAt` field", async () => {
    const e = parseJobberWebhook(webhookBody("VISIT_UPDATE", "x", { legacyTimestamp: true }));
    expect(e?.occurredAt).toBe("2026-10-13T10:00:00-05:00");
  });

  it.each(["REQUEST_CREATE", "REQUEST_UPDATE", "QUOTE_CREATE", "QUOTE_UPDATE", "QUOTE_APPROVED", "ASSESSMENT_CREATE", "INVOICE_CREATE", "CLIENT_CREATE"])(
    "%s is acknowledged but never queued",
    async (topic) => {
      const h = await setup();
      const res = await worker.fetch(await signedWebhook(webhookBody(topic, gid("Request", 1))), h.env, ctx);
      expect(res.status).toBe(200);
      expect(h.queue.sent).toHaveLength(0);
    },
  );
});

describe("topic classification", () => {
  const env = { ALLOWED_TOPICS: undefined };
  it("routes visit and job topics", () => {
    expect(classifyTopic("VISIT_CREATE", env)).toBe("visit_upsert");
    expect(classifyTopic("VISIT_UPDATE", env)).toBe("visit_upsert");
    expect(classifyTopic("VISIT_COMPLETE", env)).toBe("visit_upsert");
    expect(classifyTopic("VISIT_DESTROY", env)).toBe("visit_delete");
    expect(classifyTopic("JOB_DESTROY", env)).toBe("job_delete");
    expect(classifyTopic("JOB_CREATE", env)).toBe("job_create");
    expect(classifyTopic("JOB_UPDATE", env)).toBe("job_update");
    expect(classifyTopic("REQUEST_CREATE", env)).toBe("ignored");
    expect(classifyTopic("QUOTE_UPDATE", env)).toBe("ignored");
  });
  it("respects an ALLOWED_TOPICS override (e.g. if the Developer Center uses *_DELETE)", () => {
    const e = { ALLOWED_TOPICS: "VISIT_CREATE, VISIT_UPDATE, VISIT_DELETE" };
    expect(classifyTopic("VISIT_DELETE", e)).toBe("visit_delete");
    expect(classifyTopic("VISIT_DESTROY", e)).toBe("ignored");
    expect(classifyTopic("REQUEST_CREATE", { ALLOWED_TOPICS: "REQUEST_CREATE" })).toBe("ignored");
  });
});
