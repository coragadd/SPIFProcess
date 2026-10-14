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

        // "All PODs" and the individual PODs are mutually exclusive.
        var boxes = form.querySelectorAll('[name=participants_pods]');
        for (var j = 0; j < boxes.length; j++) {
          boxes[j].addEventListener('change', function (e) {
            var changed = e.target;
            if (!changed.checked) return;
            for (var k = 0; k < boxes.length; k++) {
              if (boxes[k] === changed) continue;
              if (changed.value === 'All PODs' || boxes[k].value === 'All PODs') boxes[k].checked = false;
            }
          });
        }
      }
    })(forms[i]);
  }
})();
