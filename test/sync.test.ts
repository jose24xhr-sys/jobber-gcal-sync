import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import {
  ACCOUNT_ID,
  CAL_ANA,
  CAL_BEN,
  USER_ANA,
  USER_BEN,
  USER_UNMAPPED,
  batchOf,
  gid,
  makeVisit,
  msg,
  setup,
  signedWebhook,
  webhookBody,
} from "./helpers/fakes";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

async function consume(env: Env, ...messages: ReturnType<typeof msg>[]) {
  const { batch, outcomes } = batchOf(messages);
  await worker.queue(batch, env, ctx);
  return outcomes;
}

const VISIT_1 = gid("Visit", 1);

describe("Job Visit -> Google Calendar", () => {
  it("scheduled Job Visit creates a calendar event with the right fields", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));

    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));

    expect(out[0]).toEqual({ ack: 1, retry: [] });
    const live = h.google.live(CAL_ANA);
    expect(live).toHaveLength(1);
    const ev = live[0]!.body;
    expect(ev.id).toMatch(/^jv[0-9a-f]{40}$/);
    expect(ev.summary).toBe("Visit 1");
    expect(ev.start).toEqual({ dateTime: "2026-10-20T14:00:00Z" });
    expect(ev.end).toEqual({ dateTime: "2026-10-20T16:00:00Z" });
    expect(ev.location).toBe("1 Main St, Raleigh, NC 27601, US");
    expect(ev.description).toContain("Client: Jane Client");
    expect(ev.description).toContain("Gate code 1234");
    expect(ev.description).toContain("https://secure.getjobber.com/work_orders/501");
    expect(ev.transparency).toBe("opaque");
    expect(ev.extendedProperties.private).toMatchObject({
      jobberAccountId: ACCOUNT_ID,
      jobberVisitId: VISIT_1,
      jobberJobId: gid("Job", 501),
      jobberUserId: USER_ANA,
    });
    // GraphQL request carried the version header and the Visit ID
    expect(h.jobber.graphqlCalls[0]!.variables).toEqual({ id: VISIT_1 });
  });

  it("full path: signed webhook -> queue -> consumer", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await worker.fetch(await signedWebhook(webhookBody("VISIT_CREATE", VISIT_1)), h.env, ctx);
    const { batch } = batchOf(h.queue.sent);
    await worker.queue(batch, h.env, ctx);
    expect(h.google.live(CAL_ANA)).toHaveLength(1);
  });

  it("Visit update (reschedule, new title/instructions) modifies the existing event", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    const firstId = h.google.live(CAL_ANA)[0]!.body.id;

    h.jobber.visits.set(VISIT_1, makeVisit(1, { startAt: "2026-10-21T18:00:00Z", endAt: "2026-10-21T19:30:00Z", title: "Moved visit", instructions: "Call first" }));
    await consume(h.env, msg("VISIT_UPDATE", VISIT_1));

    const live = h.google.live(CAL_ANA);
    expect(live).toHaveLength(1);
    expect(live[0]!.body.id).toBe(firstId);
    expect(live[0]!.body.start).toEqual({ dateTime: "2026-10-21T18:00:00Z" });
    expect(live[0]!.body.summary).toBe("Moved visit");
    expect(live[0]!.body.description).toContain("Call first");
  });

  it("Visit deletion removes the event using the stored mapping (Visit no longer retrievable)", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.live()).toHaveLength(1);

    h.jobber.visits.delete(VISIT_1); // gone from Jobber
    const callsBefore = h.jobber.graphqlCalls.length;
    await consume(h.env, msg("VISIT_DESTROY", VISIT_1));

    expect(h.google.live()).toHaveLength(0);
    expect(h.jobber.graphqlCalls.length).toBe(callsBefore); // delete needs no Jobber lookup
    const rows = await h.env.DB.prepare("SELECT * FROM visit_events").all();
    expect(rows.results).toHaveLength(0);
  });

  it("VISIT_UPDATE for a visit that no longer exists also cleans up", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    h.jobber.visits.delete(VISIT_1);
    await consume(h.env, msg("VISIT_UPDATE", VISIT_1)); // out-of-order delivery after deletion
    expect(h.google.live()).toHaveLength(0);
  });

  it("reassignment moves the event from the old team member's calendar to the new one", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.live(CAL_ANA)).toHaveLength(1);

    h.jobber.visits.set(VISIT_1, makeVisit(1, { assignedUsers: { nodes: [{ id: USER_BEN, name: { full: "Ben" } }] } }));
    await consume(h.env, msg("VISIT_UPDATE", VISIT_1));

    expect(h.google.live(CAL_ANA)).toHaveLength(0);
    expect(h.google.live(CAL_BEN)).toHaveLength(1);
    expect(h.google.live(CAL_BEN)[0]!.body.extendedProperties.private.jobberUserId).toBe(USER_BEN);
  });

  it("moving back to the original assignee revives the cancelled event instead of failing", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    h.jobber.visits.set(VISIT_1, makeVisit(1, { assignedUsers: { nodes: [{ id: USER_BEN }] } }));
    await consume(h.env, msg("VISIT_UPDATE", VISIT_1));
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    const out = await consume(h.env, msg("VISIT_UPDATE", VISIT_1));
    expect(out[0]!.ack).toBe(1);
    expect(h.google.live(CAL_ANA)).toHaveLength(1);
    expect(h.google.live(CAL_BEN)).toHaveLength(0);
  });

  it("duplicate webhooks do not create duplicates (and skip redundant Google writes)", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    const writesAfterFirst = h.google.writeCalls().length;

    // Same event redelivered (at-least-once), in separate batches and twice in one batch.
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    await consume(h.env, msg("VISIT_UPDATE", VISIT_1), msg("VISIT_UPDATE", VISIT_1));

    expect(h.google.live(CAL_ANA)).toHaveLength(1);
    expect(h.google.events.size).toBe(1);
    expect(h.google.writeCalls().length).toBe(writesAfterFirst);
  });

  it("multiple assigned users get one event each", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1, { assignedUsers: { nodes: [{ id: USER_ANA }, { id: USER_BEN }] } }));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.live(CAL_ANA)).toHaveLength(1);
    expect(h.google.live(CAL_BEN)).toHaveLength(1);
    expect(h.google.live(CAL_ANA)[0]!.body.id).not.toBe(h.google.live(CAL_BEN)[0]!.body.id);
  });

  it("assigned users without a calendar mapping are skipped", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1, { assignedUsers: { nodes: [{ id: USER_UNMAPPED }, { id: USER_ANA }] } }));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.live()).toHaveLength(1);
    expect(h.google.live(CAL_ANA)).toHaveLength(1);
  });

  it("unscheduled Job Visits are ignored", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1, { startAt: null, endAt: null }));
    const log = vi.spyOn(console, "log");
    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(out[0]!.ack).toBe(1);
    expect(h.google.calls).toHaveLength(0);
    expect(log.mock.calls.some((c) => String(c[0]).includes("Skipped unscheduled job visit"))).toBe(true);
  });

  it("a visit that becomes unscheduled is removed from the calendar", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    h.jobber.visits.set(VISIT_1, makeVisit(1, { startAt: null, endAt: null }));
    await consume(h.env, msg("VISIT_UPDATE", VISIT_1));
    expect(h.google.live()).toHaveLength(0);
  });

  it("visits with no assigned users are skipped", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1, { assignedUsers: { nodes: [] } }));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.calls).toHaveLength(0);
  });

  it("all-day visits become all-day events with an exclusive end date", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1, { allDay: true, startAt: "2026-10-20T04:00:00Z", endAt: "2026-10-21T03:59:59Z" }));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    const ev = h.google.live(CAL_ANA)[0]!.body;
    expect(ev.start).toEqual({ date: "2026-10-20" });
    expect(ev.end).toEqual({ date: "2026-10-21" });
  });

  it("JOB_CREATE syncs every scheduled visit of the new job; the later VISIT_CREATE is a no-op", async () => {
    const h = await setup();
    const jobId = gid("Job", 777);
    const job = { __typename: "Job", id: jobId, jobNumber: 777, title: "Repaint", jobberWebUri: "https://secure.getjobber.com/work_orders/777" };
    const v1 = makeVisit(71, { job });
    const v2 = makeVisit(72, { job, startAt: "2026-10-22T14:00:00Z", endAt: "2026-10-22T15:00:00Z" });
    const unscheduled = makeVisit(73, { job, startAt: null, endAt: null });
    for (const v of [v1, v2, unscheduled]) h.jobber.visits.set(v.id, v);

    await consume(h.env, msg("JOB_CREATE", jobId));
    expect(h.google.live(CAL_ANA)).toHaveLength(2);
    const writes = h.google.writeCalls().length;

    await consume(h.env, msg("VISIT_CREATE", v1.id), msg("VISIT_CREATE", v2.id));
    expect(h.google.live(CAL_ANA)).toHaveLength(2);
    expect(h.google.writeCalls().length).toBe(writes);
  });

  it("JOB_DESTROY removes every tracked visit of that job", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1, { assignedUsers: { nodes: [{ id: USER_ANA }, { id: USER_BEN }] } }));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    await consume(h.env, msg("JOB_DESTROY", gid("Job", 501)));
    expect(h.google.live()).toHaveLength(0);
  });
});

describe("Requests and Estimates/Quotes never reach Google Calendar", () => {
  it.each(["REQUEST_CREATE", "REQUEST_UPDATE", "ASSESSMENT_CREATE", "ASSESSMENT_UPDATE"])("%s -> no Jobber lookup, no calendar write", async (topic) => {
    const h = await setup();
    const out = await consume(h.env, msg(topic, gid("Request", 77)));
    expect(out[0]!.ack).toBe(1);
    expect(h.jobber.graphqlCalls).toHaveLength(0);
    expect(h.google.calls).toHaveLength(0);
  });

  it.each(["QUOTE_CREATE", "QUOTE_UPDATE", "QUOTE_SENT", "QUOTE_APPROVED"])("%s -> no Jobber lookup, no calendar write", async (topic) => {
    const h = await setup();
    const out = await consume(h.env, msg(topic, gid("Quote", 88)));
    expect(out[0]!.ack).toBe(1);
    expect(h.jobber.graphqlCalls).toHaveLength(0);
    expect(h.google.calls).toHaveLength(0);
  });

  it("a VISIT_* topic whose ID decodes to a Request or Quote is skipped as a non-job event", async () => {
    const h = await setup();
    await consume(h.env, msg("VISIT_UPDATE", gid("Request", 77)), msg("VISIT_CREATE", gid("Quote", 88)));
    expect(h.jobber.graphqlCalls).toHaveLength(0);
    expect(h.google.calls).toHaveLength(0);
  });

  it("a non-Visit object returned by the API is rejected before any Google write", async () => {
    const h = await setup();
    const assessment = { ...makeVisit(2), __typename: "Assessment", job: null } as never;
    h.jobber.visits.set(gid("Visit", 2), assessment);
    await consume(h.env, msg("VISIT_UPDATE", gid("Visit", 2)));
    expect(h.google.calls).toHaveLength(0);
  });

  it("a Quote approved into a Job syncs only the resulting Job Visit", async () => {
    const h = await setup();
    await consume(h.env, msg("QUOTE_APPROVED", gid("Quote", 88)), msg("JOB_CREATE", gid("Job", 900)));
    expect(h.google.calls).toHaveLength(0);
    const v = makeVisit(9);
    h.jobber.visits.set(v.id, v);
    await consume(h.env, msg("VISIT_CREATE", v.id));
    expect(h.google.live()).toHaveLength(1);
  });
});

describe("retries, throttling and tokens", () => {
  it("retries a transient Google 503 inline and still creates exactly one event", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    h.google.failNext.push(503);
    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(out[0]).toEqual({ ack: 1, retry: [] });
    expect(h.google.live()).toHaveLength(1);
  });

  it("Jobber THROTTLED -> message is retried later with a delay; replay is idempotent", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    h.jobber.injectGraphQL.push(() =>
      Response.json({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: 40, actualQueryCost: 0, throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 } } },
      }),
    );
    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(out[0]!.ack).toBe(0);
    expect(out[0]!.retry[0]!.delaySeconds).toBeGreaterThan(0);
    expect(h.google.calls).toHaveLength(0);

    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.live()).toHaveLength(1);
  });

  it("Google failure after the mapping row is written still allows a clean retry", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    h.google.failNext.push(503, 503, 503); // exhaust inline retries for the PUT
    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(out[0]!.retry).toHaveLength(1);
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.google.live()).toHaveLength(1);
  });

  it("calendar not shared with the service identity -> permanent error, acked, not retried", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    h.google.forbidden.add(CAL_ANA);
    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(out[0]).toEqual({ ack: 1, retry: [] });
    const err = await h.env.DB.prepare("SELECT * FROM sync_log WHERE action = 'error'").all();
    expect(err.results.length).toBe(1);
  });

  it("expired access token is refreshed and the rotated refresh token is persisted", async () => {
    const h = await setup({ accessExpiresInMs: -1000 });
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.jobber.tokenCalls).toHaveLength(1);
    expect(h.google.live()).toHaveLength(1);

    // Second message uses the stored (rotated) tokens; no extra refresh.
    h.jobber.visits.set(gid("Visit", 2), makeVisit(2));
    await consume(h.env, msg("VISIT_CREATE", gid("Visit", 2)));
    expect(h.jobber.tokenCalls).toHaveLength(1);

    const row = await h.env.DB.prepare("SELECT access_token_enc, refresh_token_enc FROM jobber_accounts").first<Record<string, string>>();
    expect(row!.refresh_token_enc).not.toContain("jobber-refresh"); // encrypted at rest
  });

  it("a 401 mid-flight forces one refresh and succeeds", async () => {
    const h = await setup();
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    h.jobber.validAccessToken = "revoked-elsewhere"; // stored token no longer accepted
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(h.jobber.tokenCalls).toHaveLength(1);
    expect(h.google.live()).toHaveLength(1);
  });

  it("an invalid refresh token marks the account reauth_required and stops retrying", async () => {
    const h = await setup({ accessExpiresInMs: -1000 });
    h.jobber.validRefreshToken = "something-else";
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    const out = await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    expect(out[0]).toEqual({ ack: 1, retry: [] });
    const acct = await h.env.DB.prepare("SELECT status FROM jobber_accounts").first<{ status: string }>();
    expect(acct!.status).toBe("reauth_required");
  });

  it("APP_DISCONNECT disables the account", async () => {
    const h = await setup();
    await consume(h.env, msg("APP_DISCONNECT", ACCOUNT_ID));
    const acct = await h.env.DB.prepare("SELECT status FROM jobber_accounts").first<{ status: string }>();
    expect(acct!.status).toBe("disconnected");
  });

  it("never logs tokens", async () => {
    const h = await setup({ accessExpiresInMs: -1000 });
    h.jobber.visits.set(VISIT_1, makeVisit(1));
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    await consume(h.env, msg("VISIT_CREATE", VISIT_1));
    const all = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join("\n");
    expect(all).not.toMatch(/jobber-access-|jobber-refresh-|google-access|g-refresh/);
  });
});
