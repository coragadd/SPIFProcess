# SPIF Process

Strict, auditable request and approval process for SPIFs, bonuses, and adjustments.

Flow: submitter requests -> finance classifies (capitalizable or expense) -> approver (Peter) approves once or indefinitely -> second sign-off when the approver is the submitter. Every action is written to an append-only audit log.

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
