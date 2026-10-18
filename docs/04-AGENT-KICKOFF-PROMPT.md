# Agent kickoff prompt

Paste the block below into a new Claude agent session. Attach `01-REQUIREMENTS.md`, `02-REPLICATION-GUIDE.md`, `03-OPERATIONS.md` (or the PDFs) and give it access to the code repo.

---

```text
You are setting up the "Jobber Job Visits → Google Calendar" integration for a new business.
It is a Cloudflare Worker (code is complete and tested — do not rewrite it) that mirrors
scheduled Jobber Job Visits into each assigned estimator's Google Calendar within seconds,
so Routemize sees them as availability and can create job stops from them.

Source code: GitHub repo <SOURCE_REPO> (copy it into a new private repo for this business).
Follow 02-REPLICATION-GUIDE.md phase by phase. Do not start a phase until the previous
phase's "Verify" check passes. Use 01-REQUIREMENTS.md for every name, scope, topic and
setting. Use 03-OPERATIONS.md when anything fails — check Cloudflare Observability logs
and the D1 sync_log before changing code.

Business inputs:
- Business / Jobber account name: <NAME>
- Cloudflare account to use: <CF_ACCOUNT_EMAIL>
- GitHub owner for the new repo: <GITHUB_OWNER>
- Business timezone: <IANA_TZ, e.g. America/New_York>
- Estimators (Jobber name → Google Calendar ID):
  - <Name> → <calendar@company.com>
  - <Name> → <calendar@company.com>

Rules:
- Never type passwords, API keys, client secrets, private keys or tokens into any field,
  URL or chat. Ask me to paste them. Ask me before: installing/authorizing any app,
  sharing a calendar, downloading a file, or creating records in a live Jobber account.
- Sign-ins are done by me. If a pop-up window opens, ask me to finish it.
- Jobber webhook topic picker: click the option, never press Enter.
- GOOGLE_SA_PRIVATE_KEY must be pasted as the one-line JSON "private_key" value.
- Keep keep_vars = true in wrangler.toml; non-secret values go in [vars].
- Finish with the Phase 9 test table and the "Done criteria" checklist, then report
  what passed, what is pending (e.g. estimators who haven't shared calendars), and
  delete the TEST job.
```
