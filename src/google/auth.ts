import type { Env } from "../env";
import { b64decode, b64url } from "../util/crypto";
import { fetchWithRetry, PermanentError, RetryableError } from "../util/retry";
import { log, snippet } from "../log";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Minimum scope: read/write events only (no calendar list/ACL/settings access). */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

let cached: { token: string; expiresAt: number } | null = null;

export function resetGoogleTokenCache(): void {
  cached = null;
}

/** Access token for the Calendar API, cached in isolate memory until ~1 minute before expiry. */
export async function getGoogleAccessToken(env: Env): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const res =
    env.GOOGLE_AUTH_MODE === "oauth" ? await refreshOAuthToken(env) : await serviceAccountToken(env);
  const text = await res.text();
  if (res.status === 400 || res.status === 401) {
    log("error", "Google token request rejected", { status: res.status, response: snippet(text, 200) });
    throw new PermanentError("Google credentials rejected; check GOOGLE_* secrets");
  }
  if (!res.ok) throw new RetryableError(`Google token endpoint HTTP ${res.status}`);
  const json = JSON.parse(text) as { access_token: string; expires_in?: number };
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function refreshOAuthToken(env: Env): Promise<Response> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new PermanentError("GOOGLE_AUTH_MODE=oauth requires GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN");
  }
  return fetchWithRetry(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      }).toString(),
    },
    { label: "google.oauth.token" },
  );
}

async function serviceAccountToken(env: Env): Promise<Response> {
  if (!env.GOOGLE_SA_CLIENT_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) {
    throw new PermanentError("GOOGLE_AUTH_MODE=service_account requires GOOGLE_SA_CLIENT_EMAIL and GOOGLE_SA_PRIVATE_KEY");
  }
  const assertion = await buildServiceAccountJwt(env.GOOGLE_SA_CLIENT_EMAIL, env.GOOGLE_SA_PRIVATE_KEY, env.GOOGLE_SA_SUBJECT);
  return fetchWithRetry(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    },
    { label: "google.sa.token" },
  );
}

/** RS256-signed JWT bearer assertion (RFC 7523) for a Google service account. */
export async function buildServiceAccountJwt(clientEmail: string, privateKeyPem: string, subject?: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    iss: clientEmail,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  if (subject) claims.sub = subject;
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await importPkcs8(privateKeyPem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

/**
 * Accepts the private key however it was pasted into the dashboard:
 *  - the raw PEM, with real newlines or literal "\n" (or "\\n") escapes
 *  - the JSON string value including surrounding quotes and/or a trailing comma
 *  - the entire service-account JSON file
 * Returns only the base64 body between the BEGIN/END markers.
 */
export function normalizePrivateKey(input: string): string {
  let s = input.trim();
  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s) as { private_key?: string };
      if (parsed.private_key) s = parsed.private_key;
    } catch {
      /* not valid JSON; fall through */
    }
  }
  s = s.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "");
  const m = /-----BEGIN (?:RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/.exec(s);
  const body = m ? m[1]! : s;
  return body.replace(/[^A-Za-z0-9+/=]/g, "");
}

/** Non-secret shape info, safe to log, to diagnose a bad paste. */
export function describePrivateKey(input: string): Record<string, unknown> {
  const body = normalizePrivateKey(input);
  return {
    rawLength: input.length,
    hasBeginMarker: /BEGIN (RSA )?PRIVATE KEY/.test(input),
    hasEndMarker: /END (RSA )?PRIVATE KEY/.test(input),
    startsWithBrace: input.trim().startsWith("{"),
    startsWithQuote: input.trim().startsWith('"'),
    base64Length: body.length,
  };
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const body = normalizePrivateKey(pem);
  try {
    return await crypto.subtle.importKey("pkcs8", b64decode(body), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (err) {
    log("error", "GOOGLE_SA_PRIVATE_KEY could not be read — re-paste the private_key value from the JSON key file", describePrivateKey(pem));
    // Retryable on purpose: visits queued while the secret is wrong sync once it is fixed.
    throw new RetryableError(`GOOGLE_SA_PRIVATE_KEY is not a valid private key (${String(err)})`, 120);
  }
}
