# Jobber Job Visits → Google Calendar (near real-time)

A Cloudflare Worker that mirrors **scheduled Jobber Job Visits** into each assigned team member's Google Calendar within seconds. It replaces Jobber's iCal subscription, which can take 12–24 hours to refresh. Routemize then reads those calendars as availability blocks.

```
Jobber webhook ──► Worker /webhooks/jobber ──► Cloudflare Queue ──► consumer
   (IDs only)       verify HMAC, 200 in ms        (retries, DLQ)       │
                                                                       ├─► Jobber GraphQL: visit(id) + parent job
                                                                       ├─► validate: scheduled Visit on a Job?
                                                                       └─► Google Calendar: upsert / move / delete
                                             D1: tokens (encrypted), user→calendar map, visit→event map, audit log
```

**Scope is Job Visits only.** Requests, Quotes/Estimates, Assessments, Tasks, Invoices and Clients never produce calendar events. They are rejected at three independent layers:

1. **Topic allow-list.** Only `VISIT_*`, `JOB_*` and `APP_DISCONNECT` are queued. Everything else gets a 200 and is logged as `Skipped non-job event`.
2. **ID type guard.** Jobber IDs decode to `gid://Jobber/<Type>/<n>`, and an ID that decodes to a non-Visit type is skipped.
3. **Validation before every Google write.** The object must be a `Visit`, attached to a `Job`, with both `startAt` and `endAt`, and at least one assigned user.

A Request or Quote that is later converted into a Job does not sync. Only the Job Visits that Jobber creates for it do.

---

## 1. What was confirmed in the Jobber docs (2026-10-13)

| Item | Confirmed value | Source |
|---|---|---|
| GraphQL endpoint | `POST https://api.getjobber.com/api/graphql`, `Content-Type: application/json` | Developer Center home |
| API version header | `X-JOBBER-GRAPHQL-VERSION` is **required**; latest active version is **`2026-09-25`** | Changelog, API Versioning |
| OAuth | Authorization-code grant at `https://api.getjobber.com/api/oauth/authorize`; token endpoint `https://api.getjobber.com/api/oauth/token` (form-encoded); PKCE S256 recommended | App Authorization |
| Token lifetimes | Access tokens are JWTs that expire after 60 minutes. Refresh tokens are long-lived. **Refresh Token Rotation is on by default** and the old refresh token is invalidated immediately, so both new tokens must be stored before any other call. | App Authorization, Refresh Token Rotation |
| Scopes | Chosen per app in the Developer Center, not per request. Webhooks need the matching **read** scope for the object. | Setting up Webhooks |
| Webhook payload | `{"data":{"webHookEvent":{"topic","appId","accountId","itemId","occurredAt"}}}`. Apps created before 2023-12-08 use `occuredAt`. IDs only, no object data. | Setting up Webhooks |
| Signature | Header `X-Jobber-Hmac-SHA256` = **base64(HMAC-SHA256(app OAuth client secret, raw body))** | Setting up Webhooks |
| Delivery | Respond within **1 second**. At-least-once delivery. One action can fire the same topic several times about 1 s apart. | Setting up Webhooks |
| Visit → Job | `Visit.job: Job!` (non-null). `Visit.startAt`/`endAt` are both `null` for an unscheduled visit. `Visit.assignedUsers: UserConnection`. `Job.jobberWebUri: String!` | Schema overview |
| Request/Assessment are separate types | `Assessment.request: Request!`. Assessments belong to Requests, not Jobs. | Schema overview |
| Rate limits | 10,000-point cost bucket restoring at 500/s per app+account; 2,500 req / 5 min; throttling returns `errors[].extensions.code = "THROTTLED"` | API Rate Limits |

**Not published in the public docs:** the exact webhook topic names. The docs say they are listed in the Developer Center and in `WebHookTopicEnum`, following `OBJECT_ACTION`. The Worker defaults to `VISIT_CREATE`, `VISIT_UPDATE`, `VISIT_COMPLETE`, `VISIT_DESTROY`, `JOB_UPDATE`, `JOB_DESTROY` and `APP_DISCONNECT`.

**Before go-live:**
- Run `graphql/introspect-webhook-topics.graphql` in GraphiQL.
- If any name differs (for example `VISIT_DELETE`), set `ALLOWED_TOPICS` in `wrangler.toml`. No code change is needed, because classification is by the `VISIT_`/`JOB_` prefix plus the `DESTROY`/`DELETE` suffix.

The same file confirms the `visit(id:)` root field, the `PropertyAddress` fields and `Name.full`.

---

## 2. Folder structure

```
jobber-gcal-sync/
├── wrangler.toml                  # bindings: D1, Queue (+DLQ), cron, vars
├── migrations/0001_init.sql       # D1 schema
├── graphql/
│   ├── visit-for-calendar.graphql # the exact Visit + Job query
│   └── introspect-webhook-topics.graphql
├── scripts/sign-webhook.mjs       # send a signed fake webhook for local/E2E testing
├── src/
│   ├── index.ts                   # router, webhook endpoint, queue consumer, cron
│   ├── env.ts                     # Env + queue message types
│   ├── config.ts                  # topic allow-list + classification
│   ├── admin.ts                   # mapping/admin API
│   ├── log.ts                     # structured JSON logs with secret redaction
│   ├── db/repo.ts                 # all D1 queries
│   ├── jobber/
│   │   ├── webhook.ts             # HMAC verification + payload parsing
│   │   ├── oauth.ts               # /oauth/jobber/start + callback (PKCE + state)
│   │   ├── tokens.ts              # encrypted storage + rotation-safe refresh
│   │   ├── graphql.ts             # client (401 refresh, THROTTLED, versioning) + queries
│   │   └── ids.ts                 # EncodedId decoding
│   ├── google/
│   │   ├── auth.ts                # service account JWT or OAuth refresh token
│   │   └── calendar.ts            # idempotent upsert + delete
│   ├── sync/
│   │   ├── validate.ts            # "is this a scheduled Visit on a Job?"
│   │   ├── mapEvent.ts            # Visit → Google event, deterministic IDs
│   │   └── processor.ts           # create / update / reassign / delete logic
│   └── util/{crypto,retry}.ts
└── test/                          # vitest: fakes for Jobber + Google, real SQL schema
```

---

## 3. How sync works

**Webhook (`POST /webhooks/jobber`).** The Worker reads the raw body, verifies `X-Jobber-Hmac-SHA256` with a constant-time compare, and parses the payload.
- Non-allow-listed topics get a 200 and are logged.
- Allowed topics are enqueued with IDs only, followed by a 200.
- No Jobber or Google calls happen in the request, so the response stays far under 1 second.

**Consumer.** The queue consumer runs with `max_concurrency = 1` and handles each message as follows.

| Topic | Action |
|---|---|
| `VISIT_CREATE` / `VISIT_UPDATE` / `VISIT_COMPLETE` | Fetch the visit fresh from Jobber, then validate it. On success, make Google match the current state. On failure, log the reason and remove any events previously created for it (unscheduled, unassigned or gone). |
| `VISIT_DESTROY` | Delete every event recorded in `visit_events` for that visit. No Jobber lookup is needed. |
| `JOB_UPDATE` | Re-sync every tracked visit of that job, because job title, address or instruction edits may not fire per-visit webhooks. |
| `JOB_DESTROY` | Delete every tracked visit of that job. |
| `APP_DISCONNECT` | Mark the account `disconnected`. |

Because each sync reads current state rather than trusting event order, out-of-order and duplicate deliveries converge to the right result.

**Idempotency.** Each Google event ID is deterministic: `jv` followed by the first 40 hex characters of `sha256(accountId|visitId|jobberUserId)`. That ID is valid base32hex for Google.
- The upsert first tries `PUT` (update).
- If that returns 404, it `POST`s (insert) with the same ID.
- If the insert returns 409, it `PUT`s again.

A `PUT` also revives an event Google keeps as "cancelled" after a delete, so reassigning a visit back to someone works. A content hash per calendar row makes a duplicate webhook a no-op with zero Google writes.

**Delete safety.** The `visit_events` row is written **before** each Google create, and again after it succeeds (with the hash). A later `VISIT_DESTROY` can therefore always find the event, even though Jobber no longer returns the visit.

**Reassignment.** The Worker compares the desired assignee → calendar map with the stored rows.
- Rows whose user was unassigned, or whose calendar mapping changed, are deleted from the old calendar first.
- Then each current assignee's event is upserted.
- With multiple assignees, each gets their own event (one per calendar).

**Event fields.**
- `summary`: visit title, falling back to job title, then `Job #N`, with an optional `EVENT_TITLE_PREFIX`.
- `start`/`end`: `startAt`/`endAt`. All-day visits become date events with an exclusive end, computed in `DEFAULT_TIMEZONE`.
- `location`: full property address.
- `description`: client name, job number and title, instructions, and the Jobber link.
- `transparency: opaque`, so the event shows as busy and blocks Routemize availability.
- `reminders` are off and `sendUpdates=none`, so nobody gets emails.
- `extendedProperties.private`: `{source, jobberAccountId, jobberVisitId, jobberJobId, jobberUserId, jobberVisitStatus}`.

Completed visits stay on the calendar, since the time was spent.

---

## 4. D1 schema and team-member mapping

See `migrations/0001_init.sql`:

- **`jobber_accounts`**: one row per connected Jobber account. Access and refresh tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. `refresh_lock_until` is a single-refresher lock. `status` is `active`, `reauth_required` or `disconnected`.
- **`oauth_states`**: single-use OAuth state plus PKCE verifier (10-minute TTL).
- **`user_calendar_map`**: **Jobber `User.id` → Google Calendar ID**, keyed by platform IDs only. `label` is a human note and is never used for matching. Set `active = 0` to pause a person without deleting the row.
- **`visit_events`**: (account, visit, user) → (job, calendar, Google event ID, content hash).
- **`sync_log`**: audit trail of created, updated, deleted, noop, skipped and error actions, pruned after 30 days by the cron.

**Mapping strategy.** After connecting Jobber, call `GET /admin/jobber/users?accountId=…`. It lists every Jobber user with their `id` and current mapping. Then `PUT` one mapping per estimator or tech:

```bash
curl -X PUT https://<worker>/admin/mappings \
  -H "authorization: Bearer $ADMIN_API_TOKEN" -H "content-type: application/json" \
  -d '{"accountId":"<Jobber account id>","jobberUserId":"<User.id>","googleCalendarId":"estimator@company.com","label":"Ana – estimator"}'
```

- Users without a mapping are skipped and logged with `No calendar mapping for Jobber user …`.
- Changing a user's calendar moves their existing events on the next update of each visit. To move them right away, trigger `POST /admin/resync`.

---

## 5. Jobber setup

1. Open the Jobber Developer Center → **Apps** → **New app**, and create a custom integration for your own account.
2. Set the **OAuth Callback URL** to `https://<your-worker>.workers.dev/oauth/jobber/callback`. It must match `JOBBER_REDIRECT_URI` exactly.
3. Select **Scopes** with the least privilege that works: **read access for Jobs** (covers visits), **Clients** (client name and property address) and **Users** (assigned users and the mapping helper). No write scopes are needed.
   - Scope labels are only shown in the Developer Center UI.
   - If a field returns "hidden due to permissions" in testing, add the read scope it names.
   - Changing scopes later requires re-authorizing.
4. Leave **Refresh Token Rotation on**. The Worker is built for it.
5. Under **Webhooks**, add each topic with URL `https://<your-worker>.workers.dev/webhooks/jobber`:
   - `VISIT_CREATE`, `VISIT_UPDATE`, `VISIT_COMPLETE`, `VISIT_DESTROY`
   - `JOB_UPDATE`, `JOB_DESTROY`
   - `APP_DISCONNECT`
   - Do **not** subscribe to `REQUEST_*`, `QUOTE_*`, `ASSESSMENT_*` or `INVOICE_*`. They would be ignored anyway, but subscribing wastes volume.
6. Copy the **Client ID** and **Client secret** into Worker secrets. The client secret also signs the webhooks.
7. After deploying, open `https://<worker>/oauth/jobber/start?key=<ADMIN_API_TOKEN>` as a Jobber **admin** user and click **Allow Access**. The success page shows the Jobber **account ID**, which you need for mappings.

---

## 6. Google setup — which auth to use

**Recommendation for multi-user production: a service account, with each team calendar shared to it.**

- No person's Google login or refresh token is involved. If an admin leaves or changes their password, sync keeps running.
- Access is per calendar, explicit and revocable. Each estimator (or a Workspace admin) shares one calendar with "Make changes to events". Nothing else is exposed.
- It works with both Gmail and Google Workspace calendars, and the calendar the Routemize estimator already connects is the same one.
- The only scope requested is `https://www.googleapis.com/auth/calendar.events`.

The shared admin OAuth account option (`GOOGLE_AUTH_MODE=oauth`) works, but ties production to one person's account and refresh token. It only fits if every calendar is already shared with that admin and you cannot create a service account.

**Service account steps:**
1. In Google Cloud Console, create or select a project and enable the **Google Calendar API**.
2. Go to **IAM & Admin → Service Accounts** and create one (for example `jobber-sync`). It needs no roles.
3. Open **Keys → Add key → JSON** and download it. From the JSON, copy `client_email` into `GOOGLE_SA_CLIENT_EMAIL` and `private_key` into `GOOGLE_SA_PRIVATE_KEY`.
4. For each estimator's calendar, open Google Calendar → **Settings and sharing → Share with specific people**. Add the service account email with **"Make changes to events"**.
   - Workspace note: if sharing outside the organization is blocked, a Workspace admin must allow external sharing for calendars, or use domain-wide delegation instead (set `GOOGLE_SA_SUBJECT`).
5. The mapping's `googleCalendarId` is the calendar's ID from **Settings → Integrate calendar**. For a primary calendar this is the person's email address.

**OAuth mode steps (alternative):**
1. Create an OAuth client of type Web.
2. Obtain a refresh token for the admin account with the `calendar.events` scope, for example via the OAuth Playground using your own client credentials.
3. Set `GOOGLE_AUTH_MODE = "oauth"` plus the three `GOOGLE_OAUTH_*` secrets.

If the shared identity lacks access to a calendar, the result is a **permanent** error. It is logged with the calendar ID and is not retried until you fix sharing.

---

## 7. Environment variables and secrets

**Vars** (`wrangler.toml`):

| Variable | Value |
|---|---|
| `JOBBER_API_VERSION` | `2026-09-25` |
| `JOBBER_REDIRECT_URI` | Your callback URL |
| `GOOGLE_AUTH_MODE` | `service_account` or `oauth` |
| `DEFAULT_TIMEZONE` | Timezone for all-day visits |
| `ALLOWED_TOPICS` | Comma-separated topic list |
| `EVENT_TITLE_PREFIX` | Optional prefix, e.g. `[Jobber]` |

**Secrets** (`wrangler secret put NAME`, or Dashboard → Worker → Settings → Variables and Secrets → *Encrypt*):

| Secret | Notes |
|---|---|
| `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET` | From the Jobber app |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` (must be 32 bytes) |
| `ADMIN_API_TOKEN` | `openssl rand -hex 32` |
| `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, optional `GOOGLE_SA_SUBJECT` | Service account mode |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth mode |

Tokens are never logged. The logger redacts any key matching token, secret, authorization, password, private key, assertion or code. A test asserts that no token value appears in any log line.

---

## 8. Deployment

**Option A — from GitHub (no local terminal).**
1. Push this folder to a GitHub repo.
2. In the Cloudflare dashboard, go to **Storage & Databases → D1 → Create** `jobber_gcal_sync`. Open its **Console** and paste the contents of `migrations/0001_init.sql`, then run it.
3. Go to **Queues → Create** `jobber-visit-sync` and `jobber-visit-sync-dlq`.
4. Edit `wrangler.toml` in GitHub: set `database_id` to the D1 ID from step 2, and set `JOBBER_REDIRECT_URI` to your workers.dev URL.
5. Go to **Workers & Pages → Create → Import a repository**, select the repo, and deploy. Workers Builds runs `npx wrangler deploy` on each push.
6. Add the secrets under the Worker's **Settings → Variables and Secrets**.
7. Complete Jobber setup (section 5) and Google setup (section 6), then add mappings.

**Option B — Wrangler CLI.**
```bash
npm install
npx wrangler d1 create jobber_gcal_sync        # paste database_id into wrangler.toml
npx wrangler queues create jobber-visit-sync
npx wrangler queues create jobber-visit-sync-dlq
npm run db:migrate:remote
for s in JOBBER_CLIENT_ID JOBBER_CLIENT_SECRET TOKEN_ENCRYPTION_KEY ADMIN_API_TOKEN GOOGLE_SA_CLIENT_EMAIL GOOGLE_SA_PRIVATE_KEY; do npx wrangler secret put $s; done
npm run deploy
```

Cloudflare Queues availability depends on your Cloudflare plan, so check your account's Workers plan.

---

## 9. Local testing

```bash
npm install
npm test            # 57 automated tests, no network or credentials needed
npm run typecheck
cp .dev.vars.example .dev.vars   # fill in real values to hit real APIs
npm run db:migrate:local
npm run dev         # wrangler dev on http://localhost:8787 (local D1 + local queue)
```

To send a signed webhook to the local worker:
```bash
JOBBER_CLIENT_SECRET=... node scripts/sign-webhook.mjs VISIT_UPDATE <visitId> <accountId> http://localhost:8787/webhooks/jobber
```

To exercise the real APIs locally, first complete the Jobber OAuth flow. Jobber must reach your callback, so either run OAuth against the deployed worker, or expose `wrangler dev` through a tunnel and add that callback URL in the Jobber app. Then insert a mapping with `/admin/mappings`.

**Automated test coverage** (`test/`). The tests use in-memory fakes of the Jobber and Google APIs on the real D1 SQL schema:
- A scheduled Job Visit creates an event with the correct fields and extended properties.
- A Visit update (reschedule, title, instructions) modifies the same event.
- Visit deletion removes the event using stored mappings, without a Jobber lookup.
- Reassignment moves the event between calendars; reassigning back revives it.
- Duplicate webhooks, across batches or within one batch, never create duplicates and make zero redundant Google writes.
- Unscheduled visits are ignored, and a visit that *becomes* unscheduled is removed.
- Requests, Assessments and Quotes/Estimates (all topics) never call Jobber or Google, including a `VISIT_*` topic whose ID decodes to a Request or Quote.
- A Quote approved into a Job syncs only the resulting Job Visit.
- Multiple assignees, unmapped users, all-day visits and `JOB_DESTROY` behave correctly.
- Retries: Google 503 inline, Jobber `THROTTLED` with queue retry and backoff, and a Google failure after the mapping write.
- Permanent errors: an unshared calendar is acked and logged, not retried.
- Tokens: expired-token refresh with rotation, a 401 forced refresh, and an invalid refresh token setting `reauth_required`. Tokens are never logged.
- HMAC verification matches Jobber's documented Node algorithm; also covers PKCE, the service-account RS256 JWT, and AES-GCM.

---

## 10. End-to-end test plan (real Jobber + Google, after deploy)

Use a test client and a test estimator mapped to a test calendar. Watch **Workers → Logs** and `GET /admin/log`.

| # | Do this in Jobber | Expect in Google (within seconds) |
|---|---|---|
| 1 | Create a Job with one scheduled visit, assigned to the estimator | One busy event: title, time, address, client, instructions, Jobber link |
| 2 | Drag the visit to another time | Same event moves; no duplicate |
| 3 | Edit the visit title and instructions | Same event updated |
| 4 | Reassign to a second mapped user | Event disappears from calendar 1 and appears on calendar 2 |
| 5 | Assign both users | One event on each calendar |
| 6 | Unschedule the visit (no date) | Events removed; log shows `Skipped unscheduled job visit` |
| 7 | Delete the visit | Events removed |
| 8 | Delete a job with visits | All its events removed |
| 9 | Create a Request, and an Assessment for it | Nothing in Google; log shows `Skipped non-job event` if any such topic arrives |
| 10 | Create a Quote, then approve it and convert it to a Job with a visit | Nothing for the Quote; one event appears only for the Job visit |
| 11 | Edit a job's title | Tracked visits of the job re-sync with the new title |
| 12 | In Routemize, connect the estimator's Google Calendar | The Jobber visit blocks that slot |

---

## 11. Error handling and retry strategy

| Failure | Handling |
|---|---|
| Bad or missing signature | `401`; nothing queued |
| Network error, HTTP 429/5xx (Jobber or Google) | Up to 3 inline attempts with jittered exponential backoff, honoring `Retry-After` up to 5 s |
| Still failing, or a long `Retry-After` | `message.retry()` with a queue delay of 15 s, 30 s, 60 s … capped at 15 min; up to 8 attempts, then **`jobber-visit-sync-dlq`** |
| Jobber `THROTTLED` | Queue retry, with the delay computed from the cost deficit ÷ `restoreRate` |
| Google `rateLimitExceeded` (403) | Queue retry after 30 s |
| Jobber 401 | One forced token refresh, then retry |
| Refresh token rejected (`invalid_grant`) | Account → `reauth_required`; messages acked as permanent errors; re-run `/oauth/jobber/start` |
| Calendar not shared or not found (403/404) | Permanent error: logged with the calendar ID, acked, not retried |
| Duplicate or concurrent deliveries | Collapsed within a batch; deterministic IDs plus content hashes make replays no-ops |

**Retries are idempotent end to end.** Every step re-reads current Jobber state and writes to a fixed event ID. A retry after a partial failure finishes the job instead of duplicating it.

**Token refresh safety.** Rotation invalidates the old refresh token immediately, so only one consumer may refresh at a time. A D1 lock enforces this, together with `max_concurrency = 1`. The new tokens are persisted before the new access token is used.

**Operations.** Inspect the DLQ in the dashboard, and replay any visit with:
```bash
curl -X POST https://<worker>/admin/resync -H "authorization: Bearer $ADMIN_API_TOKEN" \
  -H "content-type: application/json" -d '{"accountId":"…","visitId":"…"}'
```
`GET /admin/visits?accountId=…&visitId=…` shows exactly which calendar and event a visit maps to.

---

## 12. Admin API reference (Bearer `ADMIN_API_TOKEN`)

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness (no auth) |
| `GET /oauth/jobber/start?key=…` | Begin Jobber connection |
| `GET /admin/accounts` | Connected accounts and status (no tokens) |
| `GET /admin/jobber/users?accountId=…` | Jobber users and their current mapping |
| `GET/PUT/DELETE /admin/mappings` | Manage user → calendar mapping |
| `GET /admin/visits?accountId=…&visitId=…` | Stored event mapping for a visit |
| `POST /admin/resync` | Re-queue a visit |
| `GET /admin/log?limit=50` | Recent audit entries |
