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
      if (start && end) {
        var syncDates = function () {
          if (start.value) {
            end.min = start.value;
            end.max = lastDayOf(start.value);
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
    var tierCount = document.querySelector('[name=payout_tier_count]');
    var tier3 = document.getElementById('tier-3-wrap');
    var syncPayout = function () {
      for (var g = 0; g < groups.length; g++) groups[g].hidden = groups[g].getAttribute('data-payout-group') !== payout.value;
      if (tierCount && tier3) tier3.hidden = tierCount.value !== '3';
    };
    payout.addEventListener('change', syncPayout);
    if (tierCount) tierCount.addEventListener('change', syncPayout);
    syncPayout();
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

  // Admin: finance users have no tier.
  var roleSelects = document.querySelectorAll('select[name=role]');
  for (var r = 0; r < roleSelects.length; r++) {
    (function (sel) {
      var tierField = sel.form.querySelector('[data-tier-field]');
      if (!tierField) return;
      var syncTier = function () {
        tierField.hidden = sel.value === 'finance';
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
