# SPIF Process

Strict, auditable request and approval process for SPIFs, bonuses, and adjustments.

Flow: submitter requests -> finance classifies (capitalizable or expense; finance can report a concern but cannot return or reject) -> a higher-tier approver approves once (this month) or through the end of the half year (June 30 / December 31), and can also return or reject. One approver is enough. Tier 1 submitters have no approver, so finance's step completes their requests. A half-year approval lets resubmissions with unchanged terms that end by that date skip review. Every action is written to an append-only audit log.

## Stack

Node + Express, server-rendered pages, hosted on Vercel as a serverless function (`api/index.js` exports the app from `src/server.js`). Data lives in Turso (hosted SQLite, via `@libsql/client`). Uploaded documents (eligibility and measurement rules) are stored in the same database (`attachment_blobs`), linked to a request version, and counted as part of the approved terms. Vercel rejects request bodies over 4.5 MB, so attachments are limited to 4 MB in total per submission.

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
