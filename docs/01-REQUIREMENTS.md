# Jobber → Google Calendar Sync — Requirements

**What this builds:** a Cloudflare Worker that copies every *scheduled Jobber Job Visit* into the assigned estimator's Google Calendar within seconds. Routemize reads those calendars as availability, and a job stop can be created from each event.

**Scope:** Job Visits only. Requests, Quotes/Estimates, Assessments, Tasks and Invoices never create calendar events.

---

## 1. Accounts and access

| # | Account | Who needs it | What it's used for | Notes |
|---|---|---|---|---|
| 1 | **GitHub** | Implementer | Hosts the code; pushes trigger deploys | Private repo. The Claude GitHub app must be installed on the repo if an agent pushes code |
| 2 | **Cloudflare** | Implementer | Worker, D1 database, Queues, secrets, logs | The free plan works: Queues include 10,000 ops/day and logs 200K events/day |
| 3 | **Cloudflare ↔ GitHub link** | Implementer | Workers Builds auto-deploys from the repo | The Cloudflare account must be linked to the **same** GitHub account that owns the repo |
| 4 | **Jobber Developer Center** (developer.getjobber.com) | Implementer | Creates the Jobber app: client ID/secret, scopes, webhooks | A **separate login** from the normal Jobber app |
| 5 | **Jobber account** (the customer's) | Jobber **admin** user | Approves the app once ("Allow Access") | A trial account works for testing |
| 6 | **Google Cloud** (console.cloud.google.com) | Implementer | Project, Calendar API, service account and JSON key | No billing needed for the Calendar API at this volume |
| 7 | **Google Calendar** for each estimator | Each estimator, or their Workspace admin | Shares their calendar with the service account | Only the calendar owner or a Workspace admin can share it |
| 8 | **Routemize** | Estimators / admin | Connects each estimator's Google Calendar | Uses the same calendar that receives the Jobber events |

## 2. Tools

- **Browser access** to all of the above. An agent can do almost everything through Claude in Chrome. Exceptions: sign-ins, pasting secrets, approving OAuth screens, and downloading the Google key file are done by the human.
- **Node.js 20+ and npm**, only to run the tests or deploy from a terminal. The normal path deploys from GitHub with no local terminal.
- **Optional:** the Cloudflare MCP connector (D1 queries, creating databases). The repo `jose24xhr-sys/jobber-gcal-sync` holds the complete, tested code: 65 tests.

## 3. Cloudflare resources

| Resource | Name | Binding | Created by |
|---|---|---|---|
| Worker | `jobber-gcal-sync` | — | Workers Builds (import repo) |
| D1 database | `jobber_gcal_sync` | `DB` | Dashboard or `wrangler d1 create`; then run `migrations/0001_init.sql` |
| Queue | `jobber-visit-sync` | `SYNC_QUEUE` (producer + consumer) | Dashboard → Queues |
| Queue (dead letter) | `jobber-visit-sync-dlq` | — | Dashboard → Queues |
| Cron | daily `17 4 * * *` | — | `wrangler.toml` (prunes old logs) |

## 4. Configuration values

### Plain variables (in `wrangler.toml`, safe to commit)

| Name | Example | Purpose |
|---|---|---|
| `JOBBER_API_VERSION` | `2026-09-25` | Required `X-JOBBER-GRAPHQL-VERSION` header |
| `JOBBER_REDIRECT_URI` | `https://jobber-gcal-sync.<subdomain>.workers.dev/oauth/jobber/callback` | Must match the Jobber app's Callback URL exactly |
| `GOOGLE_AUTH_MODE` | `service_account` | Or `oauth` (not recommended) |
| `DEFAULT_TIMEZONE` | `America/New_York` | Used only for all-day visits |
| `ALLOWED_TOPICS` | `VISIT_CREATE,VISIT_UPDATE,VISIT_COMPLETE,VISIT_DESTROY,JOB_CREATE,JOB_UPDATE,JOB_DESTROY,APP_DISCONNECT` | Webhook topics acted on |
| `EVENT_TITLE_PREFIX` | *(empty)* or `[Jobber]` | Optional prefix on event titles |
| `JOBBER_CLIENT_ID` | from the Jobber app | Public identifier |
| `GOOGLE_SA_CLIENT_EMAIL` | `jobber-sync@<project>.iam.gserviceaccount.com` | Service account identity |
| `keep_vars = true` | top of `wrangler.toml` | Stops Git deploys from deleting variables added in the dashboard |

### Secrets (Cloudflare → Worker → Settings → Variables and Secrets → type **Secret**)

| Name | Where it comes from | Format |
|---|---|---|
| `JOBBER_CLIENT_SECRET` | Jobber app → Authorization section | As shown. It also verifies webhook signatures |
| `GOOGLE_SA_PRIVATE_KEY` | The service-account JSON key file | Paste the **one-line** `"private_key": "-----BEGIN…\n…-----END PRIVATE KEY-----\n"` text from the JSON. **Do not paste the multi-line PEM**: the dashboard field keeps only the first line |
| `TOKEN_ENCRYPTION_KEY` | You generate it | Ideally `openssl rand -base64 32`; any long passphrase also works |
| `ADMIN_API_TOKEN` | You generate it | Long random string; it protects `/admin` and `/oauth/jobber/start` |

Never commit secrets, put them in URLs, or paste them into chat.

## 5. Jobber app settings

| Setting | Value |
|---|---|
| App name / developer | e.g. "Routemize Calendar Sync" / "Routemize" |
| Callback URL | `https://jobber-gcal-sync.<subdomain>.workers.dev/oauth/jobber/callback` |
| Short description | Required to save |
| Scopes (read only) | **Clients**, **Jobs**, **Scheduled Items**, **Users** — no Write boxes |
| Webhooks (all → `https://jobber-gcal-sync.<subdomain>.workers.dev/webhooks/jobber`) | `VISIT_CREATE`, `VISIT_UPDATE`, `VISIT_COMPLETE`, `VISIT_DESTROY`, `JOB_CREATE`, `JOB_UPDATE`, `JOB_DESTROY`, `APP_DISCONNECT` |
| Refresh token rotation | **ON** (default) |

## 6. Google settings

| Item | Value |
|---|---|
| Project | e.g. `jobber-gcal-sync` |
| API enabled | Google Calendar API (`calendar-json.googleapis.com`) |
| Service account | e.g. `jobber-sync` — **no project roles** |
| Key | JSON (Keys → Add key → Create new key → JSON) |
| OAuth scope used | `https://www.googleapis.com/auth/calendar.events` only |
| Per-estimator calendar sharing | Share with the service account email → **"Make changes (see private events as free/busy)"** |

## 7. Information to collect from the business

- [ ] List of estimators/techs who should get Jobber visits on a calendar
- [ ] For each: **Jobber user** (name) → **Google Calendar ID**, usually their email; it's under Calendar settings → Integrate calendar
- [ ] Confirmation that each estimator has shared their calendar with the service account
- [ ] Business timezone (for all-day visits)
- [ ] Which Jobber admin will click "Allow Access"

## 8. Hosting model and cost

**Two ways to offer it to other businesses**

| Model | How it works | Limits |
|---|---|---|
| **Hosted (one Worker, many businesses)** | Each business's Jobber admin opens `/oauth/jobber/start` and clicks Allow Access. Their estimators share calendars with your service account. The code is already multi-account | A custom Jobber app can connect to **5 paying Jobber accounts** at most; beyond that it must be published in the Jobber App Marketplace (review, logo, Terms of Service and Privacy Policy URLs). You hold customers' tokens and client data, so have a privacy policy |
| **Self-hosted (one copy per business)** | The business follows this guide with its own Cloudflare, Google and Jobber app | No 5-account limit; costs and data stay with the business |

**Running cost** (prices checked Oct 2026)

| Service | Cost | Notes |
|---|---|---|
| Cloudflare | **$0** on the free plan | Free plan: 100,000 Worker requests/day, 10,000 Queue operations/day, D1 100,000 rows written/day + 5 GB. One visit change ≈ 2 webhooks ≈ 2 requests + ~6 queue ops, so about 1,500 visit changes/day fit free. Paid: **$5/month** (10M requests + 1M queue ops/month included) |
| Google Calendar API | **$0** | No per-call charge; daily quotas are far above this volume. No billing account required |
| Claude | **$0 to run** | The Worker never calls Claude; Claude was only used to build it |
| Jobber | **$0** for API use | The business needs its normal Jobber subscription |
