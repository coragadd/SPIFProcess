'use strict';
const { TYPES, STATUS_LABELS, TIMEZONES, displayStatus } = require('./workflow');

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

const ROLE_LABELS = { submitter: 'Submitter', finance: 'Finance', approver: 'Approver', admin: 'Admin' };
const PAYOUT_LABELS = { per_transaction: 'Per transaction (per demo, per deal)', flat: 'Flat bonus' };
const QUOTE_LABELS = { signed: 'Signed', in_process: 'In process', no_quote: 'No quote' };

const ADJUSTMENT_GUIDE =
  'Adjustment guide: deals with a signed or in-process quote can receive a full or half adjustment. Deals with no quote do not qualify. Adjustments are treated as expenses by default.';

function csrfField(ctx) {
  return `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;
}

function page(ctx, title, body) {
  const u = ctx.user;
  const nav = u
    ? `<nav class="topnav">
        <a href="/">Home</a>
        <a href="/request">Request</a>
        <a href="/requests">Manage</a>
        <a href="/reports">Reports</a>
        ${u.role !== 'submitter' ? '<a href="/audit">Audit log</a>' : ''}
        ${u.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
        <span class="spacer"></span>
        <a href="/account">${esc(u.name)} (${esc(ROLE_LABELS[u.role])})</a>
        <form method="post" action="/logout" class="inline">${csrfField(ctx)}<button class="link">Sign out</button></form>
      </nav>`
    : '';
  const flash = ctx.flash ? `<div class="flash ${esc(ctx.flash.type)}">${esc(ctx.flash.msg)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | SPIF Process</title>
<link rel="stylesheet" href="/static/styles.css">
</head><body>${nav}<main class="container">${flash}${body}</main></body></html>`;
}

// ------------------------------------------------------------ form helpers

function fieldWrap(name, label, hint, errors, inner) {
  return `<div class="field${errors[name] ? ' has-error' : ''}">
    <label for="${name}">${esc(label)}</label>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    ${inner}
    ${errors[name] ? `<div class="err">${esc(errors[name])}</div>` : ''}
  </div>`;
}

function input(name, label, values, errors, o) {
  const opt = o || {};
  const inner = `<input id="${name}" name="${name}" type="${opt.type || 'text'}" value="${esc(values[name])}"${
    opt.readonly ? ' readonly' : ''
  }${opt.step ? ` step="${opt.step}"` : ''}>`;
  return fieldWrap(name, label, opt.hint, errors, inner);
}

function textarea(name, label, values, errors, o) {
  const opt = o || {};
  const inner = `<textarea id="${name}" name="${name}" rows="${opt.rows || 4}">${esc(values[name])}</textarea>`;
  return fieldWrap(name, label, opt.hint, errors, inner);
}

function select(name, label, values, errors, options, o) {
  const opt = o || {};
  const inner = `<select id="${name}" name="${name}">
    <option value="">Select...</option>
    ${options
      .map(([v, l]) => `<option value="${esc(v)}"${String(values[name]) === String(v) ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}
  </select>`;
  return fieldWrap(name, label, opt.hint, errors, inner);
}

// ------------------------------------------------------------ pages

function login(ctx, error) {
  return page(
    ctx,
    'Sign in',
    `<h1>SPIF Process</h1>
    <p class="subtitle">Sign in to request, manage, and review incentives.</p>
    ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
    <form method="post" action="/login" class="panel narrow">
      ${csrfField(ctx)}
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn">Sign in</button>
    </form>`
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
    `<h1>SPIF Process</h1>
    <p class="subtitle">What would you like to do?</p>
    ${banner}
    <nav class="options">
      <a class="card" href="/request"><h2>Request an Incentive</h2><p>Submit a new SPIF, recurring SPIF, bonus, or adjustment.</p></a>
      <a class="card" href="/requests"><h2>Manage an Incentive</h2><p>Track, review, approve, and report results on requests.</p></a>
      <a class="card" href="/reports"><h2>View Reports</h2><p>Spend by submitter, SPIF, and month.</p></a>
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
      <a class="card" href="/requests/new?type=bonus"><h2>Bonus</h2><p>A flat or per-transaction bonus.</p></a>
      <a class="card" href="/requests/new?type=adjustment"><h2>Adjustment</h2><p>A commission adjustment on a deal.</p></a>
    </nav>`
  );
}

function requestForm(ctx, o) {
  const { type, values, errors, action, submitLabel, savedId, lockName, requestId } = o;
  const isAdj = type === 'adjustment';
  const hidden = `${csrfField(ctx)}<input type="hidden" name="type" value="${esc(type)}">${
    savedId ? `<input type="hidden" name="saved_id" value="${esc(savedId)}">` : ''
  }`;
  const errorList = Object.keys(errors).length
    ? `<div class="flash error">Please fix the highlighted fields before submitting.</div>`
    : '';

  const common = `
    ${input('name', 'Name', values, errors, { readonly: lockName, hint: lockName ? 'Saved recurring SPIF name.' : 'Must be distinct from every other request.' })}
    ${input('participants', isAdj ? 'Person or team receiving the adjustment' : 'People or team involved', values, errors)}
    ${textarea('description', isAdj ? 'Description' : 'Detailed description of how it works', values, errors, { rows: 6 })}`;

  const adjFields = `
    <div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>
    ${input('deal', 'Deal', values, errors)}
    ${select('quote_status', 'Quote status', values, errors, Object.entries(QUOTE_LABELS))}
    ${input('closed_by', 'Who closed the deal', values, errors)}
    ${select('adjustment_size', 'Adjustment size', values, errors, [['full', 'Full'], ['half', 'Half']])}
    ${textarea('adjustment_reason', 'Reason for the adjustment', values, errors)}
    ${input('amounts', 'Amount', values, errors, { hint: 'e.g. $450 commission adjustment' })}
    ${input('estimated_spend', 'Estimated total spend ($)', values, errors, { type: 'number', step: '0.01' })}`;

  const spifFields = `
    ${select('payout_structure', 'Payout structure', values, errors, Object.entries(PAYOUT_LABELS))}
    ${textarea('amounts', 'Amounts', values, errors, { hint: 'What is paid, per transaction or as a flat amount. Include tiers if any.' })}
    ${input('estimated_spend', 'Estimated total spend ($)', values, errors, { type: 'number', step: '0.01' })}
    <div class="row">
      ${input('start_date', 'Start date', values, errors, { type: 'date' })}
      ${input('end_date', 'End date', values, errors, { type: 'date', hint: 'Required. Resubmit monthly; no perpetual SPIFs.' })}
    </div>
    <div class="row">
      ${input('announce_date', 'Date announced to the team', values, errors, { type: 'date' })}
      ${input('announce_method', 'How it will be announced', values, errors, { hint: 'e.g. email, all-hands, Slack' })}
    </div>
    ${textarea('eligibility', 'Eligibility and measurement rules', values, errors, { hint: 'Who qualifies and exactly how results are measured.' })}
    ${textarea('edge_cases', 'Edge cases', values, errors, {
      hint: 'What if X happens? e.g. one component hits but the other does not: how is payout determined?',
    })}`;

  return page(
    ctx,
    TYPES[type],
    `<a class="back" href="${requestId ? '/requests/' + requestId : '/request'}">&larr; Back</a>
    <h1>${requestId ? 'Edit and resubmit: ' : ''}${esc(TYPES[type])}</h1>
    ${errorList}
    <form method="post" action="${esc(action)}" class="panel">
      ${hidden}
      ${common}
      ${isAdj ? adjFields : spifFields}
      <button class="btn">${esc(submitLabel)}</button>
    </form>`
  );
}

function termsTable(data, type) {
  const rows = [];
  const add = (label, val) => {
    if (val !== '' && val != null) rows.push(`<tr><th>${esc(label)}</th><td class="pre">${esc(val)}</td></tr>`);
  };
  add('Participants', data.participants);
  add('Description', data.description);
  if (type === 'adjustment') {
    add('Deal', data.deal);
    add('Quote status', QUOTE_LABELS[data.quote_status] || data.quote_status);
    add('Closed by', data.closed_by);
    add('Adjustment size', data.adjustment_size);
    add('Reason', data.adjustment_reason);
  } else {
    add('Payout structure', PAYOUT_LABELS[data.payout_structure] || data.payout_structure);
  }
  add('Amounts', data.amounts);
  add('Estimated total spend', money(data.estimated_spend));
  if (type !== 'adjustment') {
    if (data.start_date) add('Run dates', `${data.start_date} to ${data.end_date}`);
    if (data.announce_date) add('Announced', `${data.announce_date} via ${data.announce_method}`);
    add('Eligibility and measurement', data.eligibility);
    add('Edge cases', data.edge_cases);
  }
  return `<table class="kv">${rows.join('')}</table>`;
}

function statusBadge(r, data, tz) {
  return `<span class="badge s-${esc(r.status)}">${esc(displayStatus(r, data, tz))}</span>`;
}

function requestList(ctx, rows, queue) {
  const tz = ctx.user.timezone;
  const table = (list) =>
    list.length
      ? `<table class="list"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Submitter</th><th>Run dates</th><th>Est. spend</th><th>Status</th></tr></thead><tbody>
      ${list
        .map(
          (r) => `<tr>
        <td>${r.id}</td>
        <td><a href="/requests/${r.id}">${esc(r.name)}</a></td>
        <td>${esc(TYPES[r.type])}</td>
        <td>${esc(r.submitter_name)}</td>
        <td>${r.data.start_date ? esc(r.data.start_date + ' to ' + r.data.end_date) : ''}</td>
        <td>${esc(money(r.data.estimated_spend))}</td>
        <td>${statusBadge(r, r.data, tz)}</td></tr>`
        )
        .join('')}</tbody></table>`
      : '<p class="muted">Nothing here yet.</p>';
  const mineOnly = ctx.user.role === 'submitter';
  return page(
    ctx,
    'Manage',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Manage an Incentive</h1>
    ${queue.length ? `<h2>Waiting for your action (${queue.length})</h2>${table(queue)}` : ''}
    <h2>${mineOnly ? 'Your requests' : 'All requests'}</h2>
    ${table(rows)}
    <p><a class="btn" href="/request">New request</a></p>`
  );
}

function requestDetail(ctx, o) {
  const { r, data, versions, steps, actions, auditRows, secondName, results } = o;
  const tz = ctx.user.timezone;
  const isAdj = r.type === 'adjustment';
  const reasoningBox = (required) =>
    `<div class="field"><label>Reasoning${required ? '' : ' (optional for approvals)'}</label><textarea name="reasoning" rows="3"></textarea></div>`;

  const forms = [];
  if (actions.finance) {
    forms.push(`<form method="post" action="/requests/${r.id}/finance" class="panel">${csrfField(ctx)}
      <h3>Finance review</h3>
      ${isAdj ? `<div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>` : ''}
      <div class="field"><label>Classification</label>
        <select name="classification">
          <option value="">Select...</option>
          <option value="capitalizable">Capitalizable</option>
          <option value="expense"${isAdj ? ' selected' : ''}>Expense</option>
        </select></div>
      ${reasoningBox(true)}
      <button class="btn" name="action" value="classify">Classify and send to approver</button>
      <button class="btn secondary" name="action" value="return">Return to submitter</button>
      <button class="btn danger" name="action" value="reject">Reject</button>
    </form>`);
  }
  if (actions.approver) {
    forms.push(`<form method="post" action="/requests/${r.id}/approver" class="panel">${csrfField(ctx)}
      <h3>Approver decision</h3>
      ${isAdj ? `<div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>` : ''}
      <p>Finance classification: <strong>${esc(r.classification || 'not classified')}</strong>.
      ${r.submitter_role === 'approver' ? 'This is an approver submission, so a second sign-off is also required.' : ''}</p>
      ${reasoningBox(false)}
      <button class="btn" name="action" value="approve_once">Approve once</button>
      ${isAdj ? '' : '<button class="btn" name="action" value="approve_indefinitely">Approve indefinitely</button>'}
      <button class="btn secondary" name="action" value="return">Return to submitter</button>
      <button class="btn danger" name="action" value="reject">Reject</button>
      ${isAdj ? '' : '<p class="hint">Indefinite approval saves this as a recurring SPIF. Monthly resubmissions with unchanged terms skip finance and approver review; any change to the terms brings back full review.</p>'}
    </form>`);
  }
  if (actions.second) {
    forms.push(`<form method="post" action="/requests/${r.id}/second" class="panel">${csrfField(ctx)}
      <h3>Second sign-off</h3>
      ${reasoningBox(false)}
      <button class="btn" name="action" value="approve">Sign off</button>
      <button class="btn secondary" name="action" value="return">Return to submitter</button>
      <button class="btn danger" name="action" value="reject">Reject</button>
    </form>`);
  }
  if (actions.skip) {
    forms.push(`<form method="post" action="/requests/${r.id}/skip" class="panel">${csrfField(ctx)}
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
      <td>${esc(s.decided_by_name || 'system')}</td><td>${esc(fmtTs(s.decided_at, tz))}</td>
      <td class="pre">${esc([s.detail, s.reasoning].filter(Boolean).join(': '))}</td></tr>`
    )
    .join('');

  const versionBlocks = versions
    .map(
      (v) => `<details${v.version === r.current_version ? ' open' : ''}>
      <summary>Version ${v.version}${v.version === r.current_version ? ' (current)' : ''}: ${esc(v.created_by_name)}, ${esc(fmtTs(v.created_at, tz))}</summary>
      ${termsTable(v.data, r.type)}</details>`
    )
    .join('');

  const auditTable = auditRows.length
    ? `<table class="list"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${auditRows
        .map(
          (a) => `<tr><td>${esc(fmtTs(a.ts, tz))}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)}</td>
          <td class="pre">${esc(a.detail_json || '')}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '';

  return page(
    ctx,
    r.name,
    `<a class="back" href="/requests">&larr; Manage</a>
    <h1>${esc(r.name)} ${statusBadge(r, data, tz)}</h1>
    <p class="subtitle">${esc(TYPES[r.type])} #${r.id}, submitted by ${esc(r.submitter_name)}.
    ${r.classification ? `Finance: <strong>${esc(r.classification)}</strong>. ` : ''}
    ${r.approval_scope ? `Approver scope: <strong>${esc(r.approval_scope === 'once' ? 'approved once' : 'approved indefinitely')}</strong>.` : ''}
    ${r.status === 'second_signoff' && secondName ? `Second sign-off by ${esc(secondName)}.` : ''}</p>
    ${isAdj && data.quote_status === 'no_quote' ? '<div class="flash error">No quote on this deal. Under the adjustment guide it does not qualify.</div>' : ''}
    ${isAdj ? `<div class="flash info">${esc(ADJUSTMENT_GUIDE)}</div>` : ''}
    <h2>Current terms</h2>
    ${termsTable(data, r.type)}
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

function savedList(ctx, rows) {
  return page(
    ctx,
    'Saved recurring SPIFs',
    `<a class="back" href="/request">&larr; Back</a>
    <h1>Saved recurring SPIFs</h1>
    <p class="subtitle">Pick one, enter the new dates, and resubmit. A SPIF is saved when the approver chooses "Approve indefinitely".</p>
    ${
      rows.length
        ? rows
            .map((s) => {
              const t = JSON.parse(s.terms_json);
              return `<div class="panel">
          <h3>${esc(s.name)} ${s.approved_indefinitely ? '<span class="badge s-approved">Indefinitely approved</span>' : ''}</h3>
          <details><summary>View saved terms</summary>${termsTable(t, 'new_spif')}</details>
          <form method="post" action="/saved/${s.id}/resubmit">
            ${csrfField(ctx)}
            <div class="row">
              <div class="field"><label>Start date</label><input type="date" name="start_date" required></div>
              <div class="field"><label>End date</label><input type="date" name="end_date" required></div>
            </div>
            <div class="row">
              <div class="field"><label>Date announced</label><input type="date" name="announce_date" required></div>
              <div class="field"><label>Announcement method</label><input name="announce_method" required></div>
            </div>
            <button class="btn">Resubmit with these dates</button>
            <a class="btn secondary" href="/requests/new?type=recurring_spif&saved=${s.id}">Resubmit with changes</a>
          </form>
          ${
            ctx.user.role === 'admin'
              ? `<form method="post" action="/saved/${s.id}/revoke" class="inline">${csrfField(ctx)}<button class="link">Revoke indefinite approval and deactivate</button></form>`
              : ''
          }
        </div>`;
            })
            .join('')
        : '<p class="muted">No saved recurring SPIFs yet.</p>'
    }`
  );
}

function reports(ctx, data, year, years) {
  const t = (rows, label) =>
    rows.length
      ? `<table class="list"><thead><tr><th>${label}</th><th>Count</th><th>Estimated</th><th>Actual (finalized)</th><th>Spend used</th></tr></thead><tbody>
      ${rows
        .map(
          (r) => `<tr><td>${esc(r.key)}</td><td>${r.count}</td><td>${esc(money(r.estimated))}</td><td>${esc(money(r.actual))}</td><td>${esc(money(r.spend))}</td></tr>`
        )
        .join('')}</tbody></table>`
      : '<p class="muted">No data for this year.</p>';
  return page(
    ctx,
    'Reports',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Reports</h1>
    <form method="get" action="/reports" class="inline">
      <label>Year <select name="year" onchange="this.form.submit()">
        ${years.map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}
      </select></label>
    </form>
    <p class="subtitle">Approved and finalized requests only. "Spend used" is the actual spend once results are in, otherwise the estimate.
    Requests count in the month they start (adjustments: the month submitted).
    ${ctx.user.role === 'submitter' ? 'You see your own requests only.' : ''}</p>
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
    }`
  );
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
        (a) => `<tr><td>${esc(fmtTs(a.ts, tz))}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)}</td>
        <td>${a.request_id ? `<a href="/requests/${a.request_id}">#${a.request_id}</a>` : ''}</td>
        <td class="pre">${esc(a.detail_json || '')}</td></tr>`
      )
      .join('')}</tbody></table>`
  );
}

function tzOptions(current) {
  return TIMEZONES.map((z) => `<option${z === current ? ' selected' : ''}>${esc(z)}</option>`).join('');
}

function roleOptions(current) {
  return Object.entries(ROLE_LABELS)
    .map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
    .join('');
}

function admin(ctx, o) {
  const { users, secondId, pendingRows, saved } = o;
  const tz = ctx.user.timezone;
  return page(
    ctx,
    'Admin',
    `<a class="back" href="/">&larr; Home</a>
    <h1>Admin</h1>

    <h2>Settings</h2>
    <form method="post" action="/admin/settings" class="panel narrow">
      ${csrfField(ctx)}
      <div class="field"><label>Second sign-off for approver submissions</label>
        <div class="hint">Required when an approver (e.g. Peter) submits a request.</div>
        <select name="second_signoff_user_id">
          <option value="">Not set</option>
          ${users
            .filter((u) => u.active)
            .map((u) => `<option value="${u.id}"${u.id === secondId ? ' selected' : ''}>${esc(u.name)} (${esc(ROLE_LABELS[u.role])})</option>`)
            .join('')}
        </select></div>
      <button class="btn">Save settings</button>
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
    ${users
      .map(
        (u) => `<form method="post" action="/admin/users/${u.id}" class="panel userrow">
      ${csrfField(ctx)}
      <div class="row">
        <div class="field"><label>Name</label><input name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(u.email)}" required></div>
      </div>
      <div class="row">
        <div class="field"><label>Role</label><select name="role">${roleOptions(u.role)}</select></div>
        <div class="field"><label>Time zone</label><select name="timezone">${tzOptions(u.timezone)}</select></div>
        <div class="field"><label>Status</label><select name="active"><option value="1"${u.active ? ' selected' : ''}>Active</option><option value="0"${u.active ? '' : ' selected'}>Inactive</option></select></div>
      </div>
      <div class="field"><label>New password (leave blank to keep)</label><input name="password" type="password" autocomplete="new-password"></div>
      <button class="btn">Save ${esc(u.name)}</button>
    </form>`
      )
      .join('')}

    <h3>Add a user</h3>
    <form method="post" action="/admin/users" class="panel">
      ${csrfField(ctx)}
      <div class="row">
        <div class="field"><label>Name</label><input name="name" required></div>
        <div class="field"><label>Email</label><input name="email" type="email" required></div>
      </div>
      <div class="row">
        <div class="field"><label>Role</label><select name="role">${roleOptions('submitter')}</select></div>
        <div class="field"><label>Time zone</label><select name="timezone">${tzOptions('America/New_York')}</select></div>
        <div class="field"><label>Temporary password (min 10 characters)</label><input name="password" type="password" autocomplete="new-password" required></div>
      </div>
      <button class="btn">Add user</button>
    </form>

    <h2>Saved recurring SPIFs (${saved.length})</h2>
    <p><a href="/saved">Manage saved SPIFs</a></p>`
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
      <p>${esc(u.name)}, ${esc(u.email)}, ${esc(ROLE_LABELS[u.role])}</p>
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
