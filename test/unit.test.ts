import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decryptString, encryptString, b64decode, pkceChallenge } from "../src/util/crypto";
import { buildServiceAccountJwt } from "../src/google/auth";
import { validateJobVisit } from "../src/sync/validate";
import { deterministicEventId } from "../src/sync/mapEvent";
import { decodeEncodedId } from "../src/jobber/ids";
import { gid, makeVisit } from "./helpers/fakes";

describe("crypto", () => {
  it("AES-GCM token encryption round-trips", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const enc = await encryptString(key, "secret-token");
    expect(enc).not.toContain("secret-token");
    expect(await decryptString(key, enc)).toBe("secret-token");
  });

  it("PKCE S256 = base64url(sha256(verifier)) without padding", async () => {
    const verifier = "dBjftJeZ4CVP-mJ92K1N7iBFykGJTvP6OGNz1k7dOzc";
    const challenge = await pkceChallenge(verifier);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toMatch(/[=+/]/);
  });

  it("service-account JWT is a valid RS256 signature", async () => {
    const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\\n${btoa(String.fromCharCode(...pkcs8))}\\n-----END PRIVATE KEY-----`; // escaped newlines, as pasted into a secret
    const jwt = await buildServiceAccountJwt("sync@proj.iam.gserviceaccount.com", pem, undefined, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(atob(c!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({ iss: "sync@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/calendar.events", aud: "https://oauth2.googleapis.com/token" });
    const sig = b64decode(s!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s!.length % 4)) % 4));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });
});

describe("validation and ids", () => {
  it("accepts a scheduled, assigned Job Visit", () => {
    expect(validateJobVisit(makeVisit(1)).ok).toBe(true);
  });
  it("rejects: missing, non-Visit, no job, unscheduled (either side), unassigned", () => {
    expect(validateJobVisit(null)).toMatchObject({ ok: false, reason: "not_found" });
    expect(validateJobVisit({ ...makeVisit(1), __typename: "Assessment" })).toMatchObject({ reason: "non_job_object" });
    expect(validateJobVisit({ ...makeVisit(1), job: null })).toMatchObject({ reason: "non_job_object", message: "Skipped non-job event" });
    expect(validateJobVisit({ ...makeVisit(1), id: gid("Request", 3) })).toMatchObject({ reason: "non_job_object" });
    expect(validateJobVisit(makeVisit(1, { endAt: null }))).toMatchObject({ reason: "unscheduled", message: "Skipped unscheduled job visit" });
    expect(validateJobVisit(makeVisit(1, { startAt: null }))).toMatchObject({ reason: "unscheduled" });
    expect(validateJobVisit(makeVisit(1, { assignedUsers: null }))).toMatchObject({ reason: "no_assigned_users" });
  });
  it("decodes Jobber EncodedIds", () => {
    expect(decodeEncodedId("Z2lkOi8vSm9iYmVyL0NsaWVudC8xMTkxOTUzNDA")).toEqual({ type: "Client", numericId: "119195340" });
    expect(decodeEncodedId("MQ==")).toBeNull();
  });
  it("event IDs are deterministic, Google-valid, and distinct per assignee", async () => {
    const a = await deterministicEventId("acct", "visit", "u1");
    expect(a).toBe(await deterministicEventId("acct", "visit", "u1"));
    expect(a).not.toBe(await deterministicEventId("acct", "visit", "u2"));
    expect(a).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});
