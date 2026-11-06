// Small form helpers. The server re-checks every rule; this only makes the form friendlier.
(function () {
  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // Last day of the month for a YYYY-MM-DD string.
  function lastDayOf(value) {
    var parts = value.split('-');
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var last = new Date(year, month, 0).getDate();
    return year + '-' + pad(month) + '-' + pad(last);
  }

  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i++) {
    (function (form) {
      // End date: on or after the start date and within the same month.
      var start = form.querySelector('[name=start_date]');
      var end = form.querySelector('[name=end_date]');
      var bonusKind = form.getAttribute('data-bonus');
      if (start && end) {
        var syncDates = function () {
          if (start.value) {
            end.min = start.value;
            // Regular bonuses can span months but end by June 30 or December 31.
            end.max = bonusKind ? start.value.slice(0, 4) + (Number(start.value.slice(5, 7)) <= 6 ? '-06-30' : '-12-31') : lastDayOf(start.value);
          } else {
            end.removeAttribute('min');
            end.removeAttribute('max');
          }
        };
        start.addEventListener('change', syncDates);
        syncDates();
      }

      // Show the POD list for AEs and the name box for Individual.
      var group = form.querySelector('[name=participants_group]');
      if (group) {
        var podsWrap = form.querySelector('#pods-wrap');
        var indWrap = form.querySelector('#individual-wrap');
        var syncGroup = function () {
          podsWrap.hidden = group.value !== 'AEs';
          indWrap.hidden = group.value !== 'Individual';
        };
        group.addEventListener('change', syncGroup);
        syncGroup();

        // "All PODs" selects every colour; clearing any colour clears "All PODs".
        var boxes = form.querySelectorAll('[name=participants_pods]');
        var allBox = null;
        var colours = [];
        for (var j = 0; j < boxes.length; j++) {
          if (boxes[j].value === 'All PODs') allBox = boxes[j];
          else colours.push(boxes[j]);
        }
        var onChange = function (e) {
          var changed = e.target;
          if (changed === allBox) {
            for (var k = 0; k < colours.length; k++) colours[k].checked = allBox.checked;
          } else {
            var every = true;
            for (var m = 0; m < colours.length; m++) if (!colours[m].checked) every = false;
            allBox.checked = every;
          }
        };
        if (allBox) {
          for (var n = 0; n < boxes.length; n++) boxes[n].addEventListener('change', onChange);
        }
      }
    })(forms[i]);
  }

  // Payout type: show only the fields for the chosen type; tier 3 only when 3 tiers are picked.
  var payout = document.querySelector('[name=payout_structure]');
  if (payout) {
    var groups = document.querySelectorAll('[data-payout-group]');
    var syncPayout = function () {
      for (var g = 0; g < groups.length; g++) groups[g].hidden = groups[g].getAttribute('data-payout-group') !== payout.value;
    };
    payout.addEventListener('change', syncPayout);
    syncPayout();

    // Ranked: one amount box per rank, following the rank count.
    var rankCount = document.querySelector('[name=payout_rank_count]');
    var rankBox = document.getElementById('rank-amounts');
    if (rankCount && rankBox) {
      rankCount.addEventListener('input', function () {
        var n = parseInt(rankCount.value, 10);
        if (!(n >= 2)) return;
        n = Math.min(n, 50);
        while (rankBox.children.length > n) rankBox.removeChild(rankBox.lastElementChild);
        for (var i = rankBox.children.length + 1; i <= n; i++) {
          var wrap = document.createElement('div');
          wrap.className = 'field';
          wrap.innerHTML = '<label>Rank ' + i + ' payout amount ($)</label><input name="payout_rank" type="number" step="0.01">';
          rankBox.appendChild(wrap);
        }
      });
    }
  }

  // Finance: the concern box appears when "Report a concern" is checked.
  var concernBox = document.getElementById('has-concern');
  if (concernBox) {
    var concernWrap = document.getElementById('concern-wrap');
    var syncConcern = function () {
      concernWrap.hidden = !concernBox.checked;
    };
    concernBox.addEventListener('change', syncConcern);
    syncConcern();
  }

  // Admin: click a user's row to open its edit form underneath; click again (or Close) to fold it.
  var userLines = document.querySelectorAll('tr.user-line');
  for (var u = 0; u < userLines.length; u++) {
    (function (line) {
      var edit = line.nextElementSibling;
      var toggle = function () {
        edit.hidden = !edit.hidden;
        line.classList.toggle('open', !edit.hidden);
      };
      line.addEventListener('click', toggle);
      line.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      edit.querySelector('.user-cancel').addEventListener('click', toggle);
    })(userLines[u]);
  }

  // Admin: only standard users have a tier, and a tier 3 user needs tier 2 and tier 1 reports
  // (approvers), a tier 2 user needs a tier 1 report.
  var roleSelects = document.querySelectorAll('select[name=role]');
  for (var r = 0; r < roleSelects.length; r++) {
    (function (sel) {
      var tierField = sel.form.querySelector('[data-tier-field]');
      if (!tierField) return;
      var tierSelect = tierField.querySelector('select');
      var reportFields = sel.form.querySelectorAll('[data-report-field]');
      var syncTier = function () {
        var standard = sel.value === 'submitter';
        tierField.hidden = !standard;
        var tier = Number(tierSelect.value);
        for (var i = 0; i < reportFields.length; i++) {
          var needs = Number(reportFields[i].getAttribute('data-report-field'));
          reportFields[i].hidden = !(standard && (tier === 3 || (tier === 2 && needs === 1)));
        }
      };
      sel.addEventListener('change', syncTier);
      tierSelect.addEventListener('change', syncTier);
      syncTier();
    })(roleSelects[r]);
  }

  // Manage Incentives: add and remove rep rows, keep the total current, and catch mistakes
  // before the form is sent (a server error would otherwise discard what was typed).
  var repForm = document.getElementById('rep-form');
  if (repForm) {
    var repBody = document.getElementById('rep-rows');
    var repTemplate = document.getElementById('rep-row-template');
    var repError = document.getElementById('rep-error');
    var repTotal = document.getElementById('rep-total');

    var updateTotal = function () {
      var sum = 0;
      var amounts = repBody.querySelectorAll('[name=rep_amount]');
      for (var a = 0; a < amounts.length; a++) sum += parseFloat(amounts[a].value) || 0;
      repTotal.textContent = '$' + sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    document.getElementById('rep-add').addEventListener('click', function () {
      repBody.appendChild(repTemplate.content.cloneNode(true));
      repBody.lastElementChild.querySelector('select').focus();
    });
    repBody.addEventListener('click', function (e) {
      if (!e.target.classList.contains('rep-remove')) return;
      e.target.closest('tr').remove();
      updateTotal();
    });
    repBody.addEventListener('input', updateTotal);

    // CSV import: parse and check the whole file first, then load it into the table for review.
    // Nothing is saved until the form is submitted, and a file with any problem loads nothing.
    var csvInput = document.getElementById('amounts_csv');
    var csvErrors = document.getElementById('csv-errors');
    var parseCsv = function (text) {
      var rows = [], row = [], cell = '', quoted = false, src = text.replace(/^﻿/, '');
      for (var i = 0; i < src.length; i++) {
        var c = src[i];
        if (quoted) {
          if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
          else if (c === '"') quoted = false;
          else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && src[i + 1] === '\n') i++;
          row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }
      return rows;
    };
    var showCsvErrors = function (list) {
      csvErrors.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'err';
      p.textContent = 'Nothing was loaded. Fix these and choose the file again:';
      var ul = document.createElement('ul');
      ul.className = 'err';
      for (var i = 0; i < list.length; i++) {
        var li = document.createElement('li');
        li.textContent = list[i];
        ul.appendChild(li);
      }
      csvErrors.appendChild(p);
      csvErrors.appendChild(ul);
      csvErrors.hidden = false;
    };
    if (csvInput) {
      csvInput.addEventListener('change', function () {
        csvErrors.hidden = true;
        var file = csvInput.files[0];
        if (!file) return;
        if (!/\.csv$/i.test(file.name)) {
          showCsvErrors(['Choose a .csv file. Use the template download if you need a starting point.']);
          csvInput.value = '';
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var names = {};
          var opts = repTemplate.content.querySelectorAll('option');
          for (var o = 0; o < opts.length; o++) if (opts[o].value) names[opts[o].value.toLowerCase()] = opts[o].value;
          var grid = parseCsv(String(reader.result)).filter(function (r) {
            return r.some(function (c) { return c.trim() !== ''; });
          });
          var errors = [];
          var head = (grid[0] || []).map(function (h) { return h.trim().toLowerCase(); });
          var ci = head.indexOf('rep');
          var ai = head.indexOf('amount');
          var ni = head.indexOf('note');
          if (ci === -1 || ai === -1) {
            showCsvErrors(['The first row must be a header with "Rep" and "Amount" columns (and optionally "Note"). Download the template to start.']);
            csvInput.value = '';
            return;
          }
          var parsed = [];
          var seen = {};
          for (var r = 1; r < grid.length; r++) {
            var line = r + 1; // header is line 1
            var rawName = (grid[r][ci] || '').trim();
            var rawAmount = (grid[r][ai] || '').trim();
            var note = ni === -1 ? '' : (grid[r][ni] || '').trim();
            var name = names[rawName.toLowerCase()];
            if (!rawName) errors.push('Line ' + line + ': the Rep is blank.');
            else if (!name) errors.push('Line ' + line + ': "' + rawName + '" is not on the rep list.');
            else if (seen[name]) errors.push('Line ' + line + ': ' + name + ' is listed more than once (also on line ' + seen[name] + ').');
            else seen[name] = line;
            var cleaned = rawAmount.replace(/[$,\s]/g, '');
            if (!rawAmount) errors.push('Line ' + line + ': the Amount is blank' + (name ? ' for ' + name : '') + '.');
            else if (!/^\d+(\.\d+)?$/.test(cleaned)) errors.push('Line ' + line + ': "' + rawAmount + '" is not a number of 0 or more' + (name ? ' (' + name + ')' : '') + '.');
            parsed.push({ name: name, amount: cleaned, note: note });
          }
          if (!parsed.length) errors.push('The file has a header but no reps.');
          if (errors.length) {
            showCsvErrors(errors);
            csvInput.value = '';
            return;
          }
          var current = 0;
          var selects = repBody.querySelectorAll('select');
          for (var s = 0; s < selects.length; s++) if (selects[s].value) current++;
          if (current && !window.confirm('This replaces the ' + current + ' rep row(s) now in the table with the ' + parsed.length + ' from the file. Nothing is saved until you press Save. Replace them?')) {
            csvInput.value = '';
            return;
          }
          repBody.innerHTML = '';
          for (var k = 0; k < parsed.length; k++) {
            repBody.appendChild(repTemplate.content.cloneNode(true));
            var tr = repBody.lastElementChild;
            tr.querySelector('select').value = parsed[k].name;
            tr.querySelector('[name=rep_amount]').value = parsed[k].amount;
            tr.querySelector('[name=rep_note]').value = parsed[k].note;
          }
          updateTotal();
          csvInput.value = '';
          repError.hidden = true;
          csvErrors.innerHTML = '<p class="csv-ok"></p>';
          csvErrors.firstChild.textContent = 'Loaded ' + parsed.length + ' rep(s) from ' + file.name + '. Review the table, then press Save rep amounts.';
          csvErrors.hidden = false;
        };
        reader.readAsText(file);
      });
    }

    repForm.addEventListener('submit', function (e) {
      var seen = {};
      var message = '';
      // A submitter who calculates their own amounts must attach proof of the calculations.
      var proof = document.getElementById('justification_files');
      var typedRows = false;
      var rowSelects = repBody.querySelectorAll('select');
      for (var t = 0; t < rowSelects.length; t++) if (rowSelects[t].value) typedRows = true;
      if (
        proof &&
        repForm.getAttribute('data-needs-proof') === '1' &&
        repForm.getAttribute('data-has-proof') !== '1' &&
        !proof.files.length &&
        typedRows
      ) {
        e.preventDefault();
        repError.textContent =
          'Attach a screenshot or file showing how you calculated these amounts before saving. Because you calculate the payouts yourself, Rev Ops and finance need that proof to verify them.';
        repError.hidden = false;
        proof.focus();
        return;
      }
      var rows = repBody.querySelectorAll('tr');
      for (var n = 0; n < rows.length && !message; n++) {        var rep = rows[n].querySelector('select').value;
        var amount = rows[n].querySelector('[name=rep_amount]').value;
        var note = rows[n].querySelector('[name=rep_note]').value;
        if (!rep && !amount && !note) {
          rows[n].remove(); // an untouched blank row is simply dropped (rows is a static list)
          continue;
        }
        if (!rep) message = 'Row ' + (n + 1) + ': choose a rep, or remove the row.';
        else if (amount === '' || parseFloat(amount) < 0) message = rep + ': enter an amount of 0 or more.';
        else if (seen[rep]) message = rep + ' is listed more than once.';
        seen[rep] = true;
      }
      if (message) {
        e.preventDefault();
        repError.textContent = message;
        repError.hidden = false;
      }
    });
  }

  // Buttons with data-confirm ask before submitting (for example, Delete user).
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-confirm]');
    if (b && !window.confirm(b.getAttribute('data-confirm'))) e.preventDefault();
  });

  // Every file input also accepts a dropped file: drop onto the input's field (label, hint and all).
  var fileInputs = document.querySelectorAll('input[type=file]');
  Array.prototype.forEach.call(fileInputs, function (fi) {
    var zone = fi.closest('.field') || fi;
    var allowed = (fi.getAttribute('accept') || '')
      .split(',')
      .map(function (t) { return t.trim().toLowerCase(); })
      .filter(Boolean);
    var okType = function (f) {
      if (!allowed.length) return true;
      var name = f.name.toLowerCase();
      var mime = (f.type || '').toLowerCase();
      return allowed.some(function (t) {
        return t.charAt(0) === '.' ? name.slice(-t.length) === t : t.slice(-2) === '/*' ? mime.indexOf(t.slice(0, -1)) === 0 : mime === t;
      });
    };
    var hasFiles = function (e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    };
    zone.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.add('drop-over');
    });
    zone.addEventListener('dragleave', function (e) {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-over');
    });
    zone.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.remove('drop-over');
      var dropped = Array.prototype.filter.call(e.dataTransfer.files, okType);
      if (!fi.multiple) dropped = dropped.slice(0, 1);
      if (!dropped.length) {
        window.alert('That file type is not accepted here.');
        return;
      }
      var dt = new DataTransfer();
      dropped.forEach(function (f) { dt.items.add(f); });
      fi.files = dt.files;
      fi.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
})();
