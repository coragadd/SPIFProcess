'use strict';
// Monthly Slack reminders to submitters who still owe payout amounts for last month's SPIFs.
//   1st of the month: amounts are due by the 3rd.
//   3rd of the month: follow-up for anything still missing; the SPIF may not be applied to earnings.
// Triggered once a day by Vercel Cron (see vercel.json and the /cron/reminders route in server.js).
// The dates are read in America/New_York. Each kind is sent at most once per month, so a retried
// or duplicate cron call does nothing.
const { db, getSetting, setSetting } = require('./db');
const wf = require('./workflow');
const { dm, baseUrl } = require('./notify');

const TZ = 'America/New_York';

function priorMonth(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// Approved SPIFs and bonuses whose run ended in `month` (YYYY-MM), where the submitter calculates
// the amounts (when Rev Ops calculates them, the submitter has nothing to enter) and no rep amounts
// have been saved. Monthly MBOs and adjustments never apply: their amounts are set on submission.
async function missingAmounts(month) {
  const rows = await db
    .prepare(
      `SELECT r.id, r.name, r.submitter_id, u.name AS submitter_name, v.data_json
       FROM requests r
       JOIN users u ON u.id = r.submitter_id AND u.active = 1
       JOIN request_versions v ON v.request_id = r.id AND v.version = r.current_version
       WHERE r.status IN ('approved', 'finalized') AND r.type != 'adjustment'
         AND NOT EXISTS (SELECT 1 FROM rep_amounts a WHERE a.request_id = r.id)
       ORDER BY r.id`
    )
    .all();
  return rows.filter((r) => {
    const d = JSON.parse(r.data_json);
    return d.bonus_kind !== 'mbo' && d.calculated_by !== 'commissions' && String(d.end_date || '').slice(0, 7) === month;
  });
}

function monthName(month) {
  return `${wf.dateLabel(month + '-01').split(' ')[0]} ${month.slice(0, 4)}`;
}

// kind: 'first' or 'third'. Returns what was (or, with dry, would be) sent.
async function sendReminders(req, kind, today, dry) {
  const month = priorMonth(today);
  const key = `reminder:${today.slice(0, 7)}:${kind}`;
  if (!dry && (await getSetting(key))) return { kind, skipped: 'already sent this month' };
  const missing = await missingAmounts(month);
  const byPerson = new Map();
  for (const r of missing) byPerson.set(r.submitter_id, (byPerson.get(r.submitter_id) || []).concat(r));
  const base = baseUrl(req);
  const dueDay = `${wf.dateLabel(today.slice(0, 7) + '-03')}`;
  const out = [];
  for (const [id, list] of byPerson) {
    const items = list.map((r) => `• <${base}/requests/${r.id}|${r.name}>`).join('\n');
    const text =
      kind === 'first'
        ? `*Reminder: payout amounts are due by ${dueDay}.*\nThese ${monthName(month)} SPIFs don't have rep amounts yet:\n${items}\nOpen each one in Manage an Incentive, enter the amounts, and attach your calculations.`
        : `*Follow-up: payout amounts are still missing.*\nThese ${monthName(month)} SPIFs still have no rep amounts:\n${items}\nIf the amounts aren't submitted, they are at risk of not being applied to anyone's earnings.`;
    out.push({ submitter: list[0].submitter_name, spifs: list.map((r) => r.name) });
    if (!dry) await dm(id, text);
  }
  if (!dry) await setSetting(key, new Date().toISOString());
  return { kind, month, sentTo: out };
}

// opts.force ('first' | 'third') and opts.today (YYYY-MM-DD) are for testing; opts.dry sends nothing.
async function runReminders(req, opts = {}) {
  const today = opts.today || wf.todayIn(TZ);
  const day = Number(today.slice(8, 10));
  const kind = opts.force || (day === 1 ? 'first' : day === 3 ? 'third' : null);
  if (!kind) return { today, skipped: 'not the 1st or the 3rd' };
  return { today, ...(await sendReminders(req, kind, today, !!opts.dry)) };
}

module.exports = { runReminders, missingAmounts, monthName };
