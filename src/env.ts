export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncMessage>;

  // --- vars (wrangler.toml) ---
  JOBBER_API_VERSION: string;
  JOBBER_REDIRECT_URI: string;
  GOOGLE_AUTH_MODE: "service_account" | "oauth";
  DEFAULT_TIMEZONE: string;
  ALLOWED_TOPICS?: string;
  EVENT_TITLE_PREFIX?: string;

  // --- secrets (wrangler secret put) ---
  JOBBER_CLIENT_ID: string;
  JOBBER_CLIENT_SECRET: string; // also the webhook HMAC key
  TOKEN_ENCRYPTION_KEY: string; // base64, 32 random bytes
  ADMIN_API_TOKEN: string;

  // Google: service account mode
  GOOGLE_SA_CLIENT_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string; // PEM (PKCS#8), "\n" escapes allowed
  GOOGLE_SA_SUBJECT?: string; // optional: Workspace domain-wide delegation user to impersonate

  // Google: OAuth (shared admin account) mode
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string;
}

/** Message placed on the queue by the webhook endpoint. Contains IDs only. */
export interface SyncMessage {
  topic: string;
  accountId: string;
  itemId: string;
  occurredAt?: string;
  receivedAt: number;
}
