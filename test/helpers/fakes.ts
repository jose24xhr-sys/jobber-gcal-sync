// In-memory fakes for the Jobber API and Google Calendar API, served through a stubbed global fetch.
import { vi } from "vitest";
import type { Env, SyncMessage } from "../../src/env";
import type { JobberVisit } from "../../src/jobber/graphql";
import { createTestD1 } from "./d1";
import { encryptString, hmacSha256Base64 } from "../../src/util/crypto";
import { resetGoogleTokenCache } from "../../src/google/auth";
import { retryConfig } from "../../src/util/retry";

export const gid = (type: string, n: number | string) => btoa(`gid://Jobber/${type}/${n}`);

export const ACCOUNT_ID = gid("Account", 1);
export const USER_ANA = gid("User", 101);
export const USER_BEN = gid("User", 102);
export const USER_UNMAPPED = gid("User", 199);
export const CAL_ANA = "ana@example.com";
export const CAL_BEN = "ben@example.com";
export const CLIENT_SECRET = "test-jobber-client-secret";

export interface StoredEvent {
  calendarId: string;
  body: Record<string, any>;
  status: "confirmed" | "cancelled";
}

export class FakeGoogle {
  events = new Map<string, StoredEvent>(); // key: calendarId|eventId
  calls: { method: string; calendarId: string; eventId?: string }[] = [];
  /** Responses to inject (status codes) before the normal behavior, consumed in order. */
  failNext: number[] = [];
  /** Calendars that are not shared with our identity (403). */
  forbidden = new Set<string>();

  live(calendarId?: string) {
    return [...this.events.values()].filter((e) => e.status === "confirmed" && (!calendarId || e.calendarId === calendarId));
  }
  writeCalls() {
    return this.calls.filter((c) => c.method !== "GET");
  }

  handle(method: string, url: URL, body: any): Response {
    const m = /\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/?]+))?/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const calendarId = decodeURIComponent(m[1]!);
    const eventId = m[2] ? decodeURIComponent(m[2]) : undefined;
    this.calls.push({ method, calendarId, eventId });

    const injected = this.failNext.shift();
    if (injected) return new Response(JSON.stringify({ error: { code: injected } }), { status: injected });
    if (this.forbidden.has(calendarId)) return new Response(JSON.stringify({ error: { code: 403, message: "Forbidden" } }), { status: 403 });

    if (method === "PUT" && eventId) {
      const key = `${calendarId}|${eventId}`;
      if (!this.events.has(key)) return new Response("{}", { status: 404 });
      this.events.set(key, { calendarId, body, status: "confirmed" });
      return Response.json(body);
    }
    if (method === "POST" && !eventId) {
      const key = `${calendarId}|${body.id}`;
      if (this.events.has(key)) return new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 });
      this.events.set(key, { calendarId, body, status: "confirmed" });
      return Response.json(body);
    }
    if (method === "DELETE" && eventId) {
      const e = this.events.get(`${calendarId}|${eventId}`);
      if (!e) return new Response("", { status: 404 });
      if (e.status === "cancelled") return new Response("", { status: 410 });
      e.status = "cancelled"; // Google keeps cancelled events; the ID cannot be re-inserted, only updated
      return new Response(null, { status: 204 });
    }
    return new Response("bad request", { status: 400 });
  }
}

export class FakeJobber {
  visits = new Map<string, JobberVisit>();
  graphqlCalls: { query: string; variables: any; auth: string }[] = [];
  tokenCalls: Record<string, string>[] = [];
  validAccessToken = "jobber-access-1";
  validRefreshToken = "jobber-refresh-1";
  private rotation = 1;
  /** Inject GraphQL-level responses (consumed in order). */
  injectGraphQL: Array<() => Response> = [];

  handleToken(params: URLSearchParams): Response {
    const p = Object.fromEntries(params);
    this.tokenCalls.push(p);
    if (p.grant_type === "refresh_token") {
      if (p.refresh_token !== this.validRefreshToken) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "The provided refresh token is not valid." }), { status: 400 });
      }
      this.rotation += 1;
      this.validAccessToken = `jobber-access-${this.rotation}`;
      this.validRefreshToken = `jobber-refresh-${this.rotation}`; // rotation: old token now invalid
      return Response.json({ access_token: this.validAccessToken, refresh_token: this.validRefreshToken, token_type: "Bearer", expires_in: 3600 });
    }
    if (p.grant_type === "authorization_code") {
      return Response.json({ access_token: this.validAccessToken, refresh_token: this.validRefreshToken, token_type: "Bearer", expires_in: 3600 });
    }
    return new Response("{}", { status: 400 });
  }

  handleGraphQL(auth: string, body: { query: string; variables: any }): Response {
    this.graphqlCalls.push({ query: body.query, variables: body.variables, auth });
    if (auth !== `Bearer ${this.validAccessToken}`) return new Response(JSON.stringify({ message: "Invalid Token Error" }), { status: 401 });
    const injected = this.injectGraphQL.shift();
    if (injected) return injected();
    if (body.query.includes("VisitForCalendar")) {
      return Response.json({ data: { visit: this.visits.get(body.variables.id) ?? null } });
    }
    if (body.query.includes("JobVisits")) {
      const nodes = [...this.visits.values()].filter((v) => v.job?.id === body.variables.id).map((v) => ({ id: v.id }));
      const job = nodes.length || body.variables.id ? { id: body.variables.id, visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } : null;
      return Response.json({ data: { job } });
    }
    if (body.query.includes("GetAccount")) return Response.json({ data: { account: { id: ACCOUNT_ID, name: "Test Co" } } });
    if (body.query.includes("JobberUsers")) {
      return Response.json({ data: { users: { nodes: [{ id: USER_ANA, name: { full: "Ana" } }, { id: USER_BEN, name: { full: "Ben" } }] } } });
    }
    return Response.json({ errors: [{ message: "unknown query" }] });
  }
}

export function makeVisit(n: number, overrides: Partial<JobberVisit> = {}): JobberVisit {
  return {
    __typename: "Visit",
    id: gid("Visit", n),
    title: `Visit ${n}`,
    startAt: "2026-10-20T14:00:00Z",
    endAt: "2026-10-20T16:00:00Z",
    allDay: false,
    instructions: "Gate code 1234",
    visitStatus: "UPCOMING",
    isComplete: false,
    job: { __typename: "Job", id: gid("Job", 500 + n), jobNumber: 500 + n, title: "Furnace tune-up", jobberWebUri: `https://secure.getjobber.com/work_orders/${500 + n}` },
    client: { id: gid("Client", 9), name: "Jane Client" },
    property: { id: gid("Property", 7), address: { street1: "1 Main St", street2: null, city: "Raleigh", province: "NC", postalCode: "27601", country: "US" } },
    assignedUsers: { nodes: [{ id: USER_ANA, name: { full: "Ana" } }] },
    ...overrides,
  };
}

export class FakeQueue {
  sent: SyncMessage[] = [];
  async send(m: SyncMessage) {
    this.sent.push(m);
  }
}

export interface TestHarness {
  env: Env;
  jobber: FakeJobber;
  google: FakeGoogle;
  queue: FakeQueue;
}

export async function setup(opts: { accessExpiresInMs?: number } = {}): Promise<TestHarness> {
  retryConfig.baseDelayMs = 1;
  resetGoogleTokenCache();
  const jobber = new FakeJobber();
  const google = new FakeGoogle();
  const queue = new FakeQueue();
  const env: Env = {
    DB: createTestD1(),
    SYNC_QUEUE: queue as unknown as Queue<SyncMessage>,
    JOBBER_API_VERSION: "2026-09-25",
    JOBBER_REDIRECT_URI: "https://worker.test/oauth/jobber/callback",
    GOOGLE_AUTH_MODE: "oauth",
    DEFAULT_TIMEZONE: "America/New_York",
    ALLOWED_TOPICS: undefined,
    EVENT_TITLE_PREFIX: "",
    JOBBER_CLIENT_ID: "client-id",
    JOBBER_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    ADMIN_API_TOKEN: "admin-secret",
    GOOGLE_OAUTH_CLIENT_ID: "g-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "g-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "g-refresh",
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    if (url.host === "api.getjobber.com" && url.pathname === "/api/oauth/token") return jobber.handleToken(new URLSearchParams(rawBody));
    if (url.host === "api.getjobber.com" && url.pathname === "/api/graphql") return jobber.handleGraphQL(headers.get("authorization") ?? "", JSON.parse(rawBody));
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "google-access", expires_in: 3600 });
    if (url.host === "www.googleapis.com") return google.handle(method, url, rawBody ? JSON.parse(rawBody) : undefined);
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });

  // Connected Jobber account + two mapped team members.
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO jobber_accounts (account_id, account_name, access_token_enc, refresh_token_enc, access_expires_at, status, connected_at, updated_at)
     VALUES (?, 'Test Co', ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      ACCOUNT_ID,
      await encryptString(env.TOKEN_ENCRYPTION_KEY, jobber.validAccessToken),
      await encryptString(env.TOKEN_ENCRYPTION_KEY, jobber.validRefreshToken),
      now + (opts.accessExpiresInMs ?? 3600_000),
      now,
      now,
    )
    .run();
  for (const [user, cal, label] of [
    [USER_ANA, CAL_ANA, "Ana (estimator)"],
    [USER_BEN, CAL_BEN, "Ben (estimator)"],
  ]) {
    await env.DB.prepare("INSERT INTO user_calendar_map (account_id, jobber_user_id, google_calendar_id, label, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)")
      .bind(ACCOUNT_ID, user, cal, label, now)
      .run();
  }
  return { env, jobber, google, queue };
}

export function webhookBody(topic: string, itemId: string, opts: { legacyTimestamp?: boolean } = {}) {
  const ts = opts.legacyTimestamp ? "occuredAt" : "occurredAt";
  return JSON.stringify({ data: { webHookEvent: { topic, appId: "app-1", accountId: ACCOUNT_ID, itemId, [ts]: "2026-10-13T10:00:00-05:00" } } });
}

export async function signedWebhook(body: string, secret = CLIENT_SECRET): Promise<Request> {
  return new Request("https://worker.test/webhooks/jobber", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Jobber-Hmac-SHA256": await hmacSha256Base64(secret, body) },
    body,
  });
}

/** Builds a fake MessageBatch and records what the consumer did with each message. */
export function batchOf(messages: SyncMessage[], attempts = 1) {
  const outcomes: { ack: number; retry: { delaySeconds?: number }[] }[] = messages.map(() => ({ ack: 0, retry: [] }));
  const batch = {
    queue: "jobber-visit-sync",
    messages: messages.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts,
      body,
      ack: () => void outcomes[i]!.ack++,
      retry: (o?: { delaySeconds?: number }) => void outcomes[i]!.retry.push(o ?? {}),
    })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<SyncMessage>;
  return { batch, outcomes };
}

export const msg = (topic: string, itemId: string): SyncMessage => ({ topic, accountId: ACCOUNT_ID, itemId, receivedAt: Date.now() });
