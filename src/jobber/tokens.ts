import type { Env } from "../env";
import * as repo from "../db/repo";
import { decryptString, encryptString } from "../util/crypto";
import { fetchWithRetry, PermanentError, RetryableError } from "../util/retry";
import { log, snippet } from "../log";

export const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
export const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";

/** Refresh this long before expiry (access tokens live 60 minutes). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 30 * 1000;

export interface JobberTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  warning?: string;
}

/** Access tokens are JWTs with `exp`; fall back to expires_in, then to 60 minutes. */
export function accessTokenExpiry(t: JobberTokenResponse, now: number): number {
  try {
    const payload = JSON.parse(atob(t.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    /* not a decodable JWT */
  }
  return now + (t.expires_in ?? 3600) * 1000;
}

export async function storeTokens(env: Env, accountId: string, accountName: string | null, t: JobberTokenResponse): Promise<void> {
  const now = Date.now();
  await repo.upsertAccountTokens(env.DB, {
    accountId,
    accountName,
    accessEnc: await encryptString(env.TOKEN_ENCRYPTION_KEY, t.access_token),
    refreshEnc: await encryptString(env.TOKEN_ENCRYPTION_KEY, t.refresh_token),
    expiresAt: accessTokenExpiry(t, now),
    now,
  });
}

export async function postTokenEndpoint(env: Env, params: Record<string, string>): Promise<Response> {
  return fetchWithRetry(
    JOBBER_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: env.JOBBER_CLIENT_ID, client_secret: env.JOBBER_CLIENT_SECRET, ...params }).toString(),
    },
    { label: "jobber.oauth.token" },
  );
}

/**
 * Returns a valid access token for the account, refreshing when needed.
 *
 * Refresh Token Rotation is on by default and the previous refresh token is invalidated immediately,
 * so exactly one process may refresh at a time: we take a short D1 lock, refresh, and persist BOTH
 * new tokens before using the new access token (per Jobber's rotation guidance). Other callers wait
 * and re-read the stored tokens instead of refreshing themselves.
 */
export async function getJobberAccessToken(env: Env, accountId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await repo.getAccount(env.DB, accountId);
    if (!row) throw new PermanentError(`Jobber account ${accountId} is not connected`);
    if (row.status !== "active") throw new PermanentError(`Jobber account ${accountId} status is ${row.status}; re-authorize via /oauth/jobber/start`);

    const now = Date.now();
    const fresh = row.access_expires_at - REFRESH_SKEW_MS > now;
    if (fresh && !(opts.forceRefresh && attempt === 0)) {
      return decryptString(env.TOKEN_ENCRYPTION_KEY, row.access_token_enc);
    }

    if (await repo.claimRefreshLock(env.DB, accountId, now, LOCK_TTL_MS)) {
      try {
        return await refreshWithLock(env, row);
      } finally {
        await repo.releaseRefreshLock(env.DB, accountId);
      }
    }
    // Someone else is refreshing; wait then read what they stored.
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    opts = {};
  }
  throw new RetryableError(`Timed out waiting for Jobber token refresh for ${accountId}`);
}

async function refreshWithLock(env: Env, row: repo.AccountRow): Promise<string> {
  const refreshToken = await decryptString(env.TOKEN_ENCRYPTION_KEY, row.refresh_token_enc);
  const res = await postTokenEndpoint(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  const text = await res.text();

  if (res.status === 400 || res.status === 401) {
    // invalid_grant / "The provided refresh token is not valid." -> user must re-authorize.
    await repo.setAccountStatus(env.DB, row.account_id, "reauth_required", Date.now());
    log("error", "Jobber refresh token rejected; account needs re-authorization", {
      accountId: row.account_id,
      status: res.status,
      response: snippet(text, 200),
    });
    throw new PermanentError(`Jobber refresh token rejected for ${row.account_id}`);
  }
  if (!res.ok) throw new RetryableError(`Jobber token refresh failed: HTTP ${res.status}`);

  const tokens = JSON.parse(text) as JobberTokenResponse;
  if (tokens.warning) log("warn", "Jobber token endpoint warning", { accountId: row.account_id, warning: tokens.warning });
  if (!tokens.access_token || !tokens.refresh_token) throw new RetryableError("Jobber token refresh returned no tokens");

  // Persist both tokens before any further API call.
  await storeTokens(env, row.account_id, null, tokens);
  log("info", "Jobber access token refreshed", { accountId: row.account_id });
  return tokens.access_token;
}
