/** All D1 access lives here. */

export interface AccountRow {
  account_id: string;
  account_name: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: number;
  refresh_lock_until: number | null;
  status: "active" | "reauth_required" | "disconnected";
  connected_at: number;
  updated_at: number;
}

export interface VisitEventRow {
  account_id: string;
  visit_id: string;
  jobber_user_id: string;
  job_id: string;
  google_calendar_id: string;
  google_event_id: string;
  content_hash: string | null;
  last_synced_at: number;
}

export interface MappingRow {
  account_id: string;
  jobber_user_id: string;
  google_calendar_id: string;
  label: string | null;
  active: number;
  updated_at: number;
}

// ---- accounts / tokens ----------------------------------------------------------------------

export async function getAccount(db: D1Database, accountId: string): Promise<AccountRow | null> {
  return db.prepare("SELECT * FROM jobber_accounts WHERE account_id = ?").bind(accountId).first<AccountRow>();
}

export async function listAccounts(db: D1Database): Promise<Omit<AccountRow, "access_token_enc" | "refresh_token_enc">[]> {
  const { results } = await db
    .prepare(
      "SELECT account_id, account_name, access_expires_at, refresh_lock_until, status, connected_at, updated_at FROM jobber_accounts ORDER BY connected_at",
    )
    .all<Omit<AccountRow, "access_token_enc" | "refresh_token_enc">>();
  return results;
}

export async function upsertAccountTokens(
  db: D1Database,
  a: { accountId: string; accountName: string | null; accessEnc: string; refreshEnc: string; expiresAt: number; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobber_accounts (account_id, account_name, access_token_enc, refresh_token_enc, access_expires_at, refresh_lock_until, status, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         account_name = COALESCE(excluded.account_name, jobber_accounts.account_name),
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         access_expires_at = excluded.access_expires_at,
         refresh_lock_until = NULL,
         status = 'active',
         updated_at = excluded.updated_at`,
    )
    .bind(a.accountId, a.accountName, a.accessEnc, a.refreshEnc, a.expiresAt, a.now, a.now)
    .run();
}

/** Atomically claims the refresh lock. Returns true if this caller may refresh. */
export async function claimRefreshLock(db: D1Database, accountId: string, now: number, ttlMs: number): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE jobber_accounts SET refresh_lock_until = ? WHERE account_id = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)",
    )
    .bind(now + ttlMs, accountId, now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseRefreshLock(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("UPDATE jobber_accounts SET refresh_lock_until = NULL WHERE account_id = ?").bind(accountId).run();
}

export async function setAccountStatus(db: D1Database, accountId: string, status: AccountRow["status"], now: number) {
  await db
    .prepare("UPDATE jobber_accounts SET status = ?, refresh_lock_until = NULL, updated_at = ? WHERE account_id = ?")
    .bind(status, now, accountId)
    .run();
}

// ---- oauth state ----------------------------------------------------------------------------

export async function saveOAuthState(db: D1Database, state: string, verifier: string, now: number) {
  await db.prepare("INSERT INTO oauth_states (state, code_verifier, created_at) VALUES (?, ?, ?)").bind(state, verifier, now).run();
}

/** Single-use: reads and deletes. */
export async function consumeOAuthState(db: D1Database, state: string): Promise<{ code_verifier: string; created_at: number } | null> {
  const row = await db
    .prepare("SELECT code_verifier, created_at FROM oauth_states WHERE state = ?")
    .bind(state)
    .first<{ code_verifier: string; created_at: number }>();
  if (row) await db.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  return row;
}

// ---- team-member mapping --------------------------------------------------------------------

export async function getCalendarsForUsers(db: D1Database, accountId: string, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const placeholders = userIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT jobber_user_id, google_calendar_id FROM user_calendar_map WHERE account_id = ? AND active = 1 AND jobber_user_id IN (${placeholders})`,
    )
    .bind(accountId, ...userIds)
    .all<{ jobber_user_id: string; google_calendar_id: string }>();
  for (const r of results) map.set(r.jobber_user_id, r.google_calendar_id);
  return map;
}

export async function listMappings(db: D1Database, accountId?: string): Promise<MappingRow[]> {
  const stmt = accountId
    ? db.prepare("SELECT * FROM user_calendar_map WHERE account_id = ? ORDER BY label").bind(accountId)
    : db.prepare("SELECT * FROM user_calendar_map ORDER BY account_id, label");
  return (await stmt.all<MappingRow>()).results;
}

export async function upsertMapping(
  db: D1Database,
  m: { accountId: string; jobberUserId: string; googleCalendarId: string; label?: string | null; active?: boolean; now: number },
) {
  await db
    .prepare(
      `INSERT INTO user_calendar_map (account_id, jobber_user_id, google_calendar_id, label, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, jobber_user_id) DO UPDATE SET
         google_calendar_id = excluded.google_calendar_id, label = excluded.label,
         active = excluded.active, updated_at = excluded.updated_at`,
    )
    .bind(m.accountId, m.jobberUserId, m.googleCalendarId, m.label ?? null, m.active === false ? 0 : 1, m.now)
    .run();
}

export async function deleteMapping(db: D1Database, accountId: string, jobberUserId: string) {
  await db.prepare("DELETE FROM user_calendar_map WHERE account_id = ? AND jobber_user_id = ?").bind(accountId, jobberUserId).run();
}

// ---- visit -> event mapping -----------------------------------------------------------------

export async function listVisitEvents(db: D1Database, accountId: string, visitId: string): Promise<VisitEventRow[]> {
  return (
    await db
      .prepare("SELECT * FROM visit_events WHERE account_id = ? AND visit_id = ?")
      .bind(accountId, visitId)
      .all<VisitEventRow>()
  ).results;
}

export async function listVisitIdsForJob(db: D1Database, accountId: string, jobId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT visit_id FROM visit_events WHERE account_id = ? AND job_id = ?")
    .bind(accountId, jobId)
    .all<{ visit_id: string }>();
  return results.map((r) => r.visit_id);
}

/** Written before the Google call (content_hash NULL) and again after it succeeds (with the hash). */
export async function upsertVisitEvent(db: D1Database, r: VisitEventRow) {
  await db
    .prepare(
      `INSERT INTO visit_events (account_id, visit_id, jobber_user_id, job_id, google_calendar_id, google_event_id, content_hash, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, visit_id, jobber_user_id) DO UPDATE SET
         job_id = excluded.job_id, google_calendar_id = excluded.google_calendar_id,
         google_event_id = excluded.google_event_id, content_hash = excluded.content_hash,
         last_synced_at = excluded.last_synced_at`,
    )
    .bind(r.account_id, r.visit_id, r.jobber_user_id, r.job_id, r.google_calendar_id, r.google_event_id, r.content_hash, r.last_synced_at)
    .run();
}

export async function deleteVisitEvent(db: D1Database, accountId: string, visitId: string, jobberUserId: string) {
  await db
    .prepare("DELETE FROM visit_events WHERE account_id = ? AND visit_id = ? AND jobber_user_id = ?")
    .bind(accountId, visitId, jobberUserId)
    .run();
}

// ---- audit log ------------------------------------------------------------------------------

export async function writeSyncLog(
  db: D1Database,
  e: { at: number; topic?: string; accountId?: string; itemId?: string; jobId?: string; action: string; detail?: unknown },
) {
  try {
    await db
      .prepare("INSERT INTO sync_log (at, topic, account_id, item_id, job_id, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(
        e.at,
        e.topic ?? null,
        e.accountId ?? null,
        e.itemId ?? null,
        e.jobId ?? null,
        e.action,
        e.detail === undefined ? null : typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail),
      )
      .run();
  } catch {
    // Audit logging must never break a sync.
  }
}

export async function recentSyncLog(db: D1Database, limit: number) {
  return (await db.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT ?").bind(limit).all()).results;
}

export async function prune(db: D1Database, now: number) {
  await db.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(now - 60 * 60 * 1000).run();
  await db.prepare("DELETE FROM sync_log WHERE at < ?").bind(now - 30 * 24 * 60 * 60 * 1000).run();
}
