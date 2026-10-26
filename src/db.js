'use strict';
const crypto = require('crypto');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

// Storage is Turso (hosted SQLite), because Vercel functions have no persistent disk.
//   TURSO_DATABASE_URL  libsql://your-db.turso.io
//   TURSO_AUTH_TOKEN    token for that database
// Locally, with neither set, it falls back to a SQLite file in ./data (or DATA_DIR).
if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
  throw new Error('TURSO_DATABASE_URL is not set. Add it (and TURSO_AUTH_TOKEN) under Project Settings > Environment Variables, then redeploy.');
}

// libsql:// URLs open a WebSocket, which suits a long-lived server; over HTTPS each query is a plain
// request, which is what serverless functions want.
const url = (
  process.env.TURSO_DATABASE_URL ||
  'file:' + path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'spif.db').replace(/\\/g, '/')
).replace(/^libsql:/, 'https:');
if (url.startsWith('file:')) require('fs').mkdirSync(path.dirname(url.slice(5)), { recursive: true });

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Queries made while a transaction is running (anywhere down the async call chain) go through it.
const txStore = new AsyncLocalStorage();
const runner = () => txStore.getStore() || client;

function rowsOf(rs) {
  return rs.rows.map((r) => {
    const o = {};
    rs.columns.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}

// A small async version of the better-sqlite3 API this app was written against:
// db.prepare(sql).get / all / run, and db.transaction(fn).
const db = {
  prepare(sql) {
    const exec = (args) => runner().execute({ sql, args });
    return {
      get: async (...args) => rowsOf(await exec(args))[0],
      all: async (...args) => rowsOf(await exec(args)),
      run: async (...args) => {
        const rs = await exec(args);
        return {
          changes: rs.rowsAffected,
          lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid),
        };
      },
    };
  },
  // Wraps fn so every call runs in one write transaction: committed if it returns, rolled back if it throws.
  transaction(fn) {
    return async (...args) => {
      if (txStore.getStore()) return fn(...args);
      const tx = await client.transaction('write');
      try {
        const out = await txStore.run(tx, () => fn(...args));
        await tx.commit();
        return out;
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      } finally {
        tx.close();
      }
    };
  },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('submitter','finance','approver','admin')),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- A submitter's assigned approvers: the tier 1 and tier 2 people their requests go to.
  tier1_id INTEGER REFERENCES users(id),
  tier2_id INTEGER REFERENCES users(id),
  -- Slack member ID (starts with U or W) used for direct-message notifications.
  slack_id TEXT,
  -- Tiers: 1 and 2 can both request and approve (tier 1 needs only finance, tier 2 needs a tier 1
  -- approver); tier 3 can only request (needs a tier 1 or 2 approver). Admins have no tier.
  tier INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- A saved_spifs row is a standing half-year approval: terms unchanged and ending on or before
-- approved_through (June 30 or December 31) skip review when resubmitted.
CREATE TABLE IF NOT EXISTS saved_spifs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  classification TEXT,
  classification_reasoning TEXT,
  approved_indefinitely INTEGER NOT NULL DEFAULT 0,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_request_id INTEGER,
  source_version INTEGER,
  approved_through TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('new_spif','recurring_spif','bonus','adjustment')),
  name TEXT NOT NULL COLLATE NOCASE,
  submitter_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  saved_spif_id INTEGER REFERENCES saved_spifs(id),
  classification TEXT,
  classification_reasoning TEXT,
  approval_scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- The concern finance reported, shown to the approver and the submitter. approval_through is the
  -- date a half-year approval runs to.
  finance_concern TEXT,
  approval_through TEXT
);

CREATE TABLE IF NOT EXISTS request_versions (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, version)
);

CREATE TABLE IF NOT EXISTS approval_steps (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('finance','approver','second_signoff')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','returned','rejected','skipped')),
  reasoning TEXT,
  detail TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL,
  field TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_request ON attachments(request_id, version);

-- The file contents. An attachments row points here by stored_name; carried-over copies share one blob.
CREATE TABLE IF NOT EXISTS attachment_blobs (
  stored_name TEXT PRIMARY KEY,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL UNIQUE REFERENCES requests(id),
  actual_spend REAL NOT NULL,
  deals_count INTEGER,
  notes TEXT NOT NULL,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What each rep will make from a request. Mutable on purpose (editable after approval); every
-- change is written to the audit log with the before and after.
CREATE TABLE IF NOT EXISTS rep_amounts (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  rep_name TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rep_amounts_request ON rep_amounts(request_id);

-- The people who can receive amounts. Seeded from src/reps.json (see scripts/export-reps.ps1).
CREATE TABLE IF NOT EXISTS reps (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT,
  pod TEXT,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  request_id INTEGER,
  detail_json TEXT
);

-- Failed sign-ins, kept in the database because serverless instances share no memory.
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(key);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_submitter ON requests(submitter_id);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id);

-- Append-only: history can never be edited or removed through the app (or by accident).
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS versions_no_update BEFORE UPDATE ON request_versions
BEGIN SELECT RAISE(ABORT, 'request_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS versions_no_delete BEFORE DELETE ON request_versions
BEGIN SELECT RAISE(ABORT, 'request_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS attachments_no_update BEFORE UPDATE ON attachments
BEGIN SELECT RAISE(ABORT, 'attachments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS attachments_no_delete BEFORE DELETE ON attachments
BEGIN SELECT RAISE(ABORT, 'attachments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS steps_no_update BEFORE UPDATE ON approval_steps
BEGIN SELECT RAISE(ABORT, 'approval_steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS steps_no_delete BEFORE DELETE ON approval_steps
BEGIN SELECT RAISE(ABORT, 'approval_steps are append-only'); END;
`;

async function getSetting(key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

async function audit(actor, action, entity, entityId, requestId, detail) {
  await db
    .prepare(
      'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, request_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      actor ? actor.id : null,
      actor ? actor.name : 'system',
      action,
      entity,
      entityId == null ? null : entityId,
      requestId == null ? null : requestId,
      detail ? JSON.stringify(detail) : null
    );
}

// reps.json is the source of truth for who is active. Add or update everyone in it and deactivate
// anyone who is no longer listed (rows are kept, never deleted). The list's hash is remembered so
// this runs only when the file changed, not on every cold start.
async function seedReps() {
  let list;
  try {
    list = require('./reps.json');
  } catch (e) {
    return;
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
  if ((await getSetting('reps_hash')) === hash) return;
  const upsert = `INSERT INTO reps (name, role, pod, unit, active) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET role = excluded.role, pod = excluded.pod, unit = excluded.unit, active = 1`;
  await client.batch(
    [
      'UPDATE reps SET active = 0',
      ...list.map((r) => ({ sql: upsert, args: [r.name, r.role || null, r.pod || null, r.unit || null] })),
      {
        sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: ['reps_hash', hash],
      },
    ],
    'write'
  );
}

// First-run admin, taken from environment variables (never hardcoded).
async function seedAdmin() {
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
  if (count > 0) return;
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn(
      'No users exist. Set ADMIN_EMAIL, ADMIN_PASSWORD (and optionally ADMIN_NAME) to create the first admin.'
    );
    return;
  }
  const info = await db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(ADMIN_NAME || 'Admin', ADMIN_EMAIL.trim(), bcrypt.hashSync(ADMIN_PASSWORD, 10), 'admin');
  await audit(null, 'user.created', 'user', info.lastInsertRowid, null, { email: ADMIN_EMAIL, role: 'admin', via: 'seed' });
  console.log(`Created first admin: ${ADMIN_EMAIL}`);
}

// Creates the tables and seeds data. Memoized, so it runs once per server instance; the first
// request awaits it. A failure is not remembered, so the next request tries again.
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await client.executeMultiple(SCHEMA);
      await seedReps();
      await seedAdmin();
    })().catch((e) => {
      readyPromise = null;
      throw e;
    });
  }
  return readyPromise;
}

// Used by scripts that store files outside a request.
const putBlob = (storedName, data) =>
  db.prepare('INSERT OR IGNORE INTO attachment_blobs (stored_name, data) VALUES (?, ?)').run(storedName, data);

const getBlob = async (storedName) => {
  const row = await db.prepare('SELECT data FROM attachment_blobs WHERE stored_name = ?').get(storedName);
  return row ? Buffer.from(row.data) : null;
};

module.exports = { db, client, audit, getSetting, setSetting, ready, putBlob, getBlob };
