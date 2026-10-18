import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ACCOUNT_ID, USER_ANA, setup } from "./helpers/fakes";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

const post = (path: string, fields: Record<string, string>) =>
  new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

describe("browser admin pages", () => {
  it("connect page shows a password form instead of 'unauthorized'", async () => {
    const h = await setup();
    const res = await worker.fetch(new Request("https://worker.test/oauth/jobber/start?key=YOUR_ADMIN_TOKEN"), h.env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('type="password"');
  });

  it("a token with special characters works through the form and redirects to Jobber", async () => {
    const h = await setup();
    h.env.ADMIN_API_TOKEN = "a#b&c+d$e%f";
    const bad = await worker.fetch(post("/oauth/jobber/start", { key: "wrong" }), h.env, ctx);
    expect(bad.status).toBe(401);
    const ok = await worker.fetch(post("/oauth/jobber/start", { key: "a#b&c+d$e%f" }), h.env, ctx);
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://api.getjobber.com/api/oauth/authorize");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("admin page lists Jobber users and saves a calendar mapping", async () => {
    const h = await setup();
    const page = await worker.fetch(post("/admin", { key: "admin-secret" }), h.env, ctx);
    const html = await page.text();
    expect(html).toContain("Ana");
    expect(html).toContain("ana@example.com");

    await worker.fetch(post("/admin", { key: "admin-secret", action: "save", accountId: ACCOUNT_ID, [`cal:${USER_ANA}`]: "new-cal@example.com", [`label:${USER_ANA}`]: "Ana" }), h.env, ctx);
    const row = await h.env.DB.prepare("SELECT google_calendar_id FROM user_calendar_map WHERE jobber_user_id = ?").bind(USER_ANA).first<{ google_calendar_id: string }>();
    expect(row!.google_calendar_id).toBe("new-cal@example.com");
  });

  it("admin page rejects a wrong token", async () => {
    const h = await setup();
    const res = await worker.fetch(post("/admin", { key: "nope" }), h.env, ctx);
    expect(res.status).toBe(401);
  });
});
