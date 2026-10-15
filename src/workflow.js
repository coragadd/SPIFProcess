'use strict';
const crypto = require('crypto');
const { db, audit, getSetting } = require('./db');

class UserError extends Error {}

const TYPES = {
  new_spif: 'New SPIF',
  recurring_spif: 'Recurring SPIF',
  bonus: 'Bonus',
  adjustment: 'Adjustment',
};

const STATUS_LABELS = {
  finance_review: 'Awaiting finance',
  approver_review: 'Awaiting approver',
  second_signoff: 'Awaiting second sign-off',
  returned: 'Returned to submitter',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  finalized: 'Finalized (results submitted)',
};

const PENDING = ['finance_review', 'approver_review', 'second_signoff'];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'UTC',
];

// Fields that define "how it works". Changing any of these voids an indefinite approval.
const TERM_FIELDS = [
  'participants',
  'participants_group',
  'participants_pods',
  'participants_individual',
  'description',
  'payout_structure',
  'amounts',
  'estimated_spend',
  'eligibility',
  'edge_cases',
  'deal',
  'adjustment_reason',
  'adjustment_size',
];

const GROUPS = [
  'AEs',
  'Expansion AEs',
  'oBDRs',
  'iBDRs',
  'amBDRs',
  'Merchant Services',
  'Customer Care',
  'Individual',
];
const PODS = ['All PODs', 'Red', 'Blue', 'Green', 'Black'];

const DATE_FIELDS =['start_date', 'end_date', 'announce_date', 'announce_method'];

function termsOf(data) {
  const o = {};
  for (const k of TERM_FIELDS) o[k] = data[k] == null ? '' : data[k];
  return o;
}

// The attached documents are part of the terms: a different file means different terms.
function hashTerms(data, files) {
  const shas = (files || []).map((f) => f.sha256).sort();
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ terms: termsOf(data), files: shas }))
    .digest('hex');
}

function attachmentsFor(requestId, version) {
  if (requestId == null || version == null) return [];
  return db
    .prepare('SELECT * FROM attachments WHERE request_id = ? AND version = ? ORDER BY id')
    .all(requestId, version);
}

// Copy carried-over files and record newly uploaded ones against a request version.
function saveAttachments(user, requestId, version, carried, uploaded) {
  const ins = db.prepare(
    `INSERT INTO attachments (request_id, version, field, original_name, stored_name, mime, size, sha256, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of carried) {
    ins.run(requestId, version, f.field, f.original_name, f.stored_name, f.mime, f.size, f.sha256, f.uploaded_by);
  }
  for (const f of uploaded) {
    ins.run(requestId, version, 'eligibility', f.original_name, f.stored_name, f.mime, f.size, f.sha256, user.id);
    audit(user, 'attachment.added', 'request', requestId, requestId, {
      version,
      file: f.original_name,
      sha256: f.sha256,
      size: f.size,
    });
  }
}

function isValidTz(tz) {
  return TIMEZONES.includes(tz);
}

function todayIn(tz) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function validDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parseMoney(v) {
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function secondSignoffUserId() {
  const v = getSetting('second_signoff_user_id');
  return v ? Number(v) : null;
}

// ---------------------------------------------------------------- validation

function validate(type, input, user, opts) {
  const { excludeId = null, fixedName = null } = opts || {};
  const errors = {};
  const d = {};
  const s = (k) => (input[k] == null ? '' : String(input[k]).replace(/\r\n/g, '\n').trim());
  const need = (k, label, min) => {
    d[k] = s(k);
    if (!d[k]) errors[k] = `${label} is required.`;
    else if (min && d[k].length < min) errors[k] = `${label} needs more detail (at least ${min} characters).`;
  };

  const isAdj = type === 'adjustment';

  d.name = fixedName || s('name');
  if (!d.name) errors.name = 'Name is required.';
  else if (!fixedName) {
    const dupReq = db
      .prepare('SELECT id FROM requests WHERE name = ? AND id != ? LIMIT 1')
      .get(d.name, excludeId == null ? -1 : excludeId);
    const dupSaved = db.prepare('SELECT id FROM saved_spifs WHERE name = ? LIMIT 1').get(d.name);
    if (dupReq || dupSaved) {
      errors.name = 'That name is already used. Pick a distinct name, or resubmit it from Saved recurring SPIFs.';
    }
  }

  // Who it applies to: a team (AEs also need a POD selection) or one named individual.
  d.participants_group = s('participants_group');
  d.participants_pods = [];
  d.participants_individual = '';
  if (!GROUPS.includes(d.participants_group)) {
    errors.participants_group = 'Choose who this applies to.';
  } else if (d.participants_group === 'AEs') {
    const picked = [].concat(input.participants_pods || []).map(String);
    d.participants_pods = picked.includes('All PODs') ? ['All PODs'] : PODS.filter((p) => picked.includes(p));
    if (!d.participants_pods.length) errors.participants_pods = 'Select All PODs or at least one POD.';
  } else if (d.participants_group === 'Individual') {
    d.participants_individual = s('participants_individual');
    if (!d.participants_individual) errors.participants_individual = 'Enter the individual\'s name.';
  }
  d.participants =
    d.participants_group === 'Individual'
      ? 'Individual: ' + d.participants_individual
      : d.participants_group + (d.participants_pods.length ? ' (' + d.participants_pods.join(', ') + ')' : '');

  need('amounts', 'Amounts');

  const spend = parseMoney(s('estimated_spend'));
  if (spend == null || spend < 0) errors.estimated_spend = 'Enter the estimated total spend as a number.';
  d.estimated_spend = spend == null ? '' : spend;

  if (isAdj) {
    need('description', 'Description', 20);
    // Adjustments may relate to a deal, a component, or nothing at all.
    d.deal = s('deal');
    need('adjustment_reason', 'Reason for the adjustment', 20);
    d.adjustment_size = s('adjustment_size');
    if (!['full', 'half'].includes(d.adjustment_size)) errors.adjustment_size = 'Choose full or half.';
    d.payout_structure = '';
    d.eligibility = '';
    d.edge_cases = '';
    for (const k of DATE_FIELDS) d[k] = '';
    return { errors, data: d };
  }

  need('description', 'Description of how it works', 50);
  d.payout_structure = s('payout_structure');
  if (!['flat_rate', 'calculated'].includes(d.payout_structure)) errors.payout_structure = 'Choose a payout structure.';
  // Rules can be typed, attached as a document, or both.
  d.eligibility = s('eligibility');
  if (!d.eligibility && !(opts && opts.fileCount > 0)) {
    errors.eligibility = 'Describe the eligibility and measurement rules, or attach a document.';
  } else if (d.eligibility && d.eligibility.length < 20) {
    errors.eligibility = 'Eligibility and measurement rules need more detail (at least 20 characters).';
  }
  need('edge_cases', 'Edge cases ("what if X happens?")', 20);

  const tz = user.timezone || 'America/New_York';
  const today = todayIn(tz);

  d.start_date = s('start_date');
  d.end_date = s('end_date');
  d.announce_date = s('announce_date');
  d.announce_method = s('announce_method');
  if (!d.announce_method) errors.announce_method = 'Announcement method is required.';

  if (!validDate(d.start_date)) errors.start_date = 'Enter a start date.';
  else if (d.start_date <= today) errors.start_date = `Start date must be after today (${today}, your time zone).`;

  if (!validDate(d.end_date)) errors.end_date = 'An end date is required. No perpetual SPIFs.';
  else if (validDate(d.start_date) && d.end_date < d.start_date) errors.end_date = 'End date cannot be before the start date.';
  else if (validDate(d.start_date) && d.end_date.slice(0, 7) !== d.start_date.slice(0, 7)) {
    errors.end_date = 'End date must be in the same month as the start date. Resubmit for the next month.';
  }

  if (!validDate(d.announce_date)) errors.announce_date = 'Enter the date it will be announced.';

  return { errors, data: d };
}

// ---------------------------------------------------------------- reads

function getRequest(id) {
  return db
    .prepare(
      `SELECT r.*, u.name AS submitter_name, u.role AS submitter_role
       FROM requests r JOIN users u ON u.id = r.submitter_id WHERE r.id = ?`
    )
    .get(id);
}

function getVersions(requestId) {
  return db
    .prepare(
      `SELECT v.*, u.name AS created_by_name FROM request_versions v
       JOIN users u ON u.id = v.created_by WHERE v.request_id = ? ORDER BY v.version`
    )
    .all(requestId)
    .map((v) => ({ ...v, data: JSON.parse(v.data_json) }));
}

function getSteps(requestId) {
  return db
    .prepare(
      `SELECT s.*, u.name AS decided_by_name FROM approval_steps s
       LEFT JOIN users u ON u.id = s.decided_by WHERE s.request_id = ? ORDER BY s.id`
    )
    .all(requestId);
}

function currentData(r) {
  const v = db
    .prepare('SELECT data_json FROM request_versions WHERE request_id = ? AND version = ?')
    .get(r.id, r.current_version);
  return JSON.parse(v.data_json);
}

function canView(user, r) {
  if (['admin', 'finance', 'approver'].includes(user.role)) return true;
  if (r.submitter_id === user.id) return true;
  if (user.id === secondSignoffUserId()) {
    if (r.status === 'second_signoff') return true;
    const decided = db
      .prepare('SELECT 1 FROM approval_steps WHERE request_id = ? AND decided_by = ? LIMIT 1')
      .get(r.id, user.id);
    return !!decided;
  }
  return false;
}

function listRequests(user) {
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS submitter_name, v.data_json
       FROM requests r
       JOIN users u ON u.id = r.submitter_id
       JOIN request_versions v ON v.request_id = r.id AND v.version = r.current_version
       ORDER BY r.id DESC`
    )
    .all();
  return rows.filter((r) => canView(user, r)).map((r) => ({ ...r, data: JSON.parse(r.data_json) }));
}

function queueFor(user, rows) {
  const second = secondSignoffUserId();
  return rows.filter(
    (r) =>
      (r.status === 'finance_review' && ['finance', 'admin'].includes(user.role) && r.submitter_id !== user.id) ||
      (r.status === 'approver_review' && user.role === 'approver') ||
      (r.status === 'second_signoff' && user.id === second && r.submitter_id !== user.id)
  );
}

function availableActions(user, r, data) {
  const pending = PENDING.includes(r.status);
  const self = user.id === r.submitter_id;
  const today = todayIn(user.timezone || 'America/New_York');
  return {
    finance: r.status === 'finance_review' && ['finance', 'admin'].includes(user.role) && !self,
    approver: r.status === 'approver_review' && user.role === 'approver',
    second: r.status === 'second_signoff' && user.id === secondSignoffUserId() && !self,
    skip: pending && user.role === 'admin' && !self,
    cancel: (pending || r.status === 'returned') && (self || user.role === 'admin'),
    edit: r.status === 'returned' && self,
    results:
      r.status === 'approved' && r.type !== 'adjustment' && self && !!data.end_date && today > data.end_date,
  };
}

function displayStatus(r, data, tz) {
  if (r.status !== 'approved' || r.type === 'adjustment' || !data.start_date) return STATUS_LABELS[r.status] || r.status;
  const today = todayIn(tz || 'America/New_York');
  if (today < data.start_date) return 'Approved, scheduled';
  if (today <= data.end_date) return 'Approved, running';
  return 'Approved, results due';
}

// ---------------------------------------------------------------- writes

function addStep(requestId, version, step, decision, reasoning, detail, userId) {
  db.prepare(
    'INSERT INTO approval_steps (request_id, version, step, decision, reasoning, detail, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(requestId, version, step, decision, reasoning || null, detail || null, userId == null ? null : userId);
}

function setStatus(id, status, extra) {
  const e = extra || {};
  db.prepare(
    `UPDATE requests SET status = ?, classification = COALESCE(?, classification),
     classification_reasoning = COALESCE(?, classification_reasoning),
     approval_scope = COALESCE(?, approval_scope), updated_at = datetime('now') WHERE id = ?`
  ).run(status, e.classification || null, e.reasoning || null, e.scope || null, id);
}

function nextAfterApprover(submitterRole) {
  return submitterRole === 'approver' ? 'second_signoff' : 'approved';
}

function assertCanSubmit(user) {
  if (user.role === 'approver' && !secondSignoffUserId()) {
    throw new UserError(
      'Your submissions need a second sign-off, but no second sign-off person is configured. Ask an admin to set one in Admin > Settings.'
    );
  }
}

// An indefinite approval turns the request's terms into a saved recurring SPIF.
function finalizeApproval(id, actor) {
  const r = getRequest(id);
  if (r.status !== 'approved' || r.approval_scope !== 'indefinite') return;
  const data = currentData(r);
  const terms = JSON.stringify(termsOf(data));
  const hash = hashTerms(data, attachmentsFor(r.id, r.current_version));
  let saved = r.saved_spif_id
    ? db.prepare('SELECT * FROM saved_spifs WHERE id = ?').get(r.saved_spif_id)
    : db.prepare('SELECT * FROM saved_spifs WHERE name = ?').get(r.name);
  if (saved) {
    db.prepare(
      `UPDATE saved_spifs SET terms_json = ?, terms_hash = ?, classification = ?, classification_reasoning = ?,
       approved_indefinitely = 1, approved_by = ?, approved_at = datetime('now'), active = 1,
       source_request_id = ?, source_version = ? WHERE id = ?`
    ).run(terms, hash, r.classification, r.classification_reasoning, actor.id, r.id, r.current_version, saved.id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO saved_spifs (name, owner_id, type, terms_json, terms_hash, classification,
         classification_reasoning, approved_indefinitely, approved_by, approved_at, source_request_id, source_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), ?, ?)`
      )
      .run(
        r.name,
        r.submitter_id,
        r.type,
        terms,
        hash,
        r.classification,
        r.classification_reasoning,
        actor.id,
        r.id,
        r.current_version
      );
    saved = { id: info.lastInsertRowid };
  }
  db.prepare('UPDATE requests SET saved_spif_id = ? WHERE id = ?').run(saved.id, id);
  audit(actor, 'saved_spif.approved_indefinitely', 'saved_spif', saved.id, id, { name: r.name });
}

// carried: attachment rows copied from a saved SPIF; uploaded: newly uploaded file records.
const createRequest = db.transaction((user, type, data, saved, uploaded, carried) => {
  assertCanSubmit(user);
  if (!TYPES[type]) throw new UserError('Unknown request type.');
  const up = uploaded || [];
  const carry = carried || [];
  const hash = hashTerms(data, [...carry, ...up]);

  const info = db
    .prepare(
      `INSERT INTO requests (type, name, submitter_id, status, saved_spif_id)
       VALUES (?, ?, ?, 'finance_review', ?)`
    )
    .run(type, data.name, user.id, saved ? saved.id : null);
  const id = Number(info.lastInsertRowid);
  db.prepare(
    'INSERT INTO request_versions (request_id, version, data_json, terms_hash, created_by) VALUES (?, 1, ?, ?, ?)'
  ).run(id, JSON.stringify(data), hash, user.id);
  saveAttachments(user, id, 1, carry, up);
  audit(user, 'request.submitted', 'request', id, id, { type, name: data.name, version: 1 });

  // Terms unchanged from an indefinitely approved SPIF: finance and approver steps are covered.
  if (type === 'recurring_spif' && saved && saved.approved_indefinitely && saved.terms_hash === hash) {
    const note = `Terms unchanged from indefinitely approved saved SPIF #${saved.id}`;
    addStep(id, 1, 'finance', 'skipped', note, 'inherited classification: ' + (saved.classification || 'none'), null);
    addStep(id, 1, 'approver', 'skipped', note, 'indefinite approval', null);
    const next = nextAfterApprover(user.role);
    setStatus(id, next, {
      classification: saved.classification,
      reasoning: saved.classification_reasoning,
      scope: 'indefinite',
    });
    audit(null, 'request.auto_approved_steps', 'request', id, id, { savedSpifId: saved.id, status: next });
  }
  return id;
});

const resubmitRequest = db.transaction((user, id, data, uploaded, carried) => {
  const r = getRequest(id);
  if (!r || r.submitter_id !== user.id) throw new UserError('Request not found.');
  if (r.status !== 'returned') throw new UserError('Only returned requests can be edited.');
  assertCanSubmit(user);
  const version = r.current_version + 1;
  db.prepare(
    'INSERT INTO request_versions (request_id, version, data_json, terms_hash, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, version, JSON.stringify(data), hashTerms(data, [...(carried || []), ...(uploaded || [])]), user.id);
  saveAttachments(user, id, version, carried || [], uploaded || []);
  db.prepare(
    `UPDATE requests SET current_version = ?, name = ?, status = 'finance_review', classification = NULL,
     classification_reasoning = NULL, approval_scope = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(version, data.name, id);
  audit(user, 'request.resubmitted', 'request', id, id, { version });
});

const financeDecide = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r) throw new UserError('Request not found.');
  if (r.status !== 'finance_review') throw new UserError('This request is not awaiting finance.');
  if (!['finance', 'admin'].includes(user.role)) throw new UserError('Only finance can classify requests.');
  if (r.submitter_id === user.id) throw new UserError('You cannot review your own request.');
  const reasoning = String(input.reasoning || '').trim();
  const action = input.action;

  if (action === 'classify') {
    if (!['capitalizable', 'expense'].includes(input.classification)) throw new UserError('Choose capitalizable or expense.');
    if (reasoning.length < 10) throw new UserError('Finance reasoning is required (at least 10 characters).');
    addStep(id, r.current_version, 'finance', 'approved', reasoning, input.classification, user.id);
    setStatus(id, 'approver_review', { classification: input.classification, reasoning });
    audit(user, 'finance.classified', 'request', id, id, { classification: input.classification, reasoning });
  } else if (action === 'return' || action === 'reject') {
    if (reasoning.length < 10) throw new UserError('A reason is required (at least 10 characters).');
    const decision = action === 'return' ? 'returned' : 'rejected';
    addStep(id, r.current_version, 'finance', decision, reasoning, null, user.id);
    setStatus(id, action === 'return' ? 'returned' : 'rejected');
    audit(user, 'finance.' + decision, 'request', id, id, { reasoning });
  } else {
    throw new UserError('Unknown action.');
  }
});

const approverDecide = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r) throw new UserError('Request not found.');
  if (r.status !== 'approver_review') throw new UserError('This request is not awaiting the approver.');
  if (user.role !== 'approver') throw new UserError('Only an approver can decide this step.');
  const reasoning = String(input.reasoning || '').trim();
  const action = input.action;

  if (action === 'approve_once' || action === 'approve_indefinitely') {
    if (action === 'approve_indefinitely' && r.type === 'adjustment') {
      throw new UserError('Adjustments cannot be approved indefinitely.');
    }
    const next = nextAfterApprover(r.submitter_role);
    if (next === 'second_signoff' && !secondSignoffUserId()) {
      throw new UserError('This request needs a second sign-off but none is configured. Ask an admin to set one.');
    }
    const scope = action === 'approve_once' ? 'once' : 'indefinite';
    addStep(id, r.current_version, 'approver', 'approved', reasoning, scope, user.id);
    setStatus(id, next, { scope });
    audit(user, 'approver.approved', 'request', id, id, { scope, reasoning, next });
    finalizeApproval(id, user);
  } else if (action === 'return' || action === 'reject') {
    if (reasoning.length < 10) throw new UserError('A reason is required (at least 10 characters).');
    const decision = action === 'return' ? 'returned' : 'rejected';
    addStep(id, r.current_version, 'approver', decision, reasoning, null, user.id);
    setStatus(id, action === 'return' ? 'returned' : 'rejected');
    audit(user, 'approver.' + decision, 'request', id, id, { reasoning });
  } else {
    throw new UserError('Unknown action.');
  }
});

const secondDecide = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r) throw new UserError('Request not found.');
  if (r.status !== 'second_signoff') throw new UserError('This request is not awaiting second sign-off.');
  if (user.id !== secondSignoffUserId()) throw new UserError('You are not the designated second sign-off.');
  if (r.submitter_id === user.id) throw new UserError('You cannot sign off on your own request.');
  const reasoning = String(input.reasoning || '').trim();

  if (input.action === 'approve') {
    addStep(id, r.current_version, 'second_signoff', 'approved', reasoning, null, user.id);
    setStatus(id, 'approved');
    audit(user, 'second_signoff.approved', 'request', id, id, { reasoning });
    finalizeApproval(id, user);
  } else if (input.action === 'return' || input.action === 'reject') {
    if (reasoning.length < 10) throw new UserError('A reason is required (at least 10 characters).');
    const decision = input.action === 'return' ? 'returned' : 'rejected';
    addStep(id, r.current_version, 'second_signoff', decision, reasoning, null, user.id);
    setStatus(id, input.action === 'return' ? 'returned' : 'rejected');
    audit(user, 'second_signoff.' + decision, 'request', id, id, { reasoning });
  } else {
    throw new UserError('Unknown action.');
  }
});

// Admin override: skip the step the request is currently waiting on.
const adminSkip = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r) throw new UserError('Request not found.');
  if (user.role !== 'admin') throw new UserError('Only admins can skip a step.');
  if (r.submitter_id === user.id) throw new UserError('You cannot skip steps on your own request.');
  if (!PENDING.includes(r.status)) throw new UserError('Nothing to skip.');
  const reasoning = String(input.reasoning || '').trim();
  if (reasoning.length < 10) throw new UserError('A reason for the override is required (at least 10 characters).');

  const stepName = { finance_review: 'finance', approver_review: 'approver', second_signoff: 'second_signoff' }[r.status];
  let next;
  if (r.status === 'finance_review') next = 'approver_review';
  else if (r.status === 'approver_review') next = nextAfterApprover(r.submitter_role);
  else next = 'approved';
  if (next === 'second_signoff' && !secondSignoffUserId()) {
    throw new UserError('The next step is a second sign-off, but none is configured.');
  }
  addStep(id, r.current_version, stepName, 'skipped', reasoning, 'admin override', user.id);
  setStatus(id, next);
  audit(user, 'admin.skipped_step', 'request', id, id, { step: stepName, reasoning, next });
});

const cancelRequest = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r) throw new UserError('Request not found.');
  const allowed = r.submitter_id === user.id || user.role === 'admin';
  if (!allowed) throw new UserError('You cannot cancel this request.');
  if (!PENDING.includes(r.status) && r.status !== 'returned') throw new UserError('This request can no longer be cancelled.');
  setStatus(id, 'cancelled');
  audit(user, 'request.cancelled', 'request', id, id, { reason: String(input.reason || '').trim() || null });
});

const submitResults = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r || r.submitter_id !== user.id) throw new UserError('Request not found.');
  const data = currentData(r);
  if (r.status !== 'approved' || r.type === 'adjustment') throw new UserError('Results cannot be submitted for this request.');
  if (todayIn(user.timezone) <= data.end_date) throw new UserError('Results can be submitted after the run ends.');
  const spend = parseMoney(input.actual_spend);
  if (spend == null || spend < 0) throw new UserError('Enter the actual spend as a number.');
  const notes = String(input.notes || '').trim();
  if (notes.length < 20) throw new UserError('Describe the results (at least 20 characters).');
  let deals = null;
  if (String(input.deals_count || '').trim() !== '') {
    deals = parseInt(input.deals_count, 10);
    if (isNaN(deals) || deals < 0) throw new UserError('Deals must be a whole number.');
  }
  db.prepare('INSERT INTO results (request_id, actual_spend, deals_count, notes, submitted_by) VALUES (?, ?, ?, ?, ?)').run(
    id,
    spend,
    deals,
    notes,
    user.id
  );
  setStatus(id, 'finalized');
  audit(user, 'results.submitted', 'request', id, id, { actual_spend: spend, deals_count: deals });
});

// ---------------------------------------------------------------- reports

function reportData(user, year) {
  const rows = db
    .prepare(
      `SELECT r.id, r.type, r.name, r.status, r.created_at, r.submitter_id, u.name AS submitter_name,
              v.data_json, res.actual_spend
       FROM requests r
       JOIN users u ON u.id = r.submitter_id
       JOIN request_versions v ON v.request_id = r.id AND v.version = r.current_version
       LEFT JOIN results res ON res.request_id = r.id
       WHERE r.status IN ('approved', 'finalized')
       ORDER BY r.id`
    )
    .all()
    .filter((r) => canView(user, r))
    .map((r) => {
      const data = JSON.parse(r.data_json);
      const month = (data.start_date || r.created_at.slice(0, 10)).slice(0, 7);
      const estimated = Number(data.estimated_spend) || 0;
      const actual = r.actual_spend == null ? null : r.actual_spend;
      return {
        id: r.id,
        type: r.type,
        name: r.name,
        submitter: r.submitter_name,
        month,
        estimated,
        actual,
        spend: actual == null ? estimated : actual,
      };
    })
    .filter((r) => r.month.startsWith(String(year)));

  const sumBy = (keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const cur = m.get(k) || { key: k, estimated: 0, actual: 0, spend: 0, count: 0 };
      cur.estimated += r.estimated;
      cur.actual += r.actual == null ? 0 : r.actual;
      cur.spend += r.spend;
      cur.count += 1;
      m.set(k, cur);
    }
    return [...m.values()];
  };

  const months = sumBy((r) => r.month).sort((a, b) => a.key.localeCompare(b.key));
  let running = 0;
  for (const m of months) {
    running += m.spend;
    m.cumulative = running;
  }
  return {
    months,
    bySubmitter: sumBy((r) => r.submitter).sort((a, b) => b.spend - a.spend),
    bySpif: rows.map((r) => ({ ...r })).sort((a, b) => b.spend - a.spend),
    total: rows.reduce((t, r) => t + r.spend, 0),
  };
}

module.exports = {
  UserError,
  TYPES,
  STATUS_LABELS,
  PENDING,
  TIMEZONES,
  GROUPS,
  PODS,
  TERM_FIELDS,
  termsOf,
  isValidTz,
  todayIn,
  validate,
  getRequest,
  getVersions,
  getSteps,
  attachmentsFor,
  currentData,
  canView,
  listRequests,
  queueFor,
  availableActions,
  displayStatus,
  secondSignoffUserId,
  createRequest,
  resubmitRequest,
  financeDecide,
  approverDecide,
  secondDecide,
  adminSkip,
  cancelRequest,
  submitResults,
  reportData,
};
