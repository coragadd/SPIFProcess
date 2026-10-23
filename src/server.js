'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { db, audit, seedAdmin, dataDir, uploadDir } = require('./db');
const wf = require('./workflow');
const views = require('./views');
const { notifyRequest, notifyRepAmounts } = require('./notify');

const { UserError } = wf;

// ---------------------------------------------------------------- config

const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (onRailway || process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET must be set. Refusing to start.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set; using a temporary one (sessions reset on restart).');
}

seedAdmin();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  next();
});

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(
  cookieSession({
    name: 'spif_session',
    keys: [sessionSecret],
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  })
);

// Load the signed-in user fresh from the DB on every request (so deactivation is immediate).
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  req.user = null;
  if (req.session.uid) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.uid);
    if (u) req.user = u;
    else req.session = { csrf: req.session.csrf };
  }
  next();
});

function csrfOk(req) {
  const sent = String((req.body && req.body._csrf) || '');
  const want = String(req.session.csrf || '');
  return sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
}

// Multipart bodies are not parsed yet at this point, so only the routes that accept file
// uploads may receive them, and each of those checks the token itself after parsing.
const MULTIPART_ROUTES = [/^\/requests$/, /^\/requests\/\d+\/edit$/];

app.use((req, res, next) => {
  if (req.method === 'POST') {
    if (/^multipart\/form-data/i.test(req.get('Content-Type') || '')) {
      if (!MULTIPART_ROUTES.some((re) => re.test(req.path))) return res.status(403).send('Not allowed.');
      return next();
    }
    if (!csrfOk(req)) return res.status(403).send('Invalid or expired form. Go back, refresh the page, and try again.');
  }
  next();
});

// ---------------------------------------------------------------- uploads

const ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.png', '.jpg', '.jpeg'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

const uploader = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new UserError(`"${file.originalname}" is not an allowed file type.`));
    cb(null, true);
  },
}).array('eligibility_files', MAX_FILES);

function removeTempFiles(req) {
  for (const f of req.files || []) fs.unlink(f.path, () => {});
}

// Parses the multipart form, then verifies the CSRF token (discarding files if it fails).
function handleUpload(req, res, next) {
  uploader(req, res, (err) => {
    if (err) {
      removeTempFiles(req);
      const msg =
        err instanceof UserError
          ? err.message
          : err.code === 'LIMIT_FILE_SIZE'
          ? 'Each file must be 10 MB or smaller.'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Attach at most ${MAX_FILES} files.`
          : 'The upload failed. Try again.';
      flash(req, 'error', msg);
      return res.redirect(req.get('Referer') || '/request');
    }
    if (!csrfOk(req)) {
      removeTempFiles(req);
      return res.status(403).send('Invalid or expired form. Go back, refresh the page, and try again.');
    }
    next();
  });
}

function uploadedRecords(req) {
  return (req.files || []).map((f) => ({
    original_name: path.basename(f.originalname),
    stored_name: f.filename,
    mime: f.mimetype,
    size: f.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'),
  }));
}

// Which of the existing attachments the submitter chose to keep (the form's checked boxes).
function keptRows(req, existing) {
  const keep = [].concat(req.body.keep_files || []).map(String);
  return existing.filter((a) => keep.includes(String(a.id)));
}

// ---------------------------------------------------------------- helpers

function ctx(req) {
  const flash = req.session.flash || null;
  if (flash) req.session.flash = null;
  return { user: req.user, csrf: req.session.csrf, flash };
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch((e) => handleError(e, req, res));
  } catch (e) {
    handleError(e, req, res);
  }
};

function handleError(e, req, res) {
  if (e instanceof UserError) {
    flash(req, 'error', e.message);
    return res.redirect(req.get('Referer') || '/');
  }
  console.error(e);
  res.status(500).send('Something went wrong. The error was logged.');
}

const requireAuth = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const requireRole = (...roles) => (req, res, next) =>
  req.user && roles.includes(req.user.role) ? next() : res.status(403).send('Not allowed.');

function notFound(res) {
  res.status(404).send('Not found.');
}

const loginAttempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const rec = (loginAttempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  loginAttempts.set(key, rec);
  return rec.length >= 10;
}


// ---------------------------------------------------------------- auth

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(views.login(ctx(req)));
});

app.post(
  '/login',
  wrap((req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = req.ip + '|' + email;
    if (tooManyAttempts(key)) {
      return res.status(429).send(views.login(ctx(req), 'Too many attempts. Try again in 15 minutes.'));
    }
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    // Compare against a dummy hash for unknown users so timing does not reveal which emails exist.
    const hash = u ? u.password_hash : '$2a$10$7EqJtq98hPqEX7fNZaFWoOa1hX4cG6Vf7sT0n7y3Y6mZy0kq1QJ5e';
    const ok = bcrypt.compareSync(String(req.body.password || ''), hash);
    if (!u || !ok) {
      loginAttempts.get(key).push(Date.now());
      return res.status(401).send(views.login(ctx(req), 'Incorrect email or password.'));
    }
    loginAttempts.delete(key);
    req.session = { uid: u.id, csrf: crypto.randomBytes(24).toString('hex') };
    audit(u, 'user.login', 'user', u.id, null, null);
    res.redirect('/');
  })
);

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

app.use(requireAuth);

// ---------------------------------------------------------------- home & account

app.get(
  '/',
  wrap((req, res) => {
    const pending = wf.queueFor(req.user, wf.listRequests(req.user)).length;
    res.send(views.home(ctx(req), pending));
  })
);

app.get('/account', (req, res) => res.send(views.account(ctx(req))));

app.post(
  '/account',
  wrap((req, res) => {
    const tz = String(req.body.timezone || '');
    if (!wf.isValidTz(tz)) throw new UserError('Choose a valid time zone.');
    const pw = String(req.body.password || '');
    if (pw && pw.length < 10) throw new UserError('Passwords need at least 10 characters.');
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(tz, req.user.id);
    if (pw) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), req.user.id);
    audit(req.user, 'user.account_updated', 'user', req.user.id, null, { timezone: tz, passwordChanged: !!pw });
    flash(req, 'success', 'Saved.');
    res.redirect('/account');
  })
);

// ---------------------------------------------------------------- requests

app.get('/request', (req, res) => res.send(views.requestChooser(ctx(req))));

const NEW_TYPES = ['new_spif', 'recurring_spif', 'bonus', 'adjustment'];

app.get(
  '/requests/new',
  wrap((req, res) => {
    const type = String(req.query.type || '');
    if (!NEW_TYPES.includes(type)) return res.redirect('/request');
    let values = {};
    let savedId = null;
    let lockName = false;
    let existingFiles = [];
    if (type === 'recurring_spif') {
      if (!req.query.saved) return res.redirect('/saved');
      const s = wf.recurringSource(req.user, req.query.saved);
      values = { ...s.data, name: s.name };
      savedId = s.id;
      lockName = true;
      existingFiles = savedAttachments(s);
    }
    res.send(
      views.requestForm(ctx(req), {
        type,
        values,
        errors: {},
        action: '/requests',
        submitLabel: 'Submit for approval',
        savedId,
        lockName,
        existingFiles,
        keptIds: existingFiles.map((a) => String(a.id)),
      })
    );
  })
);

// Attachments that belong to the terms being resubmitted (the source request's current version).
function savedAttachments(source) {
  return wf.attachmentsFor(source.id, source.current_version);
}

app.post(
  '/requests',
  handleUpload,
  wrap((req, res) => {
    try {
      const type = String(req.body.type || '');
      if (!NEW_TYPES.includes(type)) throw new UserError('Unknown request type.');
      let saved = null;
      let existing = [];
      if (type === 'recurring_spif') {
        saved = wf.recurringSource(req.user, req.body.saved_id);
        existing = savedAttachments(saved);
      }
      const kept = keptRows(req, existing);
      const uploaded = uploadedRecords(req);
      const { errors, data } = wf.validate(type, req.body, req.user, {
        fixedName: saved ? saved.name : null,
      });
      if (Object.keys(errors).length) {
        removeTempFiles(req);
        const values = { ...req.body };
        if (saved) values.name = saved.name;
        return res.status(400).send(
          views.requestForm(ctx(req), {
            type,
            values,
            errors,
            action: '/requests',
            submitLabel: 'Submit for approval',
            savedId: saved ? saved.id : null,
            lockName: !!saved,
            existingFiles: existing,
            keptIds: kept.map((a) => String(a.id)),
            reattach: uploaded.length > 0,
          })
        );
      }
      if (data.bonus_kind === 'mbo') {
        removeTempFiles(req);
        const mboId = wf.createMbo(req.user, data);
        notifyRequest(req, mboId);
        flash(req, 'success', 'Monthly MBO recorded. It does not need approval.');
        return res.redirect('/requests/' + mboId);
      }
      const id = wf.createRequest(req.user, type, data, saved ? saved.standing : null, uploaded, kept);
      notifyRequest(req, id);
      flash(req, 'success', 'Request submitted.');
      res.redirect('/requests/' + id);
    } catch (e) {
      removeTempFiles(req);
      throw e;
    }
  })
);

app.get(
  '/requests',
  wrap((req, res) => {
    const rows = wf.listRequests(req.user);
    res.send(views.requestList(ctx(req), rows, wf.queueFor(req.user, rows), wf.repAmountTotals()));
  })
);

function loadVisible(req, res) {
  const r = wf.getRequest(Number(req.params.id));
  if (!r || !wf.canView(req.user, r)) {
    notFound(res);
    return null;
  }
  return r;
}

app.get(
  '/requests/:id',
  wrap((req, res) => {
    const r = loadVisible(req, res);
    if (!r) return;
    const data = wf.currentData(r);
    res.send(
      views.requestDetail(ctx(req), {
        r,
        data,
        versions: wf.getVersions(r.id),
        attachments: db.prepare('SELECT * FROM attachments WHERE request_id = ? ORDER BY id').all(r.id),
        steps: wf.getSteps(r.id),
        actions: wf.availableActions(req.user, r, data),
        auditRows: db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id').all(r.id),
        results: db.prepare('SELECT * FROM results WHERE request_id = ?').get(r.id),
        repAmounts: wf.getRepAmounts(r.id),
        reps: wf.getReps(),
        canEditRepAmounts: wf.canEditRepAmounts(req.user, r),
      })
    );
  })
);

app.get(
  '/requests/:id/edit',
  wrap((req, res) => {
    const r = loadVisible(req, res);
    if (!r) return;
    if (r.submitter_id !== req.user.id || r.status !== 'returned') throw new UserError('This request cannot be edited.');
    const existing = wf.attachmentsFor(r.id, r.current_version);
    res.send(
      views.requestForm(ctx(req), {
        type: r.type,
        values: wf.currentData(r),
        errors: {},
        action: `/requests/${r.id}/edit`,
        submitLabel: 'Resubmit for approval',
        lockName: r.type === 'recurring_spif',
        requestId: r.id,
        existingFiles: existing,
        keptIds: existing.map((a) => String(a.id)),
      })
    );
  })
);

app.post(
  '/requests/:id/edit',
  handleUpload,
  wrap((req, res) => {
    try {
      const r = loadVisible(req, res);
      if (!r) return removeTempFiles(req);
      if (r.submitter_id !== req.user.id || r.status !== 'returned') throw new UserError('This request cannot be edited.');
      const existing = wf.attachmentsFor(r.id, r.current_version);
      const kept = keptRows(req, existing);
      const uploaded = uploadedRecords(req);
      const { errors, data } = wf.validate(r.type, req.body, req.user, {
        excludeId: r.id,
        fixedName: r.type === 'recurring_spif' ? r.name : null,
      });
      if (Object.keys(errors).length) {
        removeTempFiles(req);
        return res.status(400).send(
          views.requestForm(ctx(req), {
            type: r.type,
            values: { ...req.body, name: r.type === 'recurring_spif' ? r.name : req.body.name },
            errors,
            action: `/requests/${r.id}/edit`,
            submitLabel: 'Resubmit for approval',
            lockName: r.type === 'recurring_spif',
            requestId: r.id,
            existingFiles: existing,
            keptIds: kept.map((a) => String(a.id)),
            reattach: uploaded.length > 0,
          })
        );
      }
      wf.resubmitRequest(req.user, r.id, data, uploaded, kept);
      notifyRequest(req, r.id);
      flash(req, 'success', 'Resubmitted for approval.');
      res.redirect('/requests/' + r.id);
    } catch (e) {
      removeTempFiles(req);
      throw e;
    }
  })
);

// Download an attached document. Only people who can see the request may fetch it.
app.get(
  '/attachments/:id',
  wrap((req, res) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
    const r = a && wf.getRequest(a.request_id);
    if (!a || !r || !wf.canView(req.user, r)) return notFound(res);
    const file = path.join(uploadDir, path.basename(a.stored_name));
    if (!fs.existsSync(file)) return notFound(res);
    res.download(file, a.original_name);
  })
);

// after(req, requestId, result) runs once the action succeeded (used for Slack notifications).
const actionRoute = (name, fn, okMsg, after) =>
  app.post(
    `/requests/:id/${name}`,
    wrap((req, res) => {
      const r = loadVisible(req, res);
      if (!r) return;
      const result = fn(req.user, r.id, req.body);
      if (after) after(req, r.id, result);
      flash(req, 'success', okMsg);
      res.redirect('/requests/' + r.id);
    })
  );

actionRoute('finance', wf.financeDecide, 'Finance decision recorded.', notifyRequest);
actionRoute('approver', wf.approverDecide, 'Approver decision recorded.', notifyRequest);
actionRoute('skip', wf.adminSkip, 'Step skipped and logged.', notifyRequest);
actionRoute('cancel', wf.cancelRequest, 'Request cancelled.');
actionRoute('results', wf.submitResults, 'Results submitted. The request is finalized.');
actionRoute('rep-amounts', wf.saveRepAmounts, 'Rep amounts saved.', (req, id, changed) => {
  if (changed) notifyRepAmounts(req, id, req.user);
});

// ---------------------------------------------------------------- saved recurring SPIFs

app.get(
  '/saved',
  wrap((req, res) => {
    res.send(views.savedList(ctx(req), wf.recurringSources(req.user)));
  })
);

// :id is the request being resubmitted (the newest approved request for that SPIF name).
app.post(
  '/saved/:id/resubmit',
  wrap((req, res) => {
    const s = wf.recurringSource(req.user, req.params.id);
    // Everything is prefilled from the previous run; the submitter only supplies the new dates.
    const input = { ...s.data, name: s.name };
    for (const k of ['start_date', 'end_date']) input[k] = req.body[k];
    // Documents attached to the approved terms carry over unchanged.
    const carried = savedAttachments(s);
    const { errors, data } = wf.validate('recurring_spif', input, req.user, { fixedName: s.name });
    if (Object.keys(errors).length) {
      throw new UserError(Object.values(errors).join(' ') + ' Use "Resubmit with changes" to update the terms.');
    }
    const id = wf.createRequest(req.user, 'recurring_spif', data, s.standing, [], carried);
    const row = wf.getRequest(id);
    notifyRequest(req, id);
    flash(
      req,
      'success',
      row.status === 'approved'
        ? `Resubmitted. Terms are unchanged and covered by the approval through ${wf.halfYearLabel(row.approval_through)}, so review was skipped.`
        : 'Resubmitted. It goes through approval again.'
    );
    res.redirect('/requests/' + id);
  })
);

app.post(
  '/saved/:id/revoke',
  requireRole('admin'),
  wrap((req, res) => {
    const s = wf.recurringSource(req.user, req.params.id);
    if (!s.standing) throw new UserError('This SPIF has no half-year approval to revoke.');
    db.prepare('UPDATE saved_spifs SET approved_indefinitely = 0, approved_through = NULL, active = 0 WHERE id = ?').run(
      s.standing.id
    );
    audit(req.user, 'saved_spif.revoked', 'saved_spif', s.standing.id, null, {
      name: s.name,
      through: s.standing.approved_through,
    });
    flash(req, 'success', `${s.name} was deactivated and its half-year approval revoked.`);
    res.redirect('/saved');
  })
);

// ---------------------------------------------------------------- reports & audit

app.get(
  '/reports',
  wrap((req, res) => {
    if (req.user.role !== 'admin') return res.send(views.reportsComingSoon(ctx(req)));
    const nowYear = Number(wf.todayIn(req.user.timezone).slice(0, 4));
    const minRow = db.prepare('SELECT MIN(substr(created_at, 1, 4)) AS y FROM requests').get();
    const minYear = Math.min(minRow && minRow.y ? Number(minRow.y) : nowYear, nowYear);
    const years = [];
    for (let y = minYear; y <= nowYear + 1; y++) years.push(y);
    let year = parseInt(req.query.year, 10);
    if (!years.includes(year)) year = nowYear;
    res.send(views.reports(ctx(req), wf.reportData(req.user, year), year, years));
  })
);

app.get(
  '/audit',
  (req, res, next) =>
    ['admin', 'finance'].includes(req.user.role) || wf.isApprover(req.user) ? next() : res.status(403).send('Not allowed.'),
  wrap((req, res) => {
    const reqId = parseInt(req.query.request, 10);
    const rows = reqId
      ? db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id DESC LIMIT 500').all(reqId)
      : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
    res.send(views.auditPage(ctx(req), rows, reqId || null));
  })
);

// ---------------------------------------------------------------- admin

const ROLES = ['submitter', 'finance', 'admin'];

app.get(
  '/admin',
  requireRole('admin'),
  wrap((req, res) => {
    res.send(
      views.admin(ctx(req), {
        users: db.prepare('SELECT * FROM users ORDER BY active DESC, name').all(),
        pendingRows: wf.listRequests(req.user).filter((r) => wf.PENDING.includes(r.status)),
        saved: wf.recurringSources(req.user),
      })
    );
  })
);

// Quote a CSV cell; a leading = + - @ is prefixed so spreadsheets do not run it as a formula.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

app.get(
  '/admin/saved-spifs.csv',
  requireRole('admin'),
  wrap((req, res) => {
    const rows = db
      .prepare(
        `SELECT s.*, o.name AS owner_name, o.email AS owner_email, a.name AS approved_by_name
         FROM saved_spifs s
         JOIN users o ON o.id = s.owner_id
         LEFT JOIN users a ON a.id = s.approved_by
         ORDER BY s.name`
      )
      .all();
    const header = [
      'ID',
      'Name',
      'Type',
      'Owner',
      'Owner email',
      'Active',
      'Approved through',
      'Approved by',
      'Approved at',
      'Classification',
      'Classification reasoning',
      'Source request',
      'Source version',
      'Created at',
      ...wf.TERM_FIELDS,
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const s of rows) {
      const terms = JSON.parse(s.terms_json);
      lines.push(
        [
          s.id,
          s.name,
          s.type,
          s.owner_name,
          s.owner_email,
          s.active ? 'Yes' : 'No',
          s.approved_through || (s.approved_indefinitely ? 'Indefinitely (old approval)' : ''),
          s.approved_by_name,
          s.approved_at,
          s.classification,
          s.classification_reasoning,
          s.source_request_id,
          s.source_version,
          s.created_at,
          ...wf.TERM_FIELDS.map((k) => (Array.isArray(terms[k]) ? terms[k].join('; ') : terms[k])),
        ]
          .map(csvCell)
          .join(',')
      );
    }
    audit(req.user, 'saved_spif.exported', 'saved_spif', null, null, { count: rows.length });
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="saved-spifs-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  })
);

function cleanUserInput(body, selfId) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const role = String(body.role || '');
  // Only standard users have a tier field; `tier` is null and callers keep the stored value (3 for new users).
  const tier = role !== 'submitter' ? null : Number(body.tier);
  const timezone = String(body.timezone || '');
  const password = String(body.password || '');
  const slackId = String(body.slack_id || '').trim();
  if (!name) throw new UserError('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Enter a valid email address.');
  if (!ROLES.includes(role)) throw new UserError('Choose a valid role.');
  if (role === 'submitter' && ![1, 2, 3].includes(tier)) throw new UserError('Choose a tier.');
  if (!wf.isValidTz(timezone)) throw new UserError('Choose a valid time zone.');
  if (password && password.length < 10) throw new UserError('Passwords need at least 10 characters.');
  if (slackId && !/^[UW][A-Z0-9]{6,}$/.test(slackId)) {
    throw new UserError('Slack member ID looks like U01ABCDE234. Find it in Slack under Profile, More, Copy member ID.');
  }
  // Reports: a tier 3 user needs a tier 2 and a tier 1 approver, a tier 2 user needs a tier 1 approver.
  // Their requests go to these people. Everyone else has none.
  let tier1Id = null;
  let tier2Id = null;
  const pick = (field, wantTier, label) => {
    const id = Number(body[field]);
    const p = id && db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role = 'submitter' AND tier = ?").get(id, wantTier);
    if (!p || p.id === selfId) throw new UserError(`Choose a tier ${wantTier} report (${label}).`);
    return p.id;
  };
  if (role === 'submitter' && tier === 3) {
    tier2Id = pick('tier2_id', 2, 'approver');
    tier1Id = pick('tier1_id', 1, 'approver');
  } else if (role === 'submitter' && tier === 2) {
    tier1Id = pick('tier1_id', 1, 'approver');
  }
  return { name, email, role, tier, tier1Id, tier2Id, timezone, password, slackId: slackId || null };
}

function constraintToUserError(e) {
  if (e && String(e.code).startsWith('SQLITE_CONSTRAINT')) return new UserError('That email address is already in use.');
  return e;
}

app.post(
  '/admin/users',
  requireRole('admin'),
  wrap((req, res) => {
    const u = cleanUserInput(req.body);
    if (!u.password) throw new UserError('A temporary password is required.');
    const tier = u.role === 'admin' ? 3 : u.tier || 3;
    try {
      const info = db
        .prepare(
          'INSERT INTO users (name, email, password_hash, role, tier, tier1_id, tier2_id, timezone, slack_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(u.name, u.email, bcrypt.hashSync(u.password, 10), u.role, tier, u.tier1Id, u.tier2Id, u.timezone, u.slackId);
      audit(req.user, 'user.created', 'user', info.lastInsertRowid, null, {
        email: u.email,
        role: u.role,
        tier,
        tier1_id: u.tier1Id,
        tier2_id: u.tier2Id,
      });
    } catch (e) {
      throw constraintToUserError(e);
    }
    flash(req, 'success', `Added ${u.name}.`);
    res.redirect('/admin');
  })
);

app.post(
  '/admin/users/:id',
  requireRole('admin'),
  wrap((req, res) => {
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!before) return notFound(res);
    const u = cleanUserInput(req.body, id);
    const active = req.body.active === '0' ? 0 : 1;
    if (id === req.user.id && (!active || u.role !== 'admin')) {
      throw new UserError('You cannot deactivate or demote yourself.');
    }
    const tier = u.role === 'admin' ? 3 : u.tier || before.tier;
    try {
      db.prepare(
        'UPDATE users SET name = ?, email = ?, role = ?, tier = ?, tier1_id = ?, tier2_id = ?, timezone = ?, slack_id = ?, active = ? WHERE id = ?'
      ).run(
        u.name,
        u.email,
        u.role,
        tier,
        u.tier1Id,
        u.tier2Id,
        u.timezone,
        u.slackId,
        active,
        id
      );
      if (u.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(u.password, 10), id);
    } catch (e) {
      throw constraintToUserError(e);
    }
    audit(req.user, 'user.updated', 'user', id, null, {
      before: { name: before.name, email: before.email, role: before.role, tier: before.tier, active: before.active, timezone: before.timezone, slack_id: before.slack_id, tier1_id: before.tier1_id, tier2_id: before.tier2_id },
      after: { name: u.name, email: u.email, role: u.role, tier, tier1_id: u.tier1Id, tier2_id: u.tier2Id, active, timezone: u.timezone, slack_id: u.slackId },
      passwordChanged: !!u.password,
    });
    flash(req, 'success', `Saved ${u.name}.`);
    res.redirect('/admin');
  })
);

// ---------------------------------------------------------------- fallbacks

app.use((req, res) => notFound(res));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. The error was logged.');
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`SPIF Process listening on ${port}; data in ${dataDir}`);
});
