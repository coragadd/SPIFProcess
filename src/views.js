'use strict';
const {
  TYPES,
  FORM_TYPES,
  STATUS_LABELS,
  TIMEZONES,
  GROUPS,
  PODS,
  displayStatus,
  dateLabel,
  todayIn,
  typeLabel,
  firstOfNextMonth,
  canSeeReports,
} = require('./workflow');

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function money(n) {
  const v = Number(n);
  if (n === '' || n == null || isNaN(v)) return '';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTs(ts, tz) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  try {
    return d.toLocaleString('en-US', { timeZone: tz || 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return String(ts);
  }
}

const ROLE_LABELS = { submitter: 'Standard', finance: 'Finance (Classifier)', finance_viewer: 'Finance (Viewer)', admin: 'Admin' };
// The role shown and edited for a user: finance viewers are a flavor of the finance role.
const roleKey = (u) => (u.role === 'finance' && u.finance_viewer ? 'finance_viewer' : u.role);
const TIER_LABELS = {
  1: 'Tier 1 (requests and approves)',
  2: 'Tier 2 (requests and approves)',
  3: 'Tier 3 (requests only)',
};
// Payout types offered on the form. 'flat_rate' only appears on requests from before these existed.
const PAYOUT_TYPES = [
  ['flat', 'Flat payout'],
  ['ranked', 'Ranked payout'],
  ['calculated', 'Calculated payout'],
];
const PAYOUT_LABELS = { ...Object.fromEntries(PAYOUT_TYPES), flat_rate: 'Flat rate' };
const CALCULATOR_LABELS = { commissions: 'RevOps', submitter: 'Submitter' };

// The Quilt mark: three stacked diamonds (sky on top, plum below, a small navy one in the middle).
const LOGO = `<svg class="logo" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
  <polygon points="16,13 25,22 16,31 7,22" fill="var(--plum)"/>
  <polygon points="16,1 25,10 16,19 7,10" fill="var(--sky)"/>
  <polygon points="16,9.5 20.5,14 16,18.5 11.5,14" fill="var(--navy)"/>
</svg>`;

// A small "?" that shows its text on hover or keyboard focus.
const tipHtml = (text) => `<button type="button" class="tip" data-tip="${esc(text)}" aria-label="${esc(text)}">?</button>`;

const ADJUSTMENT_GUIDE =
  'Adjustment guide: adjustments are treated as expenses by default.';

function csrfField(ctx) {
  return `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;
}

function page(ctx, title, body) {
  const u = ctx.user;
  const nav = u
    ? `<nav class="topnav">
        <a class="brand" href="/">${LOGO}<span>Quilt Software</span></a>
        <a href="/">Home</a>
        <a href="/request">Request</a>
        <a href="/requests">Manage</a>
        ${canSeeReports(u) ? '<a href="/reports">Reports</a>' : ''}
        ${u.role !== 'submitter' || u.tier <= 2 ? '<a href="/audit">Audit log</a>' : ''}
        ${u.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
        <span class="spacer"></span>
        <a href="/account">${esc(u.name)} (${esc(ROLE_LABELS[roleKey(u)])})</a>
        <form method="post" action="/logout" class="inline">${csrfField(ctx)}<button class="link">Sign out</button></form>
      </nav>`
    : '';
  // Shown on every page while an admin is viewing as someone else. Changes are turned off meanwhile.
  const viewAs = ctx.viewAs
    ? `<div class="viewas"><span><strong>Viewing as ${esc(u.name)} (${esc(ROLE_LABELS[roleKey(u)])}${u.role === 'submitter' ? ', tier ' + esc(u.tier) : ''}).</strong>
        Read-only: you are signed in as ${esc(ctx.viewAs.realName)} (admin), and nothing can be changed in this mode.</span>
        <form method="post" action="/view-as/stop" class="inline">${csrfField(ctx)}<button class="chip">Exit View as</button></form></div>`
    : '';
  const flash = ctx.flash ? `<div class="flash ${esc(ctx.flash.type)}">${esc(ctx.flash.msg)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | Sales Incentive Manager</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/static/styles.css">
</head><body>${viewAs}${nav}<main class="container">${flash}${body}</main><script src="/static/app.js"></script></body></html>`;
}

// ------------------------------------------------------------ form helpers

function fieldWrap(name, label, hint, errors, inner, tip) {
  return `<div class="field${errors[name] ? ' has-error' : ''}">
    <label for="${name}">${esc(label)}${tip ? tipHtml(tip) : ''}</label>
    ${inner}
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    ${errors[name] ? `<div class="err">${esc(errors[name])}</div>` : ''}
  </div>`;
}

function input(name, label, values, errors, o) {
  const opt = o || {};
  const inner = `<input id="${name}" name="${name}" type="${opt.type || 'text'}" value="${esc(values[name])}"${
    opt.readonly ? ' readonly' : ''
  }${opt.step ? ` step="${opt.step}"` : ''}${opt.min ? ` min="${opt.min}"` : ''}${opt.max ? ` max="${opt.max}"` : ''}>`;
  return fieldWrap(name, label, opt.hint, errors, inner, opt.tip);
}

function textarea(name, label, values, errors, o) {
  const opt = o || {};
  const inner = `<textarea id="${name}" name="${name}" rows="${opt.rows || 4}">${esc(values[name])}</textarea>`;
  return fieldWrap(name, label, opt.hint, errors, inner, opt.tip);
}

function select(name, label, values, errors, options, o) {
  const opt = o || {};
  const inner = `<select id="${name}" name="${name}">
    <option value="">Select...</option>
    ${options
      .map(([v, l]) => `<option value="${esc(v)}"${String(values[name]) === String(v) ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}
  </select>`;
  return fieldWrap(name, label, opt.hint, errors, inner, opt.tip);
}

// The supporting document: an optional shareable SharePoint link (what marketing needs). New file
// uploads are no longer offered; files uploaded to earlier versions are still listed so they can be kept.
function supportingDocFields(values, errors, existing, keptIds) {
  return `${input('supporting_link', 'Link a supporting document (optional)', values, errors, {
    type: 'url',
    hint: 'Use a shareable SharePoint link (anyone at Quilt can view). Marketing needs access to it, so check the link opens without a request for permission.',
  })}${previousFiles(existing, keptIds)}`;
}

function previousFiles(existing, keptIds) {
  if (!(existing || []).length) return '';
  const ids = keptIds || [];
  const kept = existing
    .map(
      (a) =>
        `<label class="check"><input type="checkbox" name="keep_files" value="${a.id}"${
          ids.includes(String(a.id)) ? ' checked' : ''
        }> <a href="/attachments/${a.id}">${esc(a.original_name)}</a></label>`
    )
    .join('<br>');
  return `<div class="field">
    <label>Files uploaded earlier</label>
    <div>${kept}</div>
    <div class="hint">These were uploaded before the form moved to links. They stay attached unless you uncheck them. New files can no longer be uploaded; use the link above.</div>
  </div>`;
}

function attachmentLinks(files) {
  return (files || []).map((a) => `<a href="/attachments/${a.id}">${esc(a.original_name)}</a>`).join('<br>');
}

// Rep dropdown grouped by team. repList arrives already ordered by group, so keep first-seen order.
function repPicker(name, repList, selected, id) {
  const byGroup = new Map();
  for (const p of repList) byGroup.set(p.group, (byGroup.get(p.group) || []).concat(p));
  const opt = (n) => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`;
  const groups = [...byGroup].map(
    ([group, list]) => `<optgroup label="${esc(group)}">${list.map((p) => opt(p.name)).join('')}</optgroup>`
  );
  // Keep a name that was saved earlier but is not on the list, so editing does not drop it.
  const orphan = selected && !repList.some((p) => p.name === selected) ? `<optgroup label="Not on rep list">${opt(selected)}</optgroup>` : '';
  return `<select name="${name}"${id ? ` id="${id}"` : ''}><option value="">Select a rep...</option>${groups.join('')}${orphan}</select>`;
}

function participantsFields(values, errors, label) {
  const group = values.participants_group || '';
  let picked = [].concat(values.participants_pods || []).map(String);
  if (picked.includes('All PODs')) picked = PODS;
  const boxes = PODS.map(
    (p) =>
      `<label class="check"><input type="checkbox" name="participants_pods" value="${esc(p)}"${
        picked.includes(p) ? ' checked' : ''
      }> ${esc(p)}</label>`
  ).join('');
  return `${select('participants_group', label, values, errors, GROUPS.map((g) => [g, g]))}
    <div class="field${errors.participants_pods ? ' has-error' : ''}" id="pods-wrap"${group === 'AEs' ? '' : ' hidden'}>
      <label>POD (select one or more)</label>
      <div class="checks">${boxes}</div>
      ${errors.participants_pods ? `<div class="err">${esc(errors.participants_pods)}</div>` : ''}
    </div>
    <div id="individual-wrap"${group === 'Individual' ? '' : ' hidden'}>
      ${input('participants_individual', "Individual's name", values, errors)}
    </div>`;
}

// ------------------------------------------------------------ pages

function login(ctx, error, opts = {}) {
  const { sso = false, breakGlass = false } = opts;
  const passwordForm = `<form method="post" action="/login" class="panel narrow">
      ${csrfField(ctx)}
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn">Sign in</button>
    </form>`;
  return page(
    ctx,
    'Sign in',
    `<div class="login">
    <h1>Sales Incentive Manager</h1>
    <p class="subtitle">Sign in to request, manage, and review incentives.</p>
    ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
    ${sso ? '<p><a class="btn" href="/auth/microsoft">Sign in with Microsoft</a></p>' : ''}
    ${!sso || breakGlass ? passwordForm : ''}
    </div>`
  );
}

function home(ctx, pendingCount) {
  const u = ctx.user;
  const banner = pendingCount
    ? `<a class="banner" href="/requests">${pendingCount} request${pendingCount === 1 ? '' : 's'} waiting for your action &rarr;</a>`
    : '';
  return page(
    ctx,
    'Home',
    `<h1>Sales Incentive Manager</h1>
    <p class="subtitle">What would you like to do?</p>
    ${banner}
    <nav class="options">
      <a class="card" href="/request"><h2>Request an Incentive</h2><p>Submit a new SPIF, recurring SPIF, bonus, or adjustment.</p></a>
      <a class="card" href="/requests"><h2>Manage an Incentive</h2><p>Track, review, approve, and report results on requests.</p></a>
      ${canSeeReports(u) ? '<a class="card" href="/reports"><h2>View Reports <span class="pill soon">Coming soon</span></h2><p>Spend by submitter, SPIF, and month.</p></a>' : ''}
    </nav>
    ${u.role === 'admin' ? '<p><a href="/admin">Open the admin portal</a></p>' : ''}`
  );
}

function requestChooser(ctx) {
  return page(
    ctx,
    'Request an Incentive',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Request an Incentive</h1>
    <p class="subtitle">Nothing runs without a complete request and the right approvals.</p>
    <nav class="options">
      <a class="card" href="/requests/new?type=new_spif"><h2>New SPIF</h2><p>A SPIF that has not run before.</p></a>
      <a class="card" href="/saved"><h2>Recurring SPIF</h2><p>Pick a saved SPIF and resubmit it with new dates.</p></a>
      <a class="card" href="/requests/new?type=bonus"><h2>Bonus</h2><p>A regular bonus. It goes through finance and approval.</p></a>
      <a class="card" href="/requests/new?type=mbo"><h2>MBO</h2><p>One rep and one amount. No approval needed.</p></a>
      <a class="card" href="/requests/new?type=adjustment"><h2>Adjustment</h2><p>A commission adjustment, on a deal, a component, or neither.</p></a>
    </nav>`
  );
}

function requestForm(ctx, o) {
  const { type, values, errors, action, submitLabel, savedId, lockName, requestId, existingFiles, keptIds } = o;
  const isAdj = type === 'adjustment';
  const isMbo = type === 'mbo';
  const hidden = `${csrfField(ctx)}<input type="hidden" name="type" value="${esc(type)}">${
    savedId ? `<input type="hidden" name="saved_id" value="${esc(savedId)}">` : ''
  }`;
  const errorList = Object.keys(errors).length
    ? `<div class="flash error">Please fix the highlighted fields before submitting.</div>`
    : '';

  const common = `
    ${input('name', 'Name', values, errors, { readonly: lockName, tip: lockName ? 'Saved recurring SPIF name.' : 'Must be distinct from every other request.' })}
    ${participantsFields(values, errors, isAdj ? 'Person or team receiving the adjustment' : 'People or team involved')}
    ${textarea('description', isAdj ? 'Description' : 'Detailed description of how it works', values, errors, {
      rows: 6,
      tip: `Minimum ${isAdj ? 20 : 50} characters. Be specific enough that finance and the approver can understand it without asking you questions.`,
    })}`;

  const adjFields = `
    <div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>
    ${input('deal', 'Deal or component (optional)', values, errors, { hint: 'Leave blank if the adjustment is not tied to a specific deal or component.' })}
    ${textarea('adjustment_reason', 'Reason for the adjustment', values, errors)}
    ${input('amounts', 'Payout amount', values, errors, { hint: 'e.g. $450 commission adjustment' })}`;

  const payoutGroup = (key, inner) =>
    `<div data-payout-group="${key}"${values.payout_structure === key ? '' : ' hidden'}>${inner}</div>`;
  const rankCount = Math.min(Math.max(parseInt(values.payout_rank_count, 10) || 2, 2), 50);
  const rankValues = [].concat(values.payout_rank || values.payout_ranks || []);
  const rankInputs = Array.from(
    { length: rankCount },
    (_, i) => `<div class="field"><label>Rank ${i + 1} payout amount ($)</label>
      <input name="payout_rank" type="number" step="0.01" value="${esc(rankValues[i])}"></div>`
  ).join('');
  const spifFields = `
    ${values.amounts ? `<div class="flash info"><strong>Previous payout amounts:</strong> <span class="pre">${esc(values.amounts)}</span><br>Enter them in the payout fields below.</div>` : ''}
    <details class="info">
      <summary>What do the payout structures mean?</summary>
      <ul>
        <li><strong>Flat payout:</strong> one amount per winner. Example: $300.</li>
        <li><strong>Ranked payout:</strong> a competition between reps. Reps are ranked on a result and each paid rank gets its own amount; you choose how many ranks are paid (2 or more). Example: 1st place $500, 2nd place $200.</li>
        <li><strong>Calculated payout:</strong> the amount depends on a KPI. Example: KPI = demos attended, rate = $20 per demo.</li>
      </ul>
    </details>
    ${select('payout_structure', 'Payout structure', values, errors, PAYOUT_TYPES)}
    ${payoutGroup('flat', input('payout_flat', 'Payout amount ($)', values, errors, { type: 'number', step: '0.01' }))}
    ${payoutGroup(
      'ranked',
      `${input('payout_rank_count', 'How many ranks are paid?', values, errors, { type: 'number', min: '2', max: '50', step: '1', hint: 'Enter 2 or more. One rank is a flat payout.' })}
      <div id="rank-amounts">${rankInputs}</div>
      ${errors.payout_ranks ? `<div class="err">${esc(errors.payout_ranks)}</div>` : ''}`
    )}
    ${payoutGroup(
      'calculated',
      `${input('payout_kpi', 'KPI', values, errors, { hint: 'What the payout is based on, e.g. demos attended.' })}
      ${input('payout_rate', 'Rate ($ per unit of the KPI)', values, errors, { type: 'number', step: '0.01', hint: 'e.g. 20 for $20 per demo.' })}`
    )}
    ${select('calculated_by', 'Who will calculate the payout amounts?', values, errors, Object.entries(CALCULATOR_LABELS), {
      tip: 'If you calculate them, you enter the winners and payout amounts later in Manage Incentives.',
    })}
    ${input('estimated_spend', 'Estimated total spend ($)', values, errors, { type: 'number', step: '0.01' })}
    <div class="row">
      ${input('start_date', 'Start date', values, errors, {
        type: 'date',
        min: firstOfNextMonth(todayIn(ctx.user.timezone || 'America/New_York')),
        hint: 'The current month is blocked. The earliest start date is the 1st of next month.',
      })}
      ${input('end_date', 'End date', values, errors, { type: 'date', hint: 'Required. Must be in the same month as the start date.' })}
    </div>
    <div class="row">
      ${input('announce_date', 'Date announced to the team', values, errors, { type: 'date' })}
      ${input('announce_method', 'How it will be announced', values, errors, { tip: 'e.g. email, all-hands, Slack' })}
    </div>
    ${textarea('eligibility', 'Eligibility and measurement rules', values, errors, { hint: 'Required. Who qualifies and exactly how the payout is earned and measured.' })}
    ${supportingDocFields(values, errors, existingFiles, keptIds)}
    ${textarea('edge_cases', 'Edge cases (optional)', values, errors, {
      hint: 'Think of one-off cases that may require exceptions, and say how each would be handled.',
    })}`;

  // A bonus is a normal request plus the commission plan question. The Monthly MBO is its own short
  // form that skips approval.
  const regularRecurring = type === 'recurring_spif' && values.bonus_kind === 'regular';
  const commissionPlan =
    type === 'bonus' || regularRecurring
      ? select('commission_plan', 'Does this need to be written into the commission plan?', values, errors, [['yes', 'Yes'], ['no', 'No']])
      : '';
  const mboFields = `
    <div class="flash info">The MBO is approved when you submit it. Choose the rep, the amount and the month.</div>
    <div class="field${errors.mbo_rep ? ' has-error' : ''}"><label for="mbo_rep">Rep</label>${repPicker('mbo_rep', o.reps || [], values.mbo_rep, 'mbo_rep')}${errors.mbo_rep ? `<div class="err">${esc(errors.mbo_rep)}</div>` : ''}</div>
    ${input('mbo_amount', 'Amount ($)', values, errors, { type: 'number', step: '0.01' })}
    ${input('mbo_month', 'Month', values, errors, { type: 'month' })}
    ${textarea('mbo_description', 'Description (optional)', values, errors, { rows: 3 })}`;

  return page(
    ctx,
    FORM_TYPES[type],
    `<a class="back" href="${requestId ? '/requests/' + requestId : '/request'}">&larr; Back</a>
    <h1>${requestId ? 'Edit and resubmit: ' : ''}${esc(FORM_TYPES[type])}</h1>
    ${errorList}
    <form method="post" action="${esc(action)}" class="panel" enctype="multipart/form-data"${type === 'bonus' || regularRecurring ? ' data-bonus="1"' : ''}>
      ${hidden}
      ${regularRecurring ? '<input type="hidden" name="bonus_kind" value="regular">' : ''}
      ${isMbo ? mboFields : `${common}${isAdj ? adjFields : spifFields}${commissionPlan}`}
      <button class="btn">${esc(submitLabel)}</button>
    </form>`
  );
}

function termsTable(data, type, files) {
  const rows = [];
  const add = (label, val) => {
    if (val !== '' && val != null) rows.push(`<tr><th>${esc(label)}</th><td class="pre">${esc(val)}</td></tr>`);
  };
  if (data.bonus_kind === 'mbo') {
    add('Bonus type', 'MBO (no approval needed)');
    add('Rep', data.mbo_rep);
    add('Amount', money(data.mbo_amount));
    add('Month', data.mbo_month);
    add('Description', data.description);
    return `<table class="kv">${rows.join('')}</table>`;
  }
  if (data.bonus_kind === 'regular') add('Bonus type', 'Regular bonus');
  add('Participants', data.participants);
  add('Description', data.description);
  if (type === 'adjustment') {
    add('Deal or component', data.deal);
    add('Reason', data.adjustment_reason);
  } else {
    add('Payout structure', PAYOUT_LABELS[data.payout_structure] || data.payout_structure);
    if (data.payout_structure === 'flat') add('Payout amount', money(data.payout_flat));
    if (data.payout_structure === 'ranked') {
      [].concat(data.payout_ranks || []).forEach((amt, i) => add(`Rank ${i + 1} payout amount`, money(amt)));
    }
    if (data.payout_structure === 'calculated') {
      add('KPI', data.payout_kpi);
      add('Rate', data.payout_rate === '' ? '' : money(data.payout_rate) + ' per unit of the KPI');
    }
    add('Amounts calculated by', CALCULATOR_LABELS[data.calculated_by]);
    if (data.bonus_kind === 'regular') add('Written into the commission plan', data.commission_plan === 'yes' ? 'Yes' : 'No');
  }
  add('Payout amounts', data.amounts);
  add('Estimated total spend', money(data.estimated_spend));
  if (type !== 'adjustment') {
    if (data.start_date) add('Run dates', `${data.start_date} to ${data.end_date}`);
    if (data.announce_date) add('Announced', `${data.announce_date} via ${data.announce_method}`);
    add('Eligibility and measurement', data.eligibility);
    if (data.supporting_link) {
      const safe = /^https?:\/\//i.test(data.supporting_link) ? data.supporting_link : '';
      rows.push(`<tr><th>Supporting document link</th><td>${safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(safe)}</a>` : esc(data.supporting_link)}</td></tr>`);
    }
    if (files && files.length) rows.push(`<tr><th>Attached documents</th><td>${attachmentLinks(files)}</td></tr>`);
    add('Edge cases', data.edge_cases);
  }
  return `<table class="kv">${rows.join('')}</table>`;
}

function scopeLabel(r) {
  if (r.approval_scope === 'once') return 'approved once';
  if (r.approval_scope === 'quarter' || r.approval_scope === 'half_year') {
    return r.approval_through ? `approved through ${dateLabel(r.approval_through)} (${r.approval_through})` : 'approved through the end of the quarter';
  }
  return 'approved indefinitely (old approval type)';
}

// A status pill: white text on the status colour (see .pill in styles.css).
function statusBadge(r, data, tz) {
  return `<span class="pill s-${esc(r.status)}">${esc(displayStatus(r, data, tz))}</span>`;
}

// Who made a decision, with "(admin)" when an admin acted on someone's behalf.
const byLine = (name, byAdmin) => `${esc(name || 'system')}${byAdmin ? ' (admin)' : ''}`;

// Audit rows written for an admin's decision carry as_admin in their detail.
function adminAction(a) {
  try {
    return !!(a.detail_json && JSON.parse(a.detail_json).as_admin);
  } catch (e) {
    return false;
  }
}

function requestList(ctx, rows, queue, repTotals, filt) {
  const tz = ctx.user.timezone;
  const totals = repTotals || {};
  const f = filt || { query: {}, submitters: [], totalCount: rows.length };
  const q = f.query || {};
  const filtered = !!(q.from || q.to || q.status || q.submitter);
  const filterBar = `<form method="get" action="/requests" class="filters">
      <label>Submitted from <input type="date" name="from" value="${esc(q.from || '')}"></label>
      <label>to <input type="date" name="to" value="${esc(q.to || '')}"></label>
      <label>Status <select name="status"><option value="">All</option>${Object.entries(STATUS_LABELS)
        .map(([v, l]) => `<option value="${esc(v)}"${q.status === v ? ' selected' : ''}>${esc(l.replace(/ \(.*\)$/, ''))}</option>`)
        .join('')}</select></label>
      ${
        f.submitters.length > 1
          ? `<label>Submitter <select name="submitter"><option value="">All</option>${f.submitters
              .map(([id, name]) => `<option value="${id}"${String(q.submitter) === String(id) ? ' selected' : ''}>${esc(name)}</option>`)
              .join('')}</select></label>`
          : ''
      }
      <button class="chip selected">Filter</button>${filtered ? ' <a class="chip" href="/requests">Clear</a>' : ''}
    </form>`;
  const table = (list) =>
    list.length
      ? `<table class="list"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Submitter</th><th>Run dates</th><th>Est. spend</th><th>Rep amounts</th><th>Status</th></tr></thead><tbody>
      ${list
        .map(
          (r) => `<tr>
        <td>${r.id}</td>
        <td><a href="/requests/${r.id}">${esc(r.name)}</a></td>
        <td><span class="tag">${esc(typeLabel(r.type, r.data))}</span></td>
        <td>${esc(r.submitter_name)}</td>
        <td>${r.data.start_date ? esc(r.data.start_date + ' to ' + r.data.end_date) : ''}</td>
        <td>${esc(money(r.data.estimated_spend))}</td>
        <td>${totals[r.id] != null ? esc(money(totals[r.id])) : '<span class="muted">Not set</span>'}</td>
        <td>${statusBadge(r, r.data, tz)}</td></tr>`
        )
        .join('')}</tbody></table>`
      : `<div class="empty">${filtered ? 'No requests match these filters.' : 'Nothing here yet.'}</div>`;
  const mineOnly = ctx.user.role === 'submitter' && ctx.user.tier === 3;
  return page(
    ctx,
    'Manage',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Manage an Incentive</h1>
    ${queue.length ? `<h2>Waiting for your action (${queue.length})</h2>${table(queue)}` : ''}
    <h2>${mineOnly ? 'Your requests' : 'All requests'} <span class="count">${filtered ? `${rows.length} of ${f.totalCount}` : rows.length}</span></h2>
    ${filterBar}
    ${table(rows)}
    <p><a class="btn" href="/request">New request</a></p>`
  );
}

function requestDetail(ctx, o) {
  const { r, data, versions, steps, actions, auditRows, results } = o;
  const repAmounts = o.repAmounts || [];
  const repList = o.reps || [];
  const repSelect = (selected) => repPicker('rep_name', repList, selected);
  const repTotal = repAmounts.reduce((sum, x) => sum + x.amount, 0);
  const repRow = (x) => `<tr class="rep-row">
        <td>${repSelect(x.rep_name)}</td>
        <td><input name="rep_amount" type="number" step="0.01" min="0" value="${esc(x.amount)}"></td>
        <td><input name="rep_note" value="${esc(x.note || '')}"></td>
        <td><button type="button" class="link rep-remove">Remove</button></td></tr>`;
  const blankRep = { rep_name: '', amount: '', note: '' };
  const justification = o.justification || [];
  const isAdminUser = ctx.user.role === 'admin';
  const revOpsCalcs = data.calculated_by === 'commissions';
  const proofFields = `<div class="field">
        <label for="justification_files">Proof of your calculations${isAdminUser ? ' (optional for admins)' : ' (required)'}</label>
        ${justification.length ? `<div class="hint">Already attached:</div><div>${attachmentLinks(justification)}</div>` : ''}
        <input id="justification_files" name="justification_files" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg">
        <div class="hint">${
          isAdminUser
            ? 'A screenshot or file showing how the amounts were calculated.'
            : 'Because you calculate these amounts yourself, attach a screenshot or file showing how you got them. Amounts cannot be saved until something is attached, so Rev Ops and finance can verify the payouts. PDF, Excel, CSV, Word or image; 4 MB total.'
        }</div>
      </div>`;
  const repSection = o.canEditRepAmounts
    ? `<form method="post" action="/requests/${r.id}/rep-amounts" enctype="multipart/form-data" class="panel" id="rep-form" data-needs-proof="${isAdminUser ? '0' : '1'}" data-has-proof="${justification.length ? '1' : '0'}">${csrfField(ctx)}
      ${revOpsCalcs ? '<div class="flash info">RevOps calculates the payouts for this request. Upload the calculated amount for each rep below, or enter them by hand.</div>' : ''}
      <p class="hint">Winners and what each will make. Add a rep, enter an amount, and save. Remove a row to take that rep off. You can change this at any time, including after approval; every change is recorded in the activity log.</p>
      <table class="list"><thead><tr><th>Rep</th><th>Amount ($)</th><th>Note (optional)</th><th></th></tr></thead>
      <tbody id="rep-rows">${(repAmounts.length ? repAmounts : [blankRep]).map(repRow).join('')}</tbody></table>
      <template id="rep-row-template">${repRow(blankRep)}</template>
      <p><button type="button" class="btn secondary" id="rep-add">Add rep</button></p>
      <p id="rep-error" class="err" hidden></p>
      <p>Total: <strong id="rep-total">${esc(money(repTotal))}</strong></p>
      <div class="field rep-import">
        <label for="amounts_csv">Import amounts from a CSV (optional)</label>
        <p class="hint"><a href="/requests/${r.id}/rep-amounts/template.csv">Download the CSV template</a>${repAmounts.length ? ' (filled in with the reps already listed)' : ''}. Columns: Rep, Amount, Note. Rep must match a name on the rep list exactly.</p>
        <input id="amounts_csv" type="file" accept=".csv,text/csv">
        <p class="hint">The file is checked first and loaded into the table above for you to review. Nothing is saved until you press Save rep amounts. If any row has a problem, nothing is loaded.</p>
        <div id="csv-errors" class="csv-errors" hidden></div>
      </div>
      ${revOpsCalcs && !isAdminUser ? '' : proofFields}
      <button class="btn">Save rep amounts</button>
    </form>`
    : repAmounts.length
    ? `<table class="list"><thead><tr><th>Rep</th><th>Amount</th><th>Note</th></tr></thead><tbody>
      ${repAmounts.map((x) => `<tr><td>${esc(x.rep_name)}</td><td>${esc(money(x.amount))}</td><td>${esc(x.note || '')}</td></tr>`).join('')}
      <tr><th>Total</th><th>${esc(money(repTotal))}</th><th></th></tr></tbody></table>${
        justification.length ? `<p class="hint">Proof of calculations: ${attachmentLinks(justification)}</p>` : ''
      }`
    : `<p class="muted">${
        data.calculated_by === 'commissions'
          ? 'Rev Ops will enter the winners and payout amounts.'
          : 'No rep amounts have been entered.'
      }</p>`;
  const attachments = o.attachments || [];
  // Only the request form's documents belong to a version's terms; calculation proof is shown with the rep amounts.
  const filesFor = (version) => attachments.filter((a) => a.version === version && a.field === 'eligibility');
  const tz = ctx.user.timezone;
  const isAdj = r.type === 'adjustment';
  const reasoningBox = (required) =>
    `<div class="field"><label>Reasoning${required ? '' : ' (optional for approvals)'}</label><textarea name="reasoning" rows="3"></textarea></div>`;

  // The decision forms (finance, approver, admin override) sit above the rep amounts; the rest follow.
  const decisionForms = [];
  const forms = [];
  const adminNote = actions.asAdmin
    ? '<p class="hint">You are acting as an admin. This will be recorded as an admin action ("(admin)" next to your name) and Slack will say so.</p>'
    : '';
  if (actions.finance) {
    decisionForms.push(`<form method="post" action="/requests/${r.id}/finance" class="panel">${csrfField(ctx)}
      <h3>Finance review</h3>
      ${adminNote}
      ${isAdj ? `<div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>` : ''}
      <div class="field"><label>Classification</label>
        <select name="classification">
          <option value="">Select...</option>
          <option value="capitalizable">Capitalizable</option>
          <option value="expense"${isAdj ? ' selected' : ''}>Expense</option>
        </select></div>
      <div class="field"><label>Reasoning (optional)</label><textarea name="reasoning" rows="3"></textarea></div>
      <div class="field"><label class="check"><input type="checkbox" name="has_concern" value="1" id="has-concern"> Report a concern</label></div>
      <div class="field" id="concern-wrap" hidden>
        <label for="concern">Concern</label>
        <textarea id="concern" name="concern" rows="3"></textarea>
        <div class="hint">Saved on the request. The approver and the submitter can read it.</div>
      </div>
      ${
        r.submitter_tier !== 1
          ? '<p class="hint">After you classify this, it goes to an approver.</p>'
          : `<div class="field"><label>Approval scope</label>
        <select name="scope">
          <option value="once">Approve once (this month only)</option>
          ${isAdj ? '' : `<option value="quarter">Approve through the end of the quarter (${esc(dateLabel(actions.quarterEnd))})</option>`}
        </select></div>`
      }
      <button class="btn" name="action" value="classify">${r.submitter_tier === 1 ? 'Classify and approve' : 'Classify and send to approver'}</button>
    </form>`);
  }
  if (actions.approver) {
    decisionForms.push(`<form method="post" action="/requests/${r.id}/approver" class="panel">${csrfField(ctx)}
      <h3>Approver decision</h3>
      ${adminNote}
      ${isAdj ? `<div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>` : ''}
      ${reasoningBox(false)}
      <button class="btn" name="action" value="approve_once">Approve once (this month only)</button>
      ${isAdj ? '' : `<button class="btn" name="action" value="approve_quarter">Approve through the end of the quarter (${esc(dateLabel(actions.quarterEnd))})</button>`}
      <button class="btn secondary" name="action" value="return">Return to submitter</button>
      <button class="btn danger" name="action" value="reject">Reject</button>
      ${isAdj ? '' : `<p class="hint">Approve once covers this month only. Approving through the end of the quarter (${esc(actions.quarterEnd)}) lets resubmissions with unchanged terms that end by then skip review; any change to the terms brings back full review.</p>`}
    </form>`);
  }
  if (actions.skip) {
    decisionForms.push(`<form method="post" action="/requests/${r.id}/skip" class="panel">${csrfField(ctx)}
      <h3>Admin override</h3>
      <p class="hint">Skips the step this request is waiting on. The reason is recorded in the audit log.</p>
      ${reasoningBox(true)}
      <button class="btn secondary">Skip current step</button>
    </form>`);
  }
  if (actions.results) {
    forms.push(`<form method="post" action="/requests/${r.id}/results" class="panel">${csrfField(ctx)}
      <h3>Submit results</h3>
      <p class="hint">The run has ended. Submitting results finalizes this ${esc(TYPES[r.type])}.</p>
      <div class="row">
        <div class="field"><label>Actual spend ($)</label><input name="actual_spend" type="number" step="0.01" required></div>
        <div class="field"><label>Deals / demos (optional)</label><input name="deals_count" type="number" step="1" min="0"></div>
      </div>
      <div class="field"><label>Results summary</label><textarea name="notes" rows="4" required></textarea></div>
      <button class="btn">Finalize</button>
    </form>`);
  }
  if (actions.edit) {
    forms.push(`<p><a class="btn" href="/requests/${r.id}/edit">Edit and resubmit</a></p>`);
  }
  if (actions.cancel) {
    forms.push(`<form method="post" action="/requests/${r.id}/cancel" class="inline">${csrfField(ctx)}
      <button class="btn secondary">Cancel request</button></form>`);
  }

  const stepRows = steps
    .map(
      (s) => `<tr><td>v${s.version}</td><td>${esc(s.step.replace('_', ' '))}</td><td>${esc(s.decision)}</td>
      <td>${byLine(s.decided_by_name, s.by_admin)}</td><td>${esc(fmtTs(s.decided_at, tz))}</td>
      <td class="pre">${esc([s.detail, s.reasoning].filter(Boolean).join(': '))}</td></tr>`
    )
    .join('');

  const versionBlocks = versions
    .map(
      (v) => `<details${v.version === r.current_version ? ' open' : ''}>
      <summary>Version ${v.version}${v.version === r.current_version ? ' (current)' : ''}: ${esc(v.created_by_name)}, ${esc(fmtTs(v.created_at, tz))}</summary>
      ${termsTable(v.data, r.type, filesFor(v.version))}</details>`
    )
    .join('');

  const auditTable = auditRows.length
    ? `<table class="list"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${auditRows
        .map(
          (a) => `<tr><td>${esc(fmtTs(a.ts, tz))}</td><td>${byLine(a.user_name, adminAction(a))}</td><td>${esc(a.action)}</td>
          <td class="pre">${esc(a.detail_json || '')}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '';

  // "Classified by X (admin)" / "Approved by Y (admin)" for the current version, shown under the title.
  const stepNow = (name) => steps.filter((s) => s.step === name && s.version === r.current_version && s.decision !== 'skipped').pop();
  const decidedBy = (label, s) => (s && s.decision === 'approved' ? `${label} ${byLine(s.decided_by_name, s.by_admin)}. ` : '');
  const skipped = steps.filter((s) => s.version === r.current_version && s.decision === 'skipped' && s.decided_by_name);
  const decidedLine =
    decidedBy('Classified by', stepNow('finance')) +
    decidedBy('Approved by', stepNow('approver')) +
    skipped.map((s) => `${esc(s.step.replace('_', ' '))} step skipped by ${byLine(s.decided_by_name, s.by_admin)}. `).join('');

  return page(
    ctx,
    r.name,
    `<a class="back" href="/requests">&larr; Manage</a>
    <h1>${esc(r.name)} ${statusBadge(r, data, tz)}</h1>
    <p class="subtitle">${esc(typeLabel(r.type, data))} #${r.id}, submitted by ${esc(r.submitter_name)}.
    ${r.classification ? `Finance: <strong>${esc(r.classification)}</strong>. ` : ''}
    ${r.approval_scope ? `Approval: <strong>${esc(scopeLabel(r))}</strong>.` : ''}
    ${decidedLine ? `<br>${decidedLine}` : ''}</p>
    ${r.finance_concern ? `<div class="flash warn"><strong>Finance concern:</strong> <span class="pre">${esc(r.finance_concern)}</span></div>` : ''}
    ${isAdj ? `<div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>` : ''}
    <h2>Current terms</h2>
    ${termsTable(data, r.type, filesFor(r.current_version))}
    ${decisionForms.join('')}
    <h2>Rep amounts</h2>
    ${repSection}
    ${forms.join('')}
    ${results ? `<h2>Results</h2><table class="kv"><tr><th>Actual spend</th><td>${esc(money(results.actual_spend))}</td></tr>
      <tr><th>Deals / demos</th><td>${esc(results.deals_count == null ? '' : results.deals_count)}</td></tr>
      <tr><th>Summary</th><td class="pre">${esc(results.notes)}</td></tr>
      <tr><th>Submitted</th><td>${esc(fmtTs(results.submitted_at, tz))}</td></tr></table>` : ''}
    <h2>Approvals</h2>
    ${steps.length ? `<table class="list"><thead><tr><th>Ver</th><th>Step</th><th>Decision</th><th>By</th><th>When</th><th>Notes</th></tr></thead><tbody>${stepRows}</tbody></table>` : '<p class="muted">No decisions yet.</p>'}
    <h2>Version history</h2>
    ${versionBlocks}
    ${auditRows.length ? `<h2>Activity log</h2>${auditTable}` : ''}`
  );
}

// rows are the newest approved request for each SPIF name (see recurringSources).
function savedList(ctx, rows) {
  const today = todayIn(ctx.user.timezone || 'America/New_York');
  return page(
    ctx,
    'Recurring SPIFs',
    `<a class="back" href="/request">&larr; Back</a>
    <h1>Recurring SPIFs</h1>
    <p class="subtitle">Any approved SPIF can be resubmitted. Pick one, enter the new start and end dates, and resubmit. Everything else is prefilled. It goes through approval again unless its terms are unchanged and a quarterly approval still covers the run. "Resubmit with changes" always goes through approval.${
      ctx.user.role === 'submitter' && ctx.user.tier === 3 ? ' You see only SPIFs you submitted.' : ''
    }</p>
    ${
      rows.length
        ? rows
            .map((s) => {
              const standing = s.standing;
              const through = standing && standing.approved_through >= today ? standing.approved_through : null;
              return `<div class="panel">
          <h3>${esc(s.name)} ${through ? `<span class="pill s-approved">Approved through ${esc(dateLabel(through))}</span>` : ''}</h3>
          ${ctx.user.role === 'submitter' && ctx.user.tier === 3 ? '' : `<p class="muted">Submitted by ${esc(s.submitter_name)}</p>`}
          <details><summary>View terms</summary>${termsTable(s.data, 'new_spif')}</details>
          <form method="post" action="/saved/${s.id}/resubmit">
            ${csrfField(ctx)}
            <div class="row">
              <div class="field"><label>Start date</label><input type="date" name="start_date" required></div>
              <div class="field"><label>End date</label><input type="date" name="end_date" required></div>
            </div>
            <button class="btn">Resubmit with these dates</button>
            <a class="btn secondary" href="/requests/new?type=recurring_spif&saved=${s.id}">Resubmit with changes</a>
          </form>
          ${
            ctx.user.role === 'admin' && standing
              ? `<form method="post" action="/saved/${s.id}/revoke" class="inline">${csrfField(ctx)}<button class="link">Revoke approval through ${esc(dateLabel(standing.approved_through))} and deactivate</button></form>`
              : ''
          }
        </div>`;
            })
            .join('')
        : '<p class="muted">No approved SPIFs to resubmit yet.</p>'
    }`
  );
}

// Reports are marked "Coming soon" until real reports exist. Admins also get a preview of the
// unfinished tables below the notice; preview is { data, year, years } for them and null for everyone else.
function reports(ctx, preview) {
  return page(
    ctx,
    'Reports',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Reports <span class="pill soon">Coming soon</span></h1>
    <p class="subtitle">Spend by submitter, SPIF, and month.</p>
    <div class="empty">Reports are coming soon. This page will fill in once real reports are built.</div>
    ${preview ? `<h2 class="preview-title">Admin preview <span class="count">unfinished, visible to admins only</span></h2>${reportTables(ctx, preview.data, preview.year, preview.years)}` : ''}`
  );
}

function reportTables(ctx, data, year, years) {
  const t = (rows, label) =>
    rows.length
      ? `<table class="list"><thead><tr><th>${label}</th><th>Count</th><th>Estimated</th><th>Actual (finalized)</th><th>Spend used</th></tr></thead><tbody>
      ${rows
        .map(
          (r) => `<tr><td>${esc(r.key)}</td><td>${r.count}</td><td>${esc(money(r.estimated))}</td><td>${esc(money(r.actual))}</td><td>${esc(money(r.spend))}</td></tr>`
        )
        .join('')}</tbody></table>`
      : '<p class="muted">No data for this year.</p>';
  return `<form method="get" action="/reports" class="inline">
      <label>Year <select name="year" onchange="this.form.submit()">
        ${years.map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}
      </select></label>
    </form>
    <p class="subtitle">Approved and finalized requests only. "Spend used" is the actual spend once results are in, otherwise the estimate.
    Requests count in the month they start (adjustments: the month submitted).
    ${ctx.user.role === 'submitter' && ctx.user.tier === 3 ? 'You see your own requests only.' : ''}</p>
    <h2>Total for ${year}: ${esc(money(data.total))}</h2>
    <h2>By month</h2>
    ${
      data.months.length
        ? `<table class="list"><thead><tr><th>Month</th><th>Count</th><th>Estimated</th><th>Actual (finalized)</th><th>Spend used</th><th>Year to date</th></tr></thead><tbody>
      ${data.months
        .map(
          (m) => `<tr><td>${esc(m.key)}</td><td>${m.count}</td><td>${esc(money(m.estimated))}</td><td>${esc(money(m.actual))}</td><td>${esc(money(m.spend))}</td><td>${esc(money(m.cumulative))}</td></tr>`
        )
        .join('')}</tbody></table>`
        : '<p class="muted">No data for this year.</p>'
    }
    <h2>By submitter</h2>
    ${t(data.bySubmitter, 'Submitter')}
    <h2>By SPIF / request</h2>
    ${
      data.bySpif.length
        ? `<table class="list"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Submitter</th><th>Month</th><th>Spend used</th></tr></thead><tbody>
      ${data.bySpif
        .map(
          (r) => `<tr><td>${r.id}</td><td><a href="/requests/${r.id}">${esc(r.name)}</a></td><td>${esc(TYPES[r.type])}</td><td>${esc(r.submitter)}</td><td>${esc(r.month)}</td><td>${esc(money(r.spend))}</td></tr>`
        )
        .join('')}</tbody></table>`
        : '<p class="muted">No data for this year.</p>'
    }`;
}

function auditPage(ctx, rows, requestId) {
  const tz = ctx.user.timezone;
  return page(
    ctx,
    'Audit log',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Audit log${requestId ? ' for request #' + esc(requestId) : ''}</h1>
    <p class="subtitle">Append-only record of every action. Showing the latest 500.</p>
    <table class="list"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Request</th><th>Detail</th></tr></thead><tbody>
    ${rows
      .map(
        (a) => `<tr><td>${esc(fmtTs(a.ts, tz))}</td><td>${byLine(a.user_name, adminAction(a))}</td><td>${esc(a.action)}</td>
        <td>${a.request_id ? `<a href="/requests/${a.request_id}">#${a.request_id}</a>` : ''}</td>
        <td class="pre">${esc(a.detail_json || '')}</td></tr>`
      )
      .join('')}</tbody></table>`
  );
}

function tzOptions(current) {
  return TIMEZONES.map((z) => `<option${z === current ? ' selected' : ''}>${esc(z)}</option>`).join('');
}

function tierOptions(current) {
  return Object.entries(TIER_LABELS)
    .map(([v, l]) => `<option value="${v}"${Number(v) === current ? ' selected' : ''}>${esc(l)}</option>`)
    .join('');
}

function roleOptions(current) {
  return Object.entries(ROLE_LABELS)
    .map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
    .join('');
}

function admin(ctx, o) {
  const { users, pendingRows, saved } = o;
  const tz = ctx.user.timezone;
  // Who a user's requests go to: tier 2 and tier 1 reports are picked from active standard users of that tier.
  const byId = new Map(users.map((x) => [x.id, x.name]));
  const reportOptions = (wantTier, current) =>
    `<option value="">Select...</option>` +
    users
      .filter((x) => x.active && x.role === 'submitter' && x.tier === wantTier)
      .map((x) => `<option value="${x.id}"${x.id === current ? ' selected' : ''}>${esc(x.name)}</option>`)
      .join('');
  const reportFields = (u) => `<div class="row">
        <div class="field" data-report-field="2"><label>Tier 2 report (approver)</label><select name="tier2_id">${reportOptions(2, u && u.tier2_id)}</select></div>
        <div class="field" data-report-field="1"><label>Tier 1 report (approver)</label><select name="tier1_id">${reportOptions(1, u && u.tier1_id)}</select></div>
      </div>
      <p class="hint" data-report-field="1">Their requests go to these approvers after finance.</p>`;
  return page(
    ctx,
    'Admin',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Admin</h1>

    <h2 id="view-as">View as</h2>
    <form method="post" action="/view-as" class="panel">
      ${csrfField(ctx)}
      <p class="hint">See the app exactly as another user sees it, to test each role's experience. It is read-only: nothing can be submitted, approved or changed while you are viewing as someone else, and starting it is written to the audit log.</p>
      <div class="field"><label for="view-as-user">User</label>
        <select id="view-as-user" name="user_id" required>
          <option value="">Select a user...</option>
          ${users
            .filter((x) => x.active && x.id !== ctx.user.id)
            .map((x) => `<option value="${x.id}">${esc(x.name)} (${esc(ROLE_LABELS[roleKey(x)])}${x.role === 'submitter' ? ', tier ' + x.tier : ''})</option>`)
            .join('')}
        </select></div>
      <button class="btn">View as this user</button>
    </form>

    <h2>Pending approvals (${pendingRows.length})</h2>
    ${
      pendingRows.length
        ? `<table class="list"><thead><tr><th>#</th><th>Name</th><th>Submitter</th><th>Status</th></tr></thead><tbody>
      ${pendingRows
        .map(
          (r) => `<tr><td>${r.id}</td><td><a href="/requests/${r.id}">${esc(r.name)}</a></td><td>${esc(r.submitter_name)}</td><td>${statusBadge(r, r.data, tz)}</td></tr>`
        )
        .join('')}</tbody></table>`
        : '<p class="muted">Nothing pending.</p>'
    }

    <h2>Users</h2>
    <details class="panel">
      <summary>Add a user</summary>
      <form method="post" action="/admin/users">
        ${csrfField(ctx)}
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required></div>
          <div class="field"><label>Email</label><input name="email" type="email" required></div>
        </div>
        <div class="row">
          <div class="field"><label>Role</label><select name="role">${roleOptions('submitter')}</select></div>
          <div class="field" data-tier-field><label>Tier</label><select name="tier">${tierOptions(3)}</select></div>
          <div class="field"><label>Time zone</label><select name="timezone">${tzOptions('America/New_York')}</select></div>
        </div>
        ${reportFields(null)}
        <div class="row">
          <div class="field"><label>Slack member ID (optional)</label><input name="slack_id" placeholder="U01ABCDE234"></div>
          <div class="field"><label>Temporary password (leave blank when using Microsoft sign-in; min 10 characters)</label><input name="password" type="password" autocomplete="new-password"></div>
        </div>
        <button class="btn">Add user</button>
      </form>
    </details>

    <table class="grid users-grid">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Tier</th><th>Tier 2 report</th><th>Tier 1 report</th><th>Time zone</th><th>Slack ID</th><th>Status</th></tr></thead>
      <tbody>
    ${users
      .map(
        (u) => `<tr class="user-line${u.active ? '' : ' inactive'}" tabindex="0" title="Click to edit">
        <td class="uname">${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(ROLE_LABELS[roleKey(u)])}</td>
        <td>${u.role !== 'submitter' ? '' : u.tier}</td><td>${esc(byId.get(u.tier2_id) || '')}</td><td>${esc(byId.get(u.tier1_id) || '')}</td><td>${esc(u.timezone)}</td><td>${esc(u.slack_id || '')}</td>
        <td>${u.active ? 'Active' : 'Inactive'}</td></tr>
      <tr class="user-edit" hidden><td colspan="9">
      <form method="post" action="/admin/users/${u.id}" class="panel">
      ${csrfField(ctx)}
      <div class="row">
        <div class="field"><label>Name</label><input name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(u.email)}" required></div>
      </div>
      <div class="row">
        <div class="field"><label>Role</label><select name="role">${roleOptions(roleKey(u))}</select></div>
        <div class="field" data-tier-field${u.role !== 'submitter' ? ' hidden' : ''}><label>Tier</label><select name="tier">${tierOptions(u.tier)}</select></div>
        <div class="field"><label>Time zone</label><select name="timezone">${tzOptions(u.timezone)}</select></div>
        <div class="field"><label>Status</label><select name="active"><option value="1"${u.active ? ' selected' : ''}>Active</option><option value="0"${u.active ? '' : ' selected'}>Inactive</option></select></div>
      </div>
      ${reportFields(u)}
      <div class="row">
        <div class="field"><label>Slack member ID (optional)</label><input name="slack_id" value="${esc(u.slack_id || '')}" placeholder="U01ABCDE234"></div>
        <div class="field"><label>New password (leave blank to keep)</label><input name="password" type="password" autocomplete="new-password"></div>
      </div>
      <button class="btn">Save ${esc(u.name)}</button>
      <button type="button" class="btn secondary user-cancel">Close</button>
      </form></td></tr>`
      )
      .join('')}
      </tbody>
    </table>

    <h2>Saved recurring SPIFs (${saved.length})</h2>
    <p><a href="/saved">Manage saved SPIFs</a> &middot; <a href="/admin/saved-spifs.csv">Export all saved SPIFs (CSV)</a></p>`
  );
}

function account(ctx) {
  const u = ctx.user;
  return page(
    ctx,
    'Account',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Your account</h1>
    <form method="post" action="/account" class="panel narrow">
      ${csrfField(ctx)}
      <p>${esc(u.name)}, ${esc(u.email)}, ${esc(ROLE_LABELS[roleKey(u)])}${u.role === 'submitter' ? ', ' + esc(TIER_LABELS[u.tier]) : ''}</p>
      <div class="field"><label>Time zone</label><div class="hint">Dates and the "must be after today" rule use this.</div>
        <select name="timezone">${tzOptions(u.timezone)}</select></div>
      <div class="field"><label>New password (leave blank to keep, min 10 characters)</label><input name="password" type="password" autocomplete="new-password"></div>
      <button class="btn">Save</button>
    </form>`
  );
}

module.exports = {
  esc,
  page,
  login,
  home,
  requestChooser,
  requestForm,
  requestList,
  requestDetail,
  savedList,
  reports,

  auditPage,
  admin,
  account,
  STATUS_LABELS,
};
