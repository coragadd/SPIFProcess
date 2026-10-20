'use strict';
const wf = require('./workflow');

// Posts to the finance Slack channel via an incoming webhook. Never throws: a Slack outage
// must not block a submission.
function notifyFinance(req, id) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  try {
    const r = wf.getRequest(id);
    if (!r || r.status !== 'finance_review') return;
    const base = (
      process.env.APP_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '') ||
      `${req.protocol}://${req.get('host')}`
    ).replace(/\/+$/, '');
    const url = `${base}/requests/${r.id}`;
    const type = wf.TYPES[r.type] || r.type;
    const text = `*${type} awaiting finance approval:* ${r.name}\nSubmitted by ${r.submitter_name}\n<${url}|Review and approve>`;
    fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then((res) => {
        if (!res.ok) console.error('Slack notification failed:', res.status);
      })
      .catch((e) => console.error('Slack notification failed:', e.message));
  } catch (e) {
    console.error('Slack notification failed:', e.message);
  }
}

module.exports = { notifyFinance };
