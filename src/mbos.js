'use strict';
// MBO tracking: who owes an MBO for a month, and the Slack reminders for it. Admin-only.
// An entry is Submitted when an admin marked it by hand, or when the person has submitted at least
// `mbos_needed` MBOs for that month through the portal (MBO requests where they are the submitter).
// Reminders (Slack DMs via notify.dm, to the Slack member ID saved on the user):
//   first   the first day after month end
//   second  MBO_SECOND_REMINDER_DAYS days before the due date (default 2), through the due date
//   single  entries marked "single reminder": one reminder on the date chosen, nothing else
// Each is claimed in the database before it is sent, so a second run of the job never repeats it.
const { db, audit } = require('./db');
const wf = require('./workflow');
const { dm, baseUrl } = require('./notify');
const { monthName } = require('./reminders');

const { UserError } = wf;
const TZ = 'America/New_York';

function secondReminderDays() {
  const n = parseInt(process.env.MBO_SECOND_REMINDER_DAYS, 10);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
function validDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// A stored UTC timestamp as a date in the reminder time zone.
const dayOf = (ts) => new Date(/Z$/.test(ts) ? ts : String(ts).replace(' ', 'T') + 'Z').toLocaleDateString('en-CA', { timeZone: TZ });

const SELECT = `
  SELECT e.*, u.name AS user_name, u.active AS user_active,
    (SELECT COUNT(*) FROM requests r
       JOIN request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.submitter_id = e.user_id AND r.type = 'bonus' AND r.status IN ('approved', 'finalized')
         AND json_extract(v.data_json, '$.bonus_kind') = 'mbo'
         AND json_extract(v.data_json, '$.mbo_month') = e.month) AS submitted_count
  FROM mbo_expectations e
  JOIN users u ON u.id = e.user_id`;

function decorate(e) {
  const submitted = !!e.manual_submitted || e.submitted_count >= e.mbos_needed;
  const stage = e.single_reminder
    ? e.reminder1_sent_at ? 'Single reminder sent' : 'Not sent'
    : e.reminder2_sent_at ? 'Second sent' : e.reminder1_sent_at ? 'First sent' : 'Not sent';
  return { ...e, submitted, reminderStatus: stage };
}

async function listForMonth(month) {
  return (await db.prepare(SELECT + ' WHERE e.month = ? ORDER BY u.name').all(month)).map(decorate);
}

// ------------------------------------------------------------------ editing

function cleanFields(input) {
  const dueDate = String(input.due_date || '').trim();
  if (!validDate(dueDate)) throw new UserError('A due date is required.');
  const needed = Number(input.mbos_needed);
  if (!Number.isInteger(needed) || needed < 1 || needed > 50) throw new UserError('MBOs needed must be a whole number from 1 to 50.');
  const single = input.single_reminder === '1' ? 1 : 0;
  const singleDate = String(input.single_reminder_date || '').trim();
  if (single && !validDate(singleDate)) throw new UserError('Choose the date to send the single reminder on.');
  return { dueDate, needed, single, singleDate: single ? singleDate : null };
}

async function createEntries(actor, input) {
  const month = String(input.month || '');
  if (!validMonth(month)) throw new UserError('Choose the month.');
  const ids = [...new Set([].concat(input.user_ids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new UserError('Select at least one person.');
  const f = cleanFields({ ...input, single_reminder: '0' });
  let added = 0;
  const skipped = [];
  for (const id of ids) {
    const u = await db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(id);
    if (!u) continue;
    const info = await db
      .prepare('INSERT OR IGNORE INTO mbo_expectations (user_id, month, due_date, mbos_needed, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(id, month, f.dueDate, f.needed, actor.id);
    if (info.changes) {
      added++;
      await audit(actor, 'mbo_entry.created', 'mbo_expectation', info.lastInsertRowid, null, { user: u.name, month, due_date: f.dueDate, mbos_needed: f.needed });
    } else skipped.push(u.name);
  }
  return { added, skipped };
}

async function getEntry(id) {
  const e = await db.prepare(SELECT + ' WHERE e.id = ?').get(id);
  return e ? decorate(e) : null;
}

async function updateEntry(actor, id, input) {
  const e = await getEntry(id);
  if (!e) throw new UserError('Entry not found.');
  const f = cleanFields(input);
  await db
    .prepare('UPDATE mbo_expectations SET due_date = ?, mbos_needed = ?, single_reminder = ?, single_reminder_date = ? WHERE id = ?')
    .run(f.dueDate, f.needed, f.single, f.singleDate, id);
  await audit(actor, 'mbo_entry.updated', 'mbo_expectation', id, null, {
    user: e.user_name,
    month: e.month,
    before: { due_date: e.due_date, mbos_needed: e.mbos_needed, single_reminder: e.single_reminder, single_reminder_date: e.single_reminder_date },
    after: { due_date: f.dueDate, mbos_needed: f.needed, single_reminder: f.single, single_reminder_date: f.singleDate },
  });
  return e;
}

async function setManualSubmitted(actor, id, value) {
  const e = await getEntry(id);
  if (!e) throw new UserError('Entry not found.');
  await db.prepare('UPDATE mbo_expectations SET manual_submitted = ? WHERE id = ?').run(value ? 1 : 0, id);
  await audit(actor, value ? 'mbo_entry.marked_submitted' : 'mbo_entry.marked_owed', 'mbo_expectation', id, null, { user: e.user_name, month: e.month });
  return e;
}

async function deleteEntry(actor, id) {
  const e = await getEntry(id);
  if (!e) throw new UserError('Entry not found.');
  await db.prepare('DELETE FROM mbo_expectations WHERE id = ?').run(id);
  await audit(actor, 'mbo_entry.deleted', 'mbo_expectation', id, null, { user: e.user_name, month: e.month, due_date: e.due_date });
  return e;
}

// ------------------------------------------------------------------ reminders

function message(req, e) {
  const left = e.mbos_needed - e.submitted_count;
  const more = e.mbos_needed > 1 && left > 0 ? ` You still need to submit ${left} of ${e.mbos_needed}.` : '';
  return (
    `*${monthName(e.month)} MBO due ${wf.dateLabel(e.due_date)}.*\n` +
    `MBOs that aren't submitted aren't calculated.${more}\n` +
    `<${baseUrl(req)}/requests/new?type=mbo|Submit your MBO>`
  );
}

// Which scheduled reminder (if any) an unsubmitted entry is due for on `today` (YYYY-MM-DD).
function dueKind(e, today) {
  const sentToday = [e.reminder1_sent_at, e.reminder2_sent_at].some((ts) => ts && dayOf(ts) === today);
  if (sentToday) return null; // never two on one day, even if the job runs twice
  if (e.single_reminder) return !e.reminder1_sent_at && e.single_reminder_date && today >= e.single_reminder_date ? 'single' : null;
  if (!e.reminder1_sent_at && today >= wf.firstOfNextMonth(e.month + '-01')) return 'first';
  if (!e.reminder2_sent_at && today >= addDays(e.due_date, -secondReminderDays()) && today <= e.due_date) return 'second';
  return null;
}

// Claims the reminder in the database first (so a concurrent or repeated run skips it), then sends.
// If Slack could not deliver it, the claim is released so the next run tries again.
async function sendScheduled(req, e, kind) {
  const col = kind === 'second' ? 'reminder2_sent_at' : 'reminder1_sent_at';
  const claim = await db.prepare(`UPDATE mbo_expectations SET ${col} = ? WHERE id = ? AND ${col} IS NULL`).run(new Date().toISOString(), e.id);
  if (!claim.changes) return false;
  if (!(await dm(e.user_id, message(req, e)))) {
    await db.prepare(`UPDATE mbo_expectations SET ${col} = NULL WHERE id = ?`).run(e.id);
    return false;
  }
  await audit(null, 'mbo_reminder.sent', 'mbo_expectation', e.id, null, { user: e.user_name, month: e.month, kind });
  return true;
}

// opts.today (YYYY-MM-DD) is for testing; opts.dry lists what would be sent without sending.
async function runMboReminders(req, opts = {}) {
  const today = opts.today || wf.todayIn(TZ);
  const open = await db
    .prepare(
      SELECT +
        ` WHERE e.manual_submitted = 0 AND u.active = 1
          AND (e.reminder1_sent_at IS NULL OR (e.single_reminder = 0 AND e.reminder2_sent_at IS NULL))`
    )
    .all();
  const out = { sent: [], notDelivered: [] };
  for (const row of open) {
    const e = decorate(row);
    if (e.submitted) continue;
    const kind = dueKind(e, today);
    if (!kind) continue;
    const item = { person: e.user_name, month: e.month, kind };
    if (opts.dry) out.sent.push(item);
    else (await sendScheduled(req, e, kind) ? out.sent : out.notDelivered).push(item);
  }
  return { today, secondReminderDaysBefore: secondReminderDays(), ...out };
}

// The "send reminder now" button. Independent of the scheduled reminders (it does not use up either one).
async function sendNow(req, actor, id) {
  const e = await getEntry(id);
  if (!e) throw new UserError('Entry not found.');
  if (e.submitted) throw new UserError(`${e.user_name} has already submitted, so no reminder was sent.`);
  if (!(await dm(e.user_id, message(req, e)))) {
    throw new UserError(`The reminder to ${e.user_name} could not be sent. Check that they have a Slack member ID in Admin and that the Slack bot token is set.`);
  }
  await db.prepare('UPDATE mbo_expectations SET manual_reminder_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  await audit(actor, 'mbo_reminder.sent_now', 'mbo_expectation', id, null, { user: e.user_name, month: e.month });
  return e;
}

module.exports = {
  validMonth,
  secondReminderDays,
  listForMonth,
  createEntries,
  updateEntry,
  setManualSubmitted,
  deleteEntry,
  sendNow,
  runMboReminders,
};
