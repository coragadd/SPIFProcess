'use strict';
const { db } = require('./db');
const wf = require('./workflow');

// Slack routing. Every id comes from config, none is hardcoded:
//   SLACK_BOT_TOKEN              bot token (chat:write) used for channels and DMs
//   SLACK_FINANCE_CHANNEL_ID     where "needs finance action" goes
//   SLACK_COMMISSION_CHANNEL_ID  where "needs the commissions team" goes
//   users.slack_id               set per user in Admin; DMs go to the approver or the submitter
//   SLACK_WEBHOOK_URL            legacy finance-channel webhook, used only while no bot token is set
// Nothing is sent to the sales leadership channel. Sending never throws: a Slack outage must not
// block a submission or an approval.

function baseUrl(req) {
  return (
    process.env.APP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '') ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
}

function post(url, headers, payload, label) {
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) })
    .then(async (res) => {
      const body = res.ok && headers.Authorization ? await res.json().catch(() => ({})) : {};
      if (!res.ok || (headers.Authorization && !body.ok)) {
        console.error(`Slack notification to ${label} failed:`, res.status, body.error || '');
      }
    })
    .catch((e) => console.error(`Slack notification to ${label} failed:`, e.message));
}

// target is a channel ID or, for a DM, a user's Slack member ID.
function send(target, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !target) return;
  try {
    post((process.env.SLACK_API_URL || 'https://slack.com/api') + '/chat.postMessage', { Authorization: `Bearer ${token}` }, { channel: target, text }, target);
  } catch (e) {
    console.error('Slack notification failed:', e.message);
  }
}

function toFinance(text) {
  if (process.env.SLACK_BOT_TOKEN) return send(process.env.SLACK_FINANCE_CHANNEL_ID, text);
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  try {
    post(webhook, {}, { text }, 'finance webhook');
  } catch (e) {
    console.error('Slack notification failed:', e.message);
  }
}

const toCommission = (text) => send(process.env.SLACK_COMMISSION_CHANNEL_ID, text);

function dm(userId, text) {
  const u = db.prepare('SELECT slack_id FROM users WHERE id = ? AND active = 1').get(userId);
  if (u && u.slack_id) send(u.slack_id, text);
}

// The approvers assigned to this submitter (their tier 1 and tier 2 reports). Submitters with none
// assigned fall back to every higher-tier approver.
function approversFor(r) {
  const assigned = [r.submitter_tier1_id, r.submitter_tier2_id].filter(Boolean);
  if (assigned.length) {
    return db
      .prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${assigned.map(() => '?').join(',')}) ORDER BY tier`)
      .all(...assigned);
  }
  return db
    .prepare('SELECT id FROM users WHERE active = 1 AND tier <= 2 AND tier < ? ORDER BY tier')
    .all(r.submitter_tier);
}

// Call after anything that changes a request's status. Routes by where the request is now.
function notifyRequest(req, id) {
  try {
    const r = wf.getRequest(id);
    if (!r) return;
    const data = wf.currentData(r);
    const link = `<${baseUrl(req)}/requests/${r.id}|${r.name}>`;
    const type = wf.TYPES[r.type] || r.type;
    const concern = r.finance_concern ? `\n*Finance concern:* ${r.finance_concern}` : '';

    if (r.status === 'finance_review') {
      toFinance(`*${type} needs finance action:* ${link}\nSubmitted by ${r.submitter_name}`);
    } else if (r.status === 'approver_review') {
      for (const a of approversFor(r)) dm(a.id, `*${type} needs your approval:* ${link}\nSubmitted by ${r.submitter_name}${concern}`);
      dm(r.submitter_id, `Finance has reviewed your ${type} ${link}. It is now with the approver.${concern}`);
    } else if (r.status === 'approved' && data.bonus_kind === 'mbo') {
      // A monthly MBO is approved on submission and sends no Slack messages.
    } else if (r.status === 'approved') {
      const through = r.approval_scope === 'half_year' && r.approval_through ? ` through ${wf.halfYearLabel(r.approval_through)}` : '';
      dm(r.submitter_id, `Your ${type} ${link} was approved${through}.`);
      if (data.calculated_by === 'commissions') {
        toCommission(`*${type} approved, commissions team to calculate the payout amounts:* ${link}\nSubmitted by ${r.submitter_name}`);
      }
    } else if (r.status === 'returned' || r.status === 'rejected') {
      dm(r.submitter_id, `Your ${type} ${link} was ${r.status === 'returned' ? 'returned to you for changes' : 'rejected'}. Open it to see the reason.`);
    }
  } catch (e) {
    console.error('Slack notification failed:', e.message);
  }
}

// A submitter changed the winners and amounts after approval: the commissions team needs to know.
function notifyRepAmounts(req, id, user) {
  try {
    const r = wf.getRequest(id);
    if (!r || !['approved', 'finalized'].includes(r.status) || r.submitter_id !== user.id) return;
    toCommission(`*Rep amounts updated by ${user.name}:* <${baseUrl(req)}/requests/${r.id}|${r.name}>`);
  } catch (e) {
    console.error('Slack notification failed:', e.message);
  }
}

module.exports = { notifyRequest, notifyRepAmounts };
