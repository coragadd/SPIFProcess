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
      var bonusKind = form.querySelector('[name=bonus_kind]');
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

  // Bonus: show the regular-bonus fields or the monthly MBO fields, whichever is chosen.
  var kindSelect = document.querySelector('select[name=bonus_kind]');
  if (kindSelect) {
    var kindGroups = document.querySelectorAll('[data-bonus-group]');
    var syncKind = function () {
      for (var k = 0; k < kindGroups.length; k++) kindGroups[k].hidden = kindGroups[k].getAttribute('data-bonus-group') !== kindSelect.value;
    };
    kindSelect.addEventListener('change', syncKind);
    syncKind();
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

  // Admin: only standard users have a tier.
  var roleSelects = document.querySelectorAll('select[name=role]');
  for (var r = 0; r < roleSelects.length; r++) {
    (function (sel) {
      var tierField = sel.form.querySelector('[data-tier-field]');
      if (!tierField) return;
      var syncTier = function () {
        tierField.hidden = sel.value !== 'submitter';
      };
      sel.addEventListener('change', syncTier);
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

    repForm.addEventListener('submit', function (e) {
      var seen = {};
      var message = '';
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
})();
