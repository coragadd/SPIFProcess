# SPIF Process

Strict, auditable request and approval process for SPIFs, bonuses, and adjustments.

Flow: submitter requests -> finance classifies (capitalizable or expense; finance can report a concern but cannot return or reject) -> a higher-tier approver approves once (this month) or through the end of the current quarter, and can also return or reject. One approver is enough. Tier 1 submitters have no approver, so finance's step completes their requests. A quarterly approval lets resubmissions with unchanged terms that end by that date skip review ("Resubmit with changes" always goes through review). Every action is written to an append-only audit log.

Admins can do every step (classify, approve, skip) except on their own requests. Their decisions show as "(admin)" on the record and in the audit log, and Slack says an admin acted. Admins also have a read-only "View as" mode (Admin page) to see the app as another user. Reports are visible to admins, finance and Tier 1 only, and are marked "Coming soon".

Payout amounts (Manage Incentives): amounts can be typed or imported from a CSV (columns Rep, Amount, optional Note; a template pre-filled with the reps already listed can be downloaded). The CSV is checked in the browser and loaded into the table for review, so nothing is saved until Save rep amounts. Any invalid row (unknown rep, blank or non-numeric amount, duplicate) rejects the whole file, and replacing rows already in the table asks first. When RevOps calculates, only an admin can enter or upload them. When the submitter calculates, they must also attach a screenshot or file showing their calculations.

## Scheduled Slack reminders

`vercel.json` has a Vercel Cron job that calls `/cron/reminders` daily at 14:00 UTC. On the 1st (America/New_York) it DMs submitters who still have no payout amounts for SPIFs that ended last month ("due by the 3rd"); on the 3rd it sends a follow-up for anything still missing. Each reminder is sent at most once a month. Set `CRON_SECRET` in Vercel (the route rejects calls without it). To test: `GET /cron/reminders?dry=1&force=first` with `Authorization: Bearer <CRON_SECRET>` lists who would be messaged without sending (`today=YYYY-MM-DD` overrides the date).

## MBO reminders

Admins only. Open a user in **Admin** and set "MBOs owed each month" and "MBOs owed each quarter" (0 = none). On **Admin > MBO reminders** (`/admin/mbos`), set the due day of the month after each period ends (required once; nothing is hardcoded). Entries are then created automatically for the current month and quarter (by the daily job or when the page opens), and the page shows who is Owed or Submitted with reminder status and a "Send reminder now" button. A monthly entry becomes Submitted when that person has submitted that many MBOs for the month through the portal (MBO requests where they are the submitter); a quarterly entry counts every MBO in the quarter's three months. An admin can also mark an entry by hand, and one-off entries can still be added for a single month. Reminders are Slack DMs to the Slack member ID on the user, sent by the same daily cron job: the first day after month end, and `MBO_SECOND_REMINDER_DAYS` (default 2) days before the due date. Neither is sent once the entry is Submitted, each is recorded when sent and never repeated, and "Single reminder only" entries get one reminder on a chosen date instead. `GET /cron/reminders?dry=1&today=YYYY-MM-DD` lists the MBO reminders (under `mbo`) that would go out.

## Stack

Node + Express, server-rendered pages, hosted on Vercel as a serverless function (`api/index.js` exports the app from `src/server.js`). Data lives in Turso (hosted SQLite, via `@libsql/client`). Documents uploaded to SPIFs before the form moved to links (the supporting document is now an optional link; new uploads are refused) and proof of payout calculations are stored in the same database (`attachment_blobs`), linked to a request version, and counted as part of the approved terms. Vercel rejects request bodies over 4.5 MB, so attachments are limited to 4 MB in total per submission.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes (in production) | Long random string used to sign session cookies |
| `ADMIN_EMAIL` | first run | Email of the first admin, created only when no users exist |
| `ADMIN_PASSWORD` | first run | Password for the first admin (min 10 characters recommended) |
| `ADMIN_NAME` | optional | Display name of the first admin |
| `TURSO_DATABASE_URL` | yes (on Vercel) | `libsql://<db>.turso.io`. When unset, a SQLite file in `DATA_DIR` or `./data` is used (local runs) |
| `TURSO_AUTH_TOKEN` | yes (on Vercel) | Token for that database |
| `APP_URL` | optional | Base URL used in Slack links. Defaults to the Vercel production URL, then the request's host |
| `ENTRA_CLIENT_ID` | for SSO | Entra app (client) ID. Falls back to `CLIENT_ID` |
| `ENTRA_CLIENT_SECRET` | for SSO | Entra client secret value. Falls back to `SECRET_VALUE`. SSO turns on when both are set |
| `ENTRA_TENANT_ID` | optional | Entra directory (tenant) ID; defaults to Quilt's tenant |
| `ENTRA_REDIRECT_URI` | optional | Defaults to `APP_URL` (or the request host) + `/auth/microsoft/callback`; must match Entra exactly |
| `BREAK_GLASS_EMAILS` | optional | Comma-separated admins who can still use password sign-in at `/login?admin=1` once SSO is on. Defaults to `ADMIN_EMAIL` |
| `CRON_SECRET` | for reminders | Long random string. Vercel sends it as `Authorization: Bearer ...` on cron calls; `/cron/reminders` refuses requests without it |
| `MBO_SECOND_REMINDER_DAYS` | optional | Days before the due date for the second MBO reminder. Defaults to 2 |
| `SLACK_BOT_TOKEN` | for Slack | Bot token with `chat:write`; sends to channels and DMs |
| `SLACK_FINANCE_CHANNEL_ID` | for Slack | Channel for "needs finance action" |
| `SLACK_COMMISSION_CHANNEL_ID` | for Slack | Channel for "needs the commissions team" |
| `SLACK_WEBHOOK_URL` | legacy | Finance webhook, used only while `SLACK_BOT_TOKEN` is unset |

Approver and submitter DMs use the Slack member ID set on each user in Admin.

## Vercel setup

1. Create a Turso database (the Turso integration in the Vercel Marketplace sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you). Pick a region near the Vercel function region (US East by default).
2. Import the repo as a Vercel project. No build settings are needed; `vercel.json` routes everything to `api/index.js` and `public/static/` is served by the CDN.
3. Set the variables above under **Settings > Environment Variables**.
4. Deploy. The first request creates the tables and the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then add users in **Admin** and choose their reports.

## Moving existing data from Railway

Do this before the Railway volume is deleted. It needs the [Turso CLI](https://docs.turso.tech/cli).

1. Copy `spif.db` and the `uploads/` folder off the volume.
2. Fold the write-ahead log into the file: `sqlite3 spif.db "PRAGMA wal_checkpoint(TRUNCATE)"`.
3. Create the database from it: `turso db create spif-process --from-file spif.db`. Get the URL and a token with `turso db show spif-process --url` and `turso db tokens create spif-process`.
4. Deploy once so the new tables exist, or run step 5, which creates them too.
5. Move the uploaded documents into the database: `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run import-uploads -- <path to uploads folder>`. It is safe to re-run and lists any file it could not find.

Existing attachments larger than 4 MB still download fine; the limit applies only to new uploads.

Rotate `SESSION_SECRET`, the Slack token, and any other secret that was set on Railway, since they were exposed to the breach. Rotating `SESSION_SECRET` signs everyone out.

## Local run

```
npm install
SESSION_SECRET=dev ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me-please npm start
```

With no Turso variables set, this keeps data in `./data/spif.db`.

## Not built yet

Mid-run change requests, email notifications, request-type admin, saved-SPIF editing, outcome comparison reports.
