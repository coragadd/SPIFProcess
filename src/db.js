'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

// Persistent storage: a Railway volume exposes its mount path as
// RAILWAY_VOLUME_MOUNT_PATH. DATA_DIR overrides it. Locally we fall back to ./data.
const dataDir =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'spif.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('submitter','finance','approver','admin')),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`);

// Add columns to tables that may already exist from an earlier deploy.
function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumnIfMissing('saved_spifs', 'source_request_id', 'INTEGER');
addColumnIfMissing('saved_spifs', 'source_version', 'INTEGER');

// Tiers: 1 and 2 can both request and approve (tier 1 needs only finance, tier 2 needs a tier 1
// approver); tier 3 can only request (needs a tier 1 or 2 approver). Everyone defaults to tier 3.
addColumnIfMissing('users', 'tier', 'INTEGER NOT NULL DEFAULT 3');
// The old 'approver' role became tier 1. The CHECK constraint still allows the value, so move
// those users to the plain 'submitter' role.
db.exec(`UPDATE users SET tier = 1, role = 'submitter' WHERE role = 'approver'`);

const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? null : String(value));
}

function audit(actor, action, entity, entityId, requestId, detail) {
  db.prepare(
    'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, request_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    actor ? actor.id : null,
    actor ? actor.name : 'system',
    action,
    entity,
    entityId == null ? null : entityId,
    requestId == null ? null : requestId,
    detail ? JSON.stringify(detail) : null
  );
}

// First-run admin, taken from environment variables (never hardcoded).
function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn(
      'No users exist. Set ADMIN_EMAIL, ADMIN_PASSWORD (and optionally ADMIN_NAME) to create the first admin.'
    );
    return;
  }
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(ADMIN_NAME || 'Admin', ADMIN_EMAIL.trim(), bcrypt.hashSync(ADMIN_PASSWORD, 10), 'admin');
  audit(null, 'user.created', 'user', info.lastInsertRowid, null, { email: ADMIN_EMAIL, role: 'admin', via: 'seed' });
  console.log(`Created first admin: ${ADMIN_EMAIL}`);
}

module.exports = { db, audit, getSetting, setSetting, seedAdmin, dataDir, uploadDir };
