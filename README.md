# SPIF Process

Strict, auditable request and approval process for SPIFs, bonuses, and adjustments.

Flow: submitter requests -> finance classifies (capitalizable or expense; finance can report a concern but cannot return or reject) -> a higher-tier approver approves once (this month) or through the end of the half year (June 30 / December 31), and can also return or reject. One approver is enough. Tier 1 submitters have no approver, so finance's step completes their requests. A half-year approval lets resubmissions with unchanged terms that end by that date skip review. Every action is written to an append-only audit log.

## Stack

Node + Express, server-rendered pages, SQLite (`better-sqlite3`) on a Railway volume. Uploaded documents (eligibility and measurement rules) are stored in `uploads/` on the same volume, linked to a request version, and counted as part of the approved terms.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes (in production) | Long random string used to sign session cookies |
| `ADMIN_EMAIL` | first run | Email of the first admin, created only when no users exist |
| `ADMIN_PASSWORD` | first run | Password for the first admin (min 10 characters recommended) |
| `ADMIN_NAME` | optional | Display name of the first admin |
| `DATA_DIR` | optional | Database directory. Defaults to `RAILWAY_VOLUME_MOUNT_PATH`, then `./data` |
| `SLACK_BOT_TOKEN` | for Slack | Bot token with `chat:write`; sends to channels and DMs |
| `SLACK_FINANCE_CHANNEL_ID` | for Slack | Channel for "needs finance action" |
| `SLACK_COMMISSION_CHANNEL_ID` | for Slack | Channel for "needs the commissions team" |
| `SLACK_WEBHOOK_URL` | legacy | Finance webhook, used only while `SLACK_BOT_TOKEN` is unset |

Approver and submitter DMs use the Slack member ID set on each user in Admin.

## Railway setup

1. Add a **Volume** to the service and mount it at `/data`.
2. Set the variables above in the service's **Variables** tab.
3. Generate a domain under **Settings > Networking**.
4. Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then add users in **Admin** and choose the second sign-off person.

## Local run

```
npm install
SESSION_SECRET=dev ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me-please npm start
```

## Not built yet

Mid-run change requests, email notifications, request-type admin, saved-SPIF editing, outcome comparison reports.
