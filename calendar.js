/*
 * calendar.js — month view for the outlook.
 *
 * The day pill, compressed into a month grid. Same verdict colours, same
 * mini busyness graph, same selection model — a calendar cell IS a day
 * pill with the sub-line and peak time dropped for room.
 *
 * The month view exists because the pipeline now keeps a compact archive
 * of every past day (pipeline/history.py, served by api/history.php).
 * The 7-day strip can only ever show today onward; the calendar is where
 * the accumulated history becomes visible.
 *
 * This module owns calendar arithmetic and DOM only. It holds no
 * forecast state and makes no network calls: app.js supplies days
 * through callbacks, so filters, verdict-follows-filter, and the
 * archived/live distinction all stay in one place.
 *
 * Public API:
 *   window.EFCalendar.render(host, opts)
 *   window.EFCalendar.monthOf(dateIso)   -> 'YYYY-MM'
 *   window.EFCalendar.addMonths(m, d)    -> 'YYYY-MM'
 *   window.EFCalendar.monthLabel(m, tz)  -> 'September 2026'
 *   window.EFCalendar.gridDates(month)   -> ['YYYY-MM-DD', ... 35 or 42]
 *
 * Dates are handled as plain YYYY-MM-DD strings throughout. Constructing
 * a Date from one and reading it back is a timezone trap — the browser
 * parses a bare ISO date as UTC and renders it in local time, which
 * silently shifts the whole grid by a day west of Greenwich. The only
 * Date objects here are built from explicit (year, monthIndex, day)
 * numbers, which are local by definition.
 */
(function () {
  'use strict';

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  // ─────────── date helpers ───────────

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function monthOf(dateIso) {
    return String(dateIso || '').slice(0, 7);
  }

  function parseMonth(monthIso) {
    var parts = String(monthIso || '').split('-');
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return null;
    return { y: y, m: m };
  }

  function addMonths(monthIso, delta) {
    var p = parseMonth(monthIso);
    if (!p) return monthIso;
    var idx = p.y * 12 + (p.m - 1) + (delta | 0);
    return Math.floor(idx / 12) + '-' + pad((idx % 12) + 1);
  }

  function monthLabel(monthIso) {
    var p = parseMonth(monthIso);
    if (!p) return '';
    return MONTHS[p.m - 1] + ' ' + p.y;
  }

  function daysInMonth(monthIso) {
    var p = parseMonth(monthIso);
    if (!p) return 0;
    return new Date(p.y, p.m, 0).getDate();
  }

  /*
   * Every date the grid shows, including the leading days of the
   * previous month and the trailing days of the next, so the grid is
   * always whole weeks. Returns 35 or 42 dates depending on how the
   * month falls — never a fixed 42, because a stray blank row reads as
   * a rendering bug.
   */
  function gridDates(monthIso) {
    var p = parseMonth(monthIso);
    if (!p) return [];
    var lead = new Date(p.y, p.m - 1, 1).getDay();
    var total = daysInMonth(monthIso);
    var cells = Math.ceil((lead + total) / 7) * 7;
    var out = [];
    for (var i = 0; i < cells; i++) {
      var d = new Date(p.y, p.m - 1, 1 + (i - lead));
      out.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
    }
    return out;
  }

  function compareMonth(a, b) {
    return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
  }

  // ─────────── DOM ───────────

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function verdictKey(verdict) {
    return String(verdict || '').toLowerCase();
  }

  function navButton(label, glyph, disabled) {
    var b = el('button', 'cal-nav');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(el('span', null, glyph));
    if (disabled) b.disabled = true;
    return b;
  }

  /*
   * Render the whole calendar into `host`.
   *
   * opts:
   *   month        'YYYY-MM' to display
   *   selected     currently selected date, or null
   *   today        today's date in the city's timezone
   *   forecastFor  fn(date) -> forecast-shaped object, or null
   *   isLive       fn(date) -> true when the day is in the live window
   *   verdictOf    fn(forecast) -> 'Quiet' | 'Moderate' | 'Busy' | 'Severe'
   *   summaryFor   fn(forecast) -> short string under the verdict
   *   drawSpark    fn(canvas, forecast) — mini graph, called after layout
   *   minMonth     earliest month worth offering, or null
   *   maxMonth     latest month worth offering, or null
   *   loading      true while the month's history is in flight
   *   onSelect     fn(date)
   *   onMonth      fn(month)
   */
  function render(host, opts) {
    if (!host) return;
    var o = opts || {};
    var month = o.month;
    var frag = document.createDocumentFragment();

    // ── header: month, arrows, jump-to-today ──
    var head = el('div', 'cal-head');

    var prevMonth = addMonths(month, -1);
    var nextMonth = addMonths(month, 1);
    var prevOff = o.minMonth ? compareMonth(prevMonth, o.minMonth) < 0 : false;
    var nextOff = o.maxMonth ? compareMonth(nextMonth, o.maxMonth) > 0 : false;

    var prev = navButton('Previous month', '‹', prevOff);
    var next = navButton('Next month', '›', nextOff);
    prev.addEventListener('click', function () {
      if (o.onMonth) o.onMonth(prevMonth);
    });
    next.addEventListener('click', function () {
      if (o.onMonth) o.onMonth(nextMonth);
    });

    var title = el('h2', 'cal-title', monthLabel(month));
    title.setAttribute('aria-live', 'polite');

    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);

    if (o.today && monthOf(o.today) !== month) {
      var jump = el('button', 'chip cal-today-btn', 'Today');
      jump.type = 'button';
      jump.addEventListener('click', function () {
        if (o.onMonth) o.onMonth(monthOf(o.today));
      });
      head.appendChild(jump);
    }
    if (o.loading) {
      head.appendChild(el('span', 'cal-loading', 'Loading…'));
    }
    frag.appendChild(head);

    // ── weekday header ──
    var dow = el('div', 'cal-dow');
    dow.setAttribute('aria-hidden', 'true');
    WEEKDAYS.forEach(function (d) { dow.appendChild(el('span', null, d)); });
    frag.appendChild(dow);

    // ── grid ──
    var grid = el('div', 'cal-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', monthLabel(month) + ' outlook');

    var dates = gridDates(month);
    var sparkJobs = [];

    dates.forEach(function (date) {
      var inMonth = monthOf(date) === month;
      var forecast = o.forecastFor ? o.forecastFor(date) : null;
      var dayNum = parseInt(date.slice(8), 10);

      // A day with no forecast behind it is inert: rendered so the grid
      // keeps its shape, but not a button and not focusable.
      if (!forecast) {
        var blank = el('div', 'cal-cell cal-cell--empty');
        if (!inMonth) blank.classList.add('cal-cell--outside');
        if (date === o.today) blank.classList.add('cal-cell--today');
        blank.appendChild(el('span', 'cal-cell__num', String(dayNum)));
        grid.appendChild(blank);
        return;
      }

      var verdict = o.verdictOf ? o.verdictOf(forecast) : forecast.verdict;
      var cell = el('button', 'cal-cell');
      cell.type = 'button';
      cell.setAttribute('data-date', date);
      cell.setAttribute('data-verdict', verdictKey(verdict));
      if (!inMonth) cell.classList.add('cal-cell--outside');
      if (date === o.today) cell.classList.add('cal-cell--today');
      if (o.isLive && o.isLive(date)) cell.classList.add('cal-cell--live');
      var isSelected = date === o.selected;
      cell.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      if (isSelected) cell.setAttribute('data-selected', 'true');

      var top = el('span', 'cal-cell__top');
      top.appendChild(el('span', 'cal-cell__num', String(dayNum)));
      // Verdict dot: shown only on phones, where a 43px cell has no room
      // for the word. The word stays in the DOM (visually hidden there)
      // and in the aria-label below, so nothing is lost to a reader.
      var dot = el('span', 'cal-cell__dot');
      dot.setAttribute('aria-hidden', 'true');
      top.appendChild(dot);
      if (date === o.today) top.appendChild(el('span', 'cal-cell__today', 'Today'));
      cell.appendChild(top);

      cell.appendChild(el('span', 'cal-cell__verdict', verdict));

      var spark = document.createElement('canvas');
      spark.className = 'cal-cell__spark';
      spark.setAttribute('aria-hidden', 'true');
      cell.appendChild(spark);
      sparkJobs.push({ canvas: spark, forecast: forecast });

      var summary = o.summaryFor ? o.summaryFor(forecast) : '';
      if (summary) {
        var sub = el('span', 'cal-cell__sub', summary);
        sub.title = summary;
        cell.appendChild(sub);
      }

      // The visible cell is a number and a word; assistive tech gets the
      // whole day in one label.
      cell.setAttribute('aria-label', [
        longDate(date),
        verdict,
        summary
      ].filter(Boolean).join(', '));

      grid.appendChild(cell);
    });

    frag.appendChild(grid);

    grid.addEventListener('click', function (evt) {
      var cell = evt.target && evt.target.closest && evt.target.closest('.cal-cell');
      if (!cell || cell.tagName !== 'BUTTON') return;
      var date = cell.getAttribute('data-date');
      if (date && o.onSelect) o.onSelect(date);
    });

    // Arrow keys walk the grid a day or a week at a time, skipping days
    // with no forecast; PageUp/PageDown page the month.
    grid.addEventListener('keydown', function (evt) {
      var step = 0;
      if (evt.key === 'ArrowRight') step = 1;
      else if (evt.key === 'ArrowLeft') step = -1;
      else if (evt.key === 'ArrowDown') step = 7;
      else if (evt.key === 'ArrowUp') step = -7;
      else if (evt.key === 'PageDown') {
        evt.preventDefault();
        if (o.onMonth && !nextOff) o.onMonth(nextMonth);
        return;
      } else if (evt.key === 'PageUp') {
        evt.preventDefault();
        if (o.onMonth && !prevOff) o.onMonth(prevMonth);
        return;
      } else {
        return;
      }

      var buttons = [].slice.call(grid.querySelectorAll('button.cal-cell'));
      if (!buttons.length) return;
      var focused = document.activeElement;
      var at = buttons.indexOf(focused);
      if (at < 0) return;
      evt.preventDefault();

      // Move by grid position, then fall forward to the nearest cell
      // that actually has a day behind it.
      var all = [].slice.call(grid.children);
      var pos = all.indexOf(focused) + step;
      var dir = step > 0 ? 1 : -1;
      while (pos >= 0 && pos < all.length && all[pos].tagName !== 'BUTTON') {
        pos += dir;
      }
      if (pos < 0 || pos >= all.length) return;
      var target = all[pos];
      if (target.tagName !== 'BUTTON') return;
      target.focus();
      var date = target.getAttribute('data-date');
      if (date && o.onSelect) o.onSelect(date);
    });

    host.innerHTML = '';
    host.appendChild(frag);

    // Canvases must be laid out before their pixel size is readable.
    if (o.drawSpark) {
      sparkJobs.forEach(function (job) {
        o.drawSpark(job.canvas, job.forecast);
      });
    }
    return sparkJobs;
  }

  function longDate(dateIso) {
    var p = String(dateIso).split('-');
    if (p.length !== 3) return dateIso;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return WEEKDAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  window.EFCalendar = {
    render: render,
    monthOf: monthOf,
    addMonths: addMonths,
    monthLabel: monthLabel,
    daysInMonth: daysInMonth,
    gridDates: gridDates,
    longDate: longDate
  };
})();
