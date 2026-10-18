# Jobber → Google Calendar Sync — Operations & Troubleshooting

## Day-to-day tasks

### Add a new estimator
1. In Jobber, add them as a team member (Settings → Manage Team).
2. They share their Google Calendar with `<SA_EMAIL>` using **Make changes (see private events as free/busy)**.
3. `<WORKER_URL>/admin` → enter the admin token → type their Calendar ID next to their name → **Save mappings**.
4. Connect the same calendar in Routemize.

Their visits sync from the next change onward. To backfill an existing visit, edit it in Jobber (any save fires a webhook).

### Remove or pause an estimator
On `/admin`, clear their Calendar ID and save. Events already on their calendar stay until each visit changes or is deleted. Then remove the calendar share.

### Move an estimator to a new calendar
Change the Calendar ID on `/admin`. On each visit's next change, the event moves from the old calendar to the new one.

### Where to look
| Need | Place |
|---|---|
| Recent syncs per visit (created/updated/deleted/skipped/error) | `<WORKER_URL>/admin` → Recent activity, or D1 `sync_log` |
| Full request/queue logs with error text | Cloudflare → Worker → **Observability → Events** |
| Failed messages after 8 retries | Queue `jobber-visit-sync-dlq` |
| Which calendar/event a visit maps to | D1 `visit_events` (or JSON `GET /admin/visits?accountId=…&visitId=…` with `Authorization: Bearer <ADMIN_API_TOKEN>`) |
| Re-run one visit | JSON `POST /admin/resync {"accountId","visitId"}` with the bearer token, or just edit the visit in Jobber |

### Useful D1 queries
```sql
-- Last 20 sync actions
SELECT datetime(at/1000,'unixepoch') AS utc, topic, action, detail FROM sync_log ORDER BY id DESC LIMIT 20;
-- Connection health
SELECT account_name, status, datetime(access_expires_at/1000,'unixepoch') AS token_expires FROM jobber_accounts;
-- Mappings
SELECT label, jobber_user_id, google_calendar_id, active FROM user_calendar_map;
```

---

## Troubleshooting (every row was hit or prevented during the reference build)

| Symptom | Cause | Fix |
|---|---|---|
| `/oauth/jobber/start?key=…` says **unauthorized** | The placeholder was left in the link, or the token has `# & + $` characters that break inside URLs | Open `/oauth/jobber/start` with no `?key` and type the token into the password box |
| Log: **`Invalid PKCS8 input`**; diagnostic shows `base64Length: 64`, `hasBeginMarker: false` | The multi-line PEM was pasted into the single-line secret field, so only the first line was kept | Re-paste `GOOGLE_SA_PRIVATE_KEY` using the one-line `"private_key": "…\n…"` text from the JSON file. Queued visits sync automatically once fixed |
| Log: `TOKEN_ENCRYPTION_KEY must be 32 bytes` (old builds) | A passphrase was used instead of 32-byte base64 | Current code accepts any passphrase. Make sure it's type **Secret** |
| Dashboard variables disappear after a GitHub push | Wrangler replaces variables not in `wrangler.toml` | `keep_vars = true` (already set); put non-secret values in `wrangler.toml` |
| Cloudflare "Import repository" doesn't list the repo | The Cloudflare account is linked to a different GitHub account | **Add GitHub account** → authorize for the repo owner (human finishes the pop-up) |
| Agent can't push: "repository not found / no access" | The Claude GitHub app isn't installed on that private repo | Install the Claude app → *Only select repositories* → the repo |
| Jobber webhook topic saved as `APP_CONNECT` | Pressed Enter in the type-ahead | Click the option instead; read back all rows before saving |
| Nothing in `sync_log` and no "webhook queued" in logs | Webhooks not reaching the Worker: wrong URL, app not saved, or account not connected | Check the Jobber app's webhook URLs = `<WORKER_URL>/webhooks/jobber`; `jobber_accounts.status = active` |
| Log: `Rejected webhook: invalid or missing signature` | `JOBBER_CLIENT_SECRET` doesn't match the app (or the secret was regenerated) | Re-paste the secret from the Jobber app |
| `sync_log`: `No calendar mapping for Jobber user …` | The assignee isn't mapped | Map them on `/admin` |
| Error: Google Calendar **403/404** on a calendar ID | That calendar isn't shared with `<SA_EMAIL>`, or the ID is wrong | Share with "Make changes…"; check the Calendar ID under Settings → Integrate calendar |
| `jobber_accounts.status = reauth_required` | Refresh token invalid (app disconnected, secret regenerated, scopes changed) | Re-run `/oauth/jobber/start` |
| Two identical events on one calendar | Two assignees are mapped to the **same** calendar (normal in testing) | Map each person to their own calendar |
| All-day visit on the wrong date | `DEFAULT_TIMEZONE` doesn't match the business | Set it in `wrangler.toml` and push |
| `Jobber API version warning` in logs | The pinned `JOBBER_API_VERSION` is nearing end of support | Check developer.getjobber.com/docs/changelog, bump the version, push |

---

## Behaviour reference

- **Idempotent:** the event ID is derived from (account, visit, user). Repeated or duplicate webhooks never create duplicates. An unchanged visit causes zero Google writes (`noop`).
- **Deletes survive the visit being gone:** the visit→event mapping is stored before the event is created.
- **Retries:** network errors, 429 and 5xx are retried inline, then by the queue with backoff (15 s → 15 min, 8 attempts), then sent to the DLQ. Config errors that won't fix themselves (calendar not shared) are logged and not retried. A bad Google key **is** retried, so visits sync once the key is fixed.
- **Token safety:** Jobber refresh-token rotation is handled with a single-refresher lock. Tokens are AES-GCM encrypted in D1 and never logged.
- **Events:** busy (opaque), no reminders, no invitation emails. Title = Jobber visit title (Jobber defaults it to "Client - Job title"). Location = full property address. Description = client, job #, instructions, Jobber link.

## Verified live in the reference build (Oct 17, 2026)
- Webhook received → HMAC verified → queued → Jobber GraphQL fetch → Google event created on the mapped calendar, with correct time and address
- Duplicate follow-up webhook recognized (`noop`)
- Reschedule, reassign, unschedule, delete and Request/Quote filtering are covered by the automated test suite (64 tests); run the Phase 9 table on each new install.
