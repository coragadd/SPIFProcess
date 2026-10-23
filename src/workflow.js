'use strict';
const crypto = require('crypto');
const { db, audit } = require('./db');

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
  second_signoff: 'Awaiting second sign-off (retired step; an admin can skip it)',
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

// Fields that define "how it works". Changing any of these voids a half-year approval.
// 'amounts' is still used by adjustments and by requests submitted before payout types existed.
const TERM_FIELDS = [
  'participants',
  'participants_group',
  'participants_pods',
  'participants_individual',
  'description',
  'payout_structure',
  'payout_flat',
  'payout_tier_count',
  'payout_tier_1',
  'payout_tier_2',
  'payout_tier_3',
  'payout_kpi',
  'payout_rate',
  'calculated_by',
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

const PAYOUT_TYPES = ['flat', 'tiered', 'calculated'];
const CALCULATORS = ['submitter', 'commissions'];
const PAYOUT_FIELDS = [
  'payout_flat',
  'payout_tier_count',
  'payout_tier_1',
  'payout_tier_2',
  'payout_tier_3',
  'payout_kpi',
  'payout_rate',
];

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

// A half-year approval runs to June 30 when given January through June, December 31 otherwise.
function halfYearEnd(today) {
  return Number(today.slice(5, 7)) <= 6 ? `${today.slice(0, 4)}-06-30` : `${today.slice(0, 4)}-12-31`;
}

function halfYearLabel(date) {
  return date.endsWith('-06-30') ? 'June 30' : 'December 31';
}

// Tiers 1 and 2 can approve; a user can approve only requests from a strictly higher tier number
// (tier 1 approves tier 2 and 3, tier 2 approves tier 3). Tier 3 cannot approve.
function isApprover(user) {
  return user.tier <= 2;
}

function canApprove(user, submitterTier) {
  return isApprover(user) && user.tier < submitterTier;
}

// Every request goes to finance first. Tier 1 submitters have no higher-tier approver, so for
// them finance's classification is the final step; everyone else then goes to an approver.
function afterFinance(submitterTier) {
  return submitterTier === 1 ? 'approved' : 'approver_review';
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

  const spend = parseMoney(s('estimated_spend'));
  if (spend == null || spend < 0) errors.estimated_spend = 'Enter the estimated total spend as a number.';
  d.estimated_spend = spend == null ? '' : spend;

  if (isAdj) {
    need('amounts', 'Payout amount');
    for (const k of PAYOUT_FIELDS) d[k] = '';
    d.calculated_by = '';
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
  d.amounts = '';
  for (const k of PAYOUT_FIELDS) d[k] = '';
  // Only the fields for the chosen payout type are kept.
  const payoutAmount = (k, label) => {
    const n = parseMoney(s(k));
    if (n == null || n <= 0) {
      errors[k] = `${label} must be a number greater than 0.`;
      return '';
    }
    return n;
  };
  d.payout_structure = s('payout_structure');
  if (d.payout_structure === 'flat') {
    d.payout_flat = payoutAmount('payout_flat', 'Payout amount');
  } else if (d.payout_structure === 'tiered') {
    const count = s('payout_tier_count');
    if (!['2', '3'].includes(count)) {
      errors.payout_tier_count = 'Choose 2 or 3 tiers. A single amount is a flat payout.';
    } else {
      d.payout_tier_count = Number(count);
      for (let i = 1; i <= d.payout_tier_count; i++) d['payout_tier_' + i] = payoutAmount('payout_tier_' + i, `Tier ${i} payout amount`);
    }
  } else if (d.payout_structure === 'calculated') {
    need('payout_kpi', 'KPI');
    d.payout_rate = payoutAmount('payout_rate', 'Rate');
  } else {
    errors.payout_structure = 'Choose a payout structure.';
  }

  d.calculated_by = s('calculated_by');
  if (!CALCULATORS.includes(d.calculated_by)) errors.calculated_by = 'Choose who will calculate the payout amounts.';

  // Required, and typed in the form: an attached document does not replace it.
  need('eligibility', 'Eligibility and measurement rules');
  // Edge cases are optional.
  d.edge_cases = s('edge_cases');

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
      `SELECT r.*, u.name AS submitter_name, u.role AS submitter_role, u.tier AS submitter_tier
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
  if (['admin', 'finance'].includes(user.role)) return true;
  if (r.submitter_id === user.id) return true;
  return canApprove(user, r.submitter_tier);
}

function listRequests(user) {
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS submitter_name, u.tier AS submitter_tier, v.data_json
       FROM requests r
       JOIN users u ON u.id = r.submitter_id
       JOIN request_versions v ON v.request_id = r.id AND v.version = r.current_version
       ORDER BY r.id DESC`
    )
    .all();
  return rows.filter((r) => canView(user, r)).map((r) => ({ ...r, data: JSON.parse(r.data_json) }));
}

function queueFor(user, rows) {
  return rows.filter(
    (r) =>
      (r.status === 'finance_review' && ['finance', 'admin'].includes(user.role) && r.submitter_id !== user.id) ||
      (r.status === 'approver_review' && canApprove(user, r.submitter_tier))
  );
}

function availableActions(user, r, data) {
  const pending = PENDING.includes(r.status);
  const self = user.id === r.submitter_id;
  const today = todayIn(user.timezone || 'America/New_York');
  return {
    finance: r.status === 'finance_review' && ['finance', 'admin'].includes(user.role) && !self,
    approver: r.status === 'approver_review' && canApprove(user, r.submitter_tier),
    skip: pending && user.role === 'admin' && !self,
    halfYearEnd: halfYearEnd(today),
    cancel: (pending || r.status === 'returned') && (self || user.role === 'admin'),
    edit: r.status === 'returned' && self,
    results:
      r.status === 'approved' && r.type !== 'adjustment' && self && !!data.end_date && today > data.end_date,
  };
}

// ---------------------------------------------------------------- rep amounts

// Admins can change what each rep will make, including after approval. The submitter can too, but
// only when they chose to calculate the amounts themselves (requests from before that choice
// existed have no value and stay editable by the submitter).
function canEditRepAmounts(user, r) {
  if (['cancelled', 'rejected'].includes(r.status)) return false;
  if (user.role === 'admin') return true;
  return r.submitter_id === user.id && currentData(r).calculated_by !== 'commissions';
}

// Rep picklist: these groups, in this order. Anyone whose POD is not listed (leadership,
// enablement, migration and so on) is left out of the picklist.
const REP_GROUPS = [
  { label: 'Red', pods: ['Red'] },
  { label: 'Blue', pods: ['Blue'] },
  { label: 'Green', pods: ['Green'] },
  { label: 'Black', pods: ['Black'] },
  { label: 'Expansion', pods: ['Expansion'] },
  { label: 'oBDR', pods: ['oBDR'] },
  { label: 'iBDR', pods: ['iBDR'] },
  { label: 'amBDR', pods: ['amBDR'] },
  { label: 'tBDR', pods: ['tBDR'] },
  { label: 'Merchant Services', pods: ['Merchant Services'] },
  { label: 'Customer Care', pods: ['Customer Care'] },
];

function getReps() {
  const rows = db.prepare('SELECT * FROM reps WHERE active = 1 ORDER BY name').all();
  const out = [];
  for (const g of REP_GROUPS) {
    for (const r of rows) if (g.pods.includes(r.pod)) out.push({ ...r, group: g.label });
  }
  return out;
}

function getRepAmounts(requestId) {
  return db.prepare('SELECT * FROM rep_amounts WHERE request_id = ? ORDER BY id').all(requestId);
}

function repAmountTotals() {
  const out = {};
  for (const row of db.prepare('SELECT request_id, SUM(amount) AS total FROM rep_amounts GROUP BY request_id').all()) {
    out[row.request_id] = row.total;
  }
  return out;
}

const saveRepAmounts = db.transaction((user, requestId, input) => {
  const r = getRequest(requestId);
  if (!r || !canEditRepAmounts(user, r)) throw new UserError('You cannot change the rep amounts on this request.');
  const names = [].concat(input.rep_name || []).map((v) => String(v).trim());
  const amounts = [].concat(input.rep_amount || []).map((v) => String(v).trim());
  const notes = [].concat(input.rep_note || []).map((v) => String(v).trim());
  const saved = getRepAmounts(requestId);
  // Names must come from the rep list. A name already on this request is kept even if that rep is
  // no longer on the list (entered before the list existed, or since deactivated).
  const known = new Map();
  for (const x of saved) known.set(x.rep_name.toLowerCase(), x.rep_name);
  for (const x of getReps()) known.set(x.name.toLowerCase(), x.name);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    if (!names[i] && !amounts[i] && !notes[i]) continue; // blank spare row
    if (!names[i]) throw new UserError(`Row ${i + 1}: choose a rep.`);
    const key = names[i].toLowerCase();
    if (!known.has(key)) throw new UserError(`${names[i]} is not on the rep list. Choose a rep from the dropdown.`);
    const name = known.get(key);
    const amount = parseMoney(amounts[i]);
    if (amount == null || amount < 0) throw new UserError(`${name}: enter the amount as a number, 0 or more.`);
    if (seen.has(key)) throw new UserError(`${name} is listed more than once.`);
    seen.add(key);
    rows.push({ rep_name: name, amount, note: notes[i] || null });
  }
  const before = saved.map((x) => ({ rep: x.rep_name, amount: x.amount, note: x.note }));
  const after = rows.map((x) => ({ rep: x.rep_name, amount: x.amount, note: x.note }));
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  db.prepare('DELETE FROM rep_amounts WHERE request_id = ?').run(requestId);
  const ins = db.prepare('INSERT INTO rep_amounts (request_id, rep_name, amount, note, updated_by) VALUES (?, ?, ?, ?, ?)');
  for (const x of rows) ins.run(requestId, x.rep_name, x.amount, x.note, user.id);
  db.prepare("UPDATE requests SET updated_at = datetime('now') WHERE id = ?").run(requestId);
  audit(user, 'rep_amounts.updated', 'request', requestId, requestId, { status: r.status, before, after });
  return true;
});

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
     approval_scope = COALESCE(?, approval_scope), approval_through = COALESCE(?, approval_through),
     updated_at = datetime('now') WHERE id = ?`
  ).run(status, e.classification || null, e.reasoning || null, e.scope || null, e.through || null, id);
}

// What a user's approve action means: this month only, or through the end of the half year.
function approvalScopeFor(user, r, wantsHalfYear) {
  if (!wantsHalfYear) return { scope: 'once', through: null };
  if (r.type === 'adjustment') throw new UserError('Adjustments can only be approved once.');
  return { scope: 'half_year', through: halfYearEnd(todayIn(user.timezone || 'America/New_York')) };
}

// A half-year approval is remembered as a standing approval for this SPIF's name and terms.
function recordStandingApproval(id, actor) {
  const r = getRequest(id);
  if (r.status !== 'approved' || r.approval_scope !== 'half_year') return;
  const data = currentData(r);
  const terms = JSON.stringify(termsOf(data));
  const hash = hashTerms(data, attachmentsFor(r.id, r.current_version));
  let saved = standingFor(r.name);
  if (saved) {
    db.prepare(
      `UPDATE saved_spifs SET terms_json = ?, terms_hash = ?, classification = ?, classification_reasoning = ?,
       approved_indefinitely = 0, approved_through = ?, approved_by = ?, approved_at = datetime('now'), active = 1,
       source_request_id = ?, source_version = ? WHERE id = ?`
    ).run(terms, hash, r.classification, r.classification_reasoning, r.approval_through, actor.id, r.id, r.current_version, saved.id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO saved_spifs (name, owner_id, type, terms_json, terms_hash, classification,
         classification_reasoning, approved_indefinitely, approved_through, approved_by, approved_at, source_request_id, source_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), ?, ?)`
      )
      .run(
        r.name,
        r.submitter_id,
        r.type,
        terms,
        hash,
        r.classification,
        r.classification_reasoning,
        r.approval_through,
        actor.id,
        r.id,
        r.current_version
      );
    saved = { id: info.lastInsertRowid };
  }
  db.prepare('UPDATE requests SET saved_spif_id = ? WHERE id = ?').run(saved.id, id);
  audit(actor, 'saved_spif.approved_half_year', 'saved_spif', saved.id, id, { name: r.name, through: r.approval_through });
}

function standingFor(name) {
  return db.prepare('SELECT * FROM saved_spifs WHERE name = ?').get(name);
}

// ---------------------------------------------------------------- recurring list

const RECURRING_TYPES = ['new_spif', 'recurring_spif', 'bonus'];

// Any approved (or finalized) SPIF can be resubmitted, newest request per name. Submitters see only
// their own; admin, finance and approvers see everyone's. Deactivated (revoked) names are hidden.
function recurringSources(user) {
  const privileged = ['admin', 'finance'].includes(user.role) || isApprover(user);
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS submitter_name, v.data_json
       FROM requests r
       JOIN users u ON u.id = r.submitter_id
       JOIN request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.type IN (${RECURRING_TYPES.map(() => '?').join(',')}) AND r.status IN ('approved', 'finalized')
       ORDER BY r.id DESC`
    )
    .all(...RECURRING_TYPES);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!privileged && r.submitter_id !== user.id) continue;
    const key = r.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const standing = standingFor(r.name);
    if (standing && !standing.active) continue;
    out.push({ ...r, data: JSON.parse(r.data_json), standing: standing && standing.approved_through ? standing : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Takes any request id for the SPIF and resolves to its newest approved run, so a link left open on
// an older run still works.
function recurringSource(user, requestId) {
  const asked = db.prepare('SELECT name FROM requests WHERE id = ?').get(Number(requestId));
  const found = asked && recurringSources(user).find((s) => s.name.toLowerCase() === asked.name.toLowerCase());
  if (!found) throw new UserError('That SPIF was not found.');
  return found;
}

// carried: attachment rows copied from a saved SPIF; uploaded: newly uploaded file records.
const createRequest = db.transaction((user, type, data, saved, uploaded, carried) => {
  if (!TYPES[type]) throw new UserError('Unknown request type.');
  const up = uploaded || [];
  const carry = carried || [];
  const hash = hashTerms(data, [...carry, ...up]);

  const info = db
    .prepare(
      `INSERT INTO requests (type, name, submitter_id, status, saved_spif_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(type, data.name, user.id, 'finance_review', saved ? saved.id : null);
  const id = Number(info.lastInsertRowid);
  db.prepare(
    'INSERT INTO request_versions (request_id, version, data_json, terms_hash, created_by) VALUES (?, 1, ?, ?, ?)'
  ).run(id, JSON.stringify(data), hash, user.id);
  saveAttachments(user, id, 1, carry, up);
  audit(user, 'request.submitted', 'request', id, id, { type, name: data.name, version: 1 });

  // Terms unchanged from a half-year approval that still covers the whole run: finance and approver
  // steps are covered. Everything else (a one-month approval, changed terms, a run past the
  // approval's end date) goes through full review again.
  if (
    type === 'recurring_spif' &&
    saved &&
    saved.active &&
    saved.approved_through &&
    saved.terms_hash === hash &&
    data.end_date <= saved.approved_through
  ) {
    const note = `Terms unchanged from saved SPIF #${saved.id}, approved through ${saved.approved_through}`;
    addStep(id, 1, 'finance', 'skipped', note, 'inherited classification: ' + (saved.classification || 'none'), null);
    addStep(id, 1, 'approver', 'skipped', note, 'half-year approval', null);
    setStatus(id, 'approved', {
      classification: saved.classification,
      reasoning: saved.classification_reasoning,
      scope: 'half_year',
      through: saved.approved_through,
    });
    audit(null, 'request.auto_approved_steps', 'request', id, id, { savedSpifId: saved.id, status: 'approved' });
  }
  return id;
});

const resubmitRequest = db.transaction((user, id, data, uploaded, carried) => {
  const r = getRequest(id);
  if (!r || r.submitter_id !== user.id) throw new UserError('Request not found.');
  if (r.status !== 'returned') throw new UserError('Only returned requests can be edited.');
  const version = r.current_version + 1;
  db.prepare(
    'INSERT INTO request_versions (request_id, version, data_json, terms_hash, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, version, JSON.stringify(data), hashTerms(data, [...(carried || []), ...(uploaded || [])]), user.id);
  saveAttachments(user, id, version, carried || [], uploaded || []);
  db.prepare(
    `UPDATE requests SET current_version = ?, name = ?, status = ?, classification = NULL,
     classification_reasoning = NULL, approval_scope = NULL, approval_through = NULL, finance_concern = NULL,
     updated_at = datetime('now') WHERE id = ?`
  ).run(version, data.name, 'finance_review', id);
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

  // Finance only classifies and passes the request on; it cannot return or reject it. It can flag a
  // concern, which stays on the request for the approver and the submitter to read.
  if (action === 'classify') {
    if (!['capitalizable', 'expense'].includes(input.classification)) throw new UserError('Choose capitalizable or expense.');
    if (reasoning.length < 10) throw new UserError('Finance reasoning is required (at least 10 characters).');
    let concern = null;
    if (input.has_concern) {
      concern = String(input.concern || '').replace(/\r\n/g, '\n').trim();
      if (!concern) throw new UserError('Describe the concern, or uncheck "Report a concern".');
    }
    const next = afterFinance(r.submitter_tier);
    // Tier 1 requests end here, so finance also picks the scope; otherwise the approver does.
    const { scope, through } =
      next === 'approved' ? approvalScopeFor(user, r, input.scope === 'half_year') : { scope: null, through: null };
    addStep(id, r.current_version, 'finance', 'approved', reasoning, input.classification, user.id);
    setStatus(id, next, { classification: input.classification, reasoning, scope, through });
    if (concern) db.prepare('UPDATE requests SET finance_concern = ? WHERE id = ?').run(concern, id);
    audit(user, 'finance.classified', 'request', id, id, {
      classification: input.classification,
      reasoning,
      concern,
      scope,
      through,
      next,
    });
    recordStandingApproval(id, user);
  } else {
    throw new UserError('Unknown action.');
  }
});

const approverDecide = db.transaction((user, id, input) => {
  const r = getRequest(id);
  if (!r) throw new UserError('Request not found.');
  if (r.status !== 'approver_review') throw new UserError('This request is not awaiting the approver.');
  if (!canApprove(user, r.submitter_tier)) {
    throw new UserError('You cannot approve requests from this submitter.');
  }
  const reasoning = String(input.reasoning || '').trim();
  const action = input.action;

  // One approver is enough: whoever acts first completes the step. If some SPIFs later need both
  // approvers, count the 'approved' rows in approval_steps for this version here instead of
  // approving on the first one.
  if (action === 'approve_once' || action === 'approve_half_year') {
    const { scope, through } = approvalScopeFor(user, r, action === 'approve_half_year');
    addStep(id, r.current_version, 'approver', 'approved', reasoning, through ? `${scope} through ${through}` : scope, user.id);
    setStatus(id, 'approved', { scope, through });
    audit(user, 'approver.approved', 'request', id, id, { scope, through, reasoning });
    recordStandingApproval(id, user);
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
  // Skipping finance moves a request on to its approver (tier 1 has none); skipping the approver completes it.
  const next = r.status === 'finance_review' ? afterFinance(r.submitter_tier) : 'approved';
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
      `SELECT r.id, r.type, r.name, r.status, r.created_at, r.submitter_id, u.name AS submitter_name, u.tier AS submitter_tier,
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
  PAYOUT_TYPES,
  TERM_FIELDS,
  halfYearEnd,
  halfYearLabel,
  recurringSources,
  recurringSource,
  standingFor,
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
  canEditRepAmounts,
  getReps,
  getRepAmounts,
  repAmountTotals,
  saveRepAmounts,
  displayStatus,
  isApprover,
  createRequest,
  resubmitRequest,
  financeDecide,
  approverDecide,
  adminSkip,
  cancelRequest,
  submitResults,
  reportData,
};
