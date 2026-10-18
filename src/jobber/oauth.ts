import type { Env } from "../env";
import * as repo from "../db/repo";
import { pkceChallenge, randomToken } from "../util/crypto";
import { JOBBER_AUTHORIZE_URL, postTokenEndpoint, storeTokens, type JobberTokenResponse } from "./tokens";
import { ACCOUNT_QUERY, jobberGraphQL } from "./graphql";
import { log, snippet } from "../log";

const STATE_TTL_MS = 10 * 60 * 1000; // authorization codes also expire after 10 minutes

/** GET /oauth/jobber/start — redirects a Jobber admin to the consent screen (PKCE S256 + state). */
export async function startJobberOAuth(env: Env): Promise<Response> {
  const state = randomToken(24);
  const verifier = randomToken(48); // 64 unreserved chars (43–128 required)
  await repo.saveOAuthState(env.DB, state, verifier, Date.now());

  const url = new URL(JOBBER_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.JOBBER_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.JOBBER_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(url.toString(), 302);
}

/** GET /oauth/jobber/callback?code=…&state=… — exchanges the code, stores tokens keyed by Jobber account.id. */
export async function handleJobberCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html(400, "Missing code or state. Start again from /oauth/jobber/start.");

  const saved = await repo.consumeOAuthState(env.DB, state);
  if (!saved || Date.now() - saved.created_at > STATE_TTL_MS) {
    return html(400, "This authorization link is invalid or expired. Start again from /oauth/jobber/start.");
  }

  const res = await postTokenEndpoint(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.JOBBER_REDIRECT_URI,
    code_verifier: saved.code_verifier,
  });
  const text = await res.text();
  if (!res.ok) {
    log("error", "Jobber code exchange failed", { status: res.status, response: snippet(text, 200) });
    return html(502, "Jobber rejected the authorization code. Start again from /oauth/jobber/start.");
  }
  const tokens = JSON.parse(text) as JobberTokenResponse;

  // Recommended by Jobber: identify the account the tokens belong to.
  const data = await jobberGraphQL<{ account: { id: string; name: string } }>(env, "", ACCOUNT_QUERY, {}, tokens.access_token);
  await storeTokens(env, data.account.id, data.account.name, tokens);
  log("info", "Jobber account connected", { accountId: data.account.id, accountName: data.account.name });

  return html(
    200,
    `Connected Jobber account <b>${escapeHtml(data.account.name)}</b>.<br>Account ID: <code>${escapeHtml(data.account.id)}</code><br>Next: <a href="/admin">map team members to their Google Calendars</a>.`,
  );
}

function html(status: number, body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Jobber connection</title><body style="font-family:system-ui;padding:2rem;max-width:40rem">${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
