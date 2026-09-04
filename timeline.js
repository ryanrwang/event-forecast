/*
 * Event Forecast — Day timeline (M3, reworked 2026-09-03).
 *
 * Hand-built canvas. NOT a charting library — the timeline is part of
 * the product's identity (overview §7). Renders the day's busyness
 * curve (smooth monotone interpolation through the 15-minute buckets),
 * the peak window, per-event In / Out bands, and a draggable
 * scrubber that emits bucket changes via the onBucketChange callback.
 *
 * Above the chart sits the RANGE BRUSH: a miniature of the whole
 * modeled day with two handles. Drag a handle to pick any start or end
 * time (15-minute steps), drag the window to slide it; the main chart,
 * the lanes, and the scrubber follow. The range is persisted. "All day"
 * resets to the full 26 hours; the default is 9 AM → 2 AM, or earlier
 * when the day has real early activity.
 *
 * Under the chart sit the STATION LANES: one row per station likely
 * packed, with a compact chip anchored at each busy window (line badge
 * + name, no times — the axis above says when). Hover or focus a chip
 * for the full details; click it to move the scrubber to that window.
 *
 * A modeled day is 26 hours (104 buckets): 12:00 AM through 2:00 AM
 * next morning, so late shows keep their tails.
 *
 *   window.EFTimeline.ensureTimeline(hostEl, onBucketChange)
 *   window.EFTimeline.setForecast(forecast, cityConfig)   // resets bucket
 *   window.EFTimeline.setStations(rows, options)          // lanes + toggles
 *   window.EFTimeline.setBucket(bucket)                   // external set
 *   window.EFTimeline.getBucket() -> int|null
 */
(function () {
  'use strict';

  var BUCKET_MIN = 15;
  var DEFAULT_BUCKETS = 96;
  // Default range starts at 9 AM; the overnight hours before it are
  // hidden unless the day has real early activity.
  var DAY_START_BUCKET = 9 * 4;
  var RANGE_KEY = 'eventforecast.timelineRange';
  // Early activity above this share of the day's peak pulls the default
  // range start down to that hour, so a 6 AM marathon still shows.
  var EARLY_ACTIVITY_FRAC = 0.10;
  // Narrowest range the brush allows: 2 hours.
  var MIN_SPAN = 8;

  // Avoid windows are SERVER-COMPUTED — see pipeline/timecurves.py
  // `build_avoid_windows`. forecast.avoid_windows[] carries {event_id,
  // kind, from_bucket, to_bucket, from_minute, to_minute}, the single
  // source of truth for the bands here AND the station flags.

  // Layout (CSS pixels). The brush and the lanes use the same side
  // margins so everything lines up with the plot.
  var ML = 16, MR = 16, MT = 16, MB = 24;

  // Module-private state
  var _host = null;
  var _wrap = null;
  var _readout = null;
  var _chips = null;
  var _peakChip = null;
  var _nowChip = null;
  var _allDayChip = null;
  var _fitChip = null;
  var _toggleHost = null;
  var _canvas = null;
  var _ctx = null;
  var _brush = null;
  var _brushCanvas = null;
  var _brushCtx = null;
  var _brushSel = null;
  var _hFrom = null;
  var _hTo = null;
  var _brushDrag = null;
  var _lanes = null;
  var _scrubLine = null;
  var _pop = null;
  var _pinnedChip = null;
  var _ro = null;
  var _onBucketChange = null;
  var _forecast = null;
  var _cityConfig = null;
  var _rows = [];
  var _emptyText = '';
  var _bucket = null;
  var _dragging = false;
  // Persisted custom range {from, to} in buckets (to exclusive), or
  // null for the default.
  var _range = loadRange();

  // ─────────── small utils ───────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function loadRange() {
    try {
      var parsed = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (parsed && typeof parsed.from === 'number' && typeof parsed.to === 'number') return parsed;
    } catch (_) {}
    return null;
  }

  function saveRange(range) {
    try {
      if (range) localStorage.setItem(RANGE_KEY, JSON.stringify(range));
      else localStorage.removeItem(RANGE_KEY);
    } catch (_) {}
  }

  function tokenColor(path, fallback) {
    try {
      var parts = path.split('.');
      var node = window.TOKENS && window.TOKENS.semantic;
      for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
      return (typeof node === 'string' && node) ? node : fallback;
    } catch (_) { return fallback; }
  }

  function verdictColor(verdict) {
    var key = (verdict || '').toLowerCase();
    if (key === 'quiet')    return tokenColor('color.verdict.quiet', '#22C55E');
    if (key === 'moderate') return tokenColor('color.verdict.moderate', '#EAB308');
    if (key === 'busy')     return tokenColor('color.verdict.busy', '#F97316');
    if (key === 'severe')   return tokenColor('color.verdict.severe', '#EF4444');
    return tokenColor('color.text.accent', '#34D399');
  }

  // RGB → rgba string with alpha. The canvas API doesn't accept the
  // "rgba()" + hex shorthand so we expand here.
  function hexToRgba(hex, a) {
    if (!hex) return 'rgba(0,0,0,' + a + ')';
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 0xff) + ',' + ((n >> 8) & 0xff) + ',' + (n & 0xff) + ',' + a + ')';
  }

  var FONT_FALLBACK = '"IBM Plex Sans", "Segoe UI", Helvetica, sans-serif';

  // ─────────── time / bucket helpers ───────────

  function bucketCount() {
    var n = _forecast && _forecast.timeline ? _forecast.timeline.length : 0;
    return n > 0 ? n : DEFAULT_BUCKETS;
  }

  // 12-hour clock — the one time format the whole UI uses. Minutes past
  // 1440 are the next morning (bucket 96+).
  function clock12(mins) {
    var m = ((Math.round(mins) % (24 * 60)) + 24 * 60) % (24 * 60);
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    var h12 = hh % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (hh >= 12 ? 'PM' : 'AM');
  }

  function hourLabel12(hh) {
    var h = ((hh % 24) + 24) % 24;
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ' ' + (h >= 12 ? 'PM' : 'AM');
  }

  // Axis tick label: whole hours read "6 PM", anything finer "6:30 PM".
  function tickLabel(hours) {
    return (hours === Math.floor(hours)) ? hourLabel12(hours) : clock12(hours * 60);
  }

  function bucketLabel(bucket) {
    var b = clamp(bucket || 0, 0, bucketCount() - 1);
    return clock12(b * BUCKET_MIN);
  }

  // Current bucket for the displayed day, or null if "now" isn't inside
  // the day's 26-hour span in the city's tz. Uses Intl rather than Date
  // math to avoid DST land mines.
  function nowBucketForDate(dateIso, tz) {
    if (!dateIso || !tz) return null;
    var parts;
    try {
      var fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      parts = fmt.formatToParts(new Date());
    } catch (_) { return null; }
    var bag = {};
    for (var i = 0; i < parts.length; i++) bag[parts[i].type] = parts[i].value;
    var todayIso = bag.year + '-' + bag.month + '-' + bag.day;
    var hh = parseInt(bag.hour, 10);
    var mm = parseInt(bag.minute, 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    if (hh === 24) hh = 0;
    var deltaDays = Math.round(
      (new Date(todayIso + 'T00:00:00Z') - new Date(dateIso + 'T00:00:00Z')) / 86400000
    );
    var minutes = deltaDays * 24 * 60 + hh * 60 + mm;
    if (minutes < 0 || minutes >= bucketCount() * BUCKET_MIN) return null;
    return Math.floor(minutes / BUCKET_MIN);
  }

  function bucketsFromWindow(w) {
    if (!w) return null;
    var from = (typeof w.from_bucket === 'number') ? w.from_bucket : null;
    var to   = (typeof w.to_bucket   === 'number') ? w.to_bucket   : null;
    if (from == null || to == null || to <= from) return null;
    return { from: from, to: to };
  }

  // Contiguous run around the peak bucket where the timeline stays
  // above PEAK_BAND_FRAC × peak_value — the "peak window" band.
  var PEAK_BAND_FRAC = 0.85;
  function peakWindow(timeline, peakBucket, peakValue) {
    if (!timeline || !timeline.length || peakValue <= 0) {
      return { from: peakBucket, to: peakBucket };
    }
    var floor = peakValue * PEAK_BAND_FRAC;
    var lo = peakBucket, hi = peakBucket;
    while (lo > 0 && timeline[lo - 1] >= floor) lo--;
    while (hi < timeline.length - 1 && timeline[hi + 1] >= floor) hi++;
    return { from: lo, to: hi + 1 };  // exclusive end for half-open range
  }

  // ─────────── Visible range ───────────

  // Default {from, to}: 9 AM to the end of the modeled day, pulled
  // earlier when the day has real activity before 9 AM.
  function defaultRange() {
    var n = bucketCount();
    var start = Math.min(DAY_START_BUCKET, n);
    if (_forecast) {
      var timeline = _forecast.timeline || [];
      var peak = _forecast.peak_value || 0;
      if (peak > 0) {
        for (var b = 0; b < start; b++) {
          if (timeline[b] >= peak * EARLY_ACTIVITY_FRAC) {
            start = Math.floor(b / 4) * 4;  // round down to the hour
            break;
          }
        }
      }
    }
    return { from: start, to: n };
  }

  // {from, to} bucket range (to exclusive) currently drawn.
  function visibleRange() {
    var n = bucketCount();
    var r = _range ? { from: _range.from, to: _range.to } : defaultRange();
    r.from = clamp(Math.round(r.from), 0, n - MIN_SPAN);
    r.to = clamp(Math.round(r.to), r.from + MIN_SPAN, n);
    return r;
  }

  function isFullDay(vis) {
    return vis.from === 0 && vis.to === bucketCount();
  }

  // Tightest range around the day's activity: the curve above 5 % of
  // the peak plus every In / Out window, padded an hour each side and
  // rounded to the hour. Falls back to the default on an empty day.
  var FIT_ACTIVITY_FRAC = 0.05;
  function activityRange() {
    var n = bucketCount();
    if (!_forecast) return defaultRange();
    var timeline = _forecast.timeline || [];
    var peak = _forecast.peak_value || 0;
    var lo = Infinity, hi = -Infinity;
    if (peak > 0) {
      for (var b = 0; b < n; b++) {
        if (timeline[b] >= peak * FIT_ACTIVITY_FRAC) {
          if (b < lo) lo = b;
          if (b + 1 > hi) hi = b + 1;
        }
      }
    }
    (_forecast.avoid_windows || []).forEach(function (w) {
      var r = bucketsFromWindow(w);
      if (!r) return;
      if (r.from < lo) lo = Math.floor(r.from);
      if (r.to > hi) hi = Math.ceil(r.to);
    });
    if (!isFinite(lo) || !isFinite(hi)) return defaultRange();
    lo = Math.max(0, Math.floor((lo - 4) / 4) * 4);
    hi = Math.min(n, Math.ceil((hi + 4) / 4) * 4);
    if (hi - lo < MIN_SPAN) hi = Math.min(n, lo + MIN_SPAN);
    return { from: lo, to: hi };
  }

  function updateFitChip() {
    if (!_fitChip || !_forecast) return;
    var vis = visibleRange();
    var fit = activityRange();
    _fitChip.setAttribute('aria-pressed', (vis.from === fit.from && vis.to === fit.to) ? 'true' : 'false');
  }

  // Apply a new range (persisted), keep the scrubber inside it, and
  // redraw the chart, brush, and lanes.
  function setRange(from, to, persist) {
    var n = bucketCount();
    from = clamp(Math.round(from), 0, n - MIN_SPAN);
    to = clamp(Math.round(to), from + MIN_SPAN, n);
    _range = { from: from, to: to };
    if (persist) saveRange(_range);
    refreshRange();
  }

  function clearRange() {
    _range = null;
    saveRange(null);
    refreshRange();
  }

  function refreshRange() {
    var vis = visibleRange();
    if (typeof _bucket === 'number' && (_bucket < vis.from || _bucket >= vis.to)) {
      setBucket(clamp(_bucket, vis.from, vis.to - 1), true);
    }
    draw();
    drawBrush();
    updateAllDayChip();
    updateFitChip();
    layoutLanes();
  }

  // Slide the range (keeping its width) so `bucket` is inside it.
  function bringIntoRange(bucket) {
    var vis = visibleRange();
    if (bucket >= vis.from && bucket < vis.to) return;
    var span = vis.to - vis.from;
    var from = clamp(bucket - Math.floor(span / 2), 0, bucketCount() - span);
    setRange(from, from + span, true);
  }

  // ─────────── Canvas geometry ───────────

  function fitCanvas(canvas, ctx, minH) {
    if (!canvas) return null;
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(200, Math.floor(rect.width));
    var h = Math.max(minH || 20, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function bucketToX(b, size, vis) {
    var inner = size.w - ML - MR;
    return ML + ((b - vis.from) / (vis.to - vis.from)) * inner;
  }

  function xToBucket(x, size, vis) {
    var inner = size.w - ML - MR;
    var raw = vis.from + Math.floor(((x - ML) / inner) * (vis.to - vis.from));
    return clamp(raw, vis.from, vis.to - 1);
  }

  function valueToY(v, plotTop, plotBot, maxV) {
    var t = maxV > 0 ? clamp(v / maxV, 0, 1) : 0;
    return plotBot - t * (plotBot - plotTop);
  }

  // Fraction [0, 1] of the visible axis for a bucket position — the
  // lanes are laid out in percentages so they never need a re-measure.
  function bucketToFrac(b, vis) {
    return clamp((b - vis.from) / (vis.to - vis.from), 0, 1);
  }

  // ─────────── Smooth curve ───────────

  // Monotone cubic (Fritsch–Carlson) through the bucket centres: smooth
  // without overshooting below zero or inventing bumps between buckets.
  // Appends bezier segments to the current path, which must already be
  // at pts[0].
  function monotoneSegments(ctx, pts) {
    var n = pts.length;
    if (n < 2) return;
    var dx = [], m = [], i;
    for (i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1].x - pts[i].x;
      m[i] = dx[i] ? (pts[i + 1].y - pts[i].y) / dx[i] : 0;
    }
    var t = new Array(n);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (i = 1; i < n - 1; i++) {
      t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
    }
    for (i = 0; i < n - 1; i++) {
      if (m[i] === 0) {
        t[i] = 0;
        t[i + 1] = 0;
      } else {
        var a = t[i] / m[i], b = t[i + 1] / m[i];
        var s = a * a + b * b;
        if (s > 9) {
          var tau = 3 / Math.sqrt(s);
          t[i] = tau * a * m[i];
          t[i + 1] = tau * b * m[i];
        }
      }
    }
    for (i = 0; i < n - 1; i++) {
      var h = dx[i];
      ctx.bezierCurveTo(
        pts[i].x + h / 3, pts[i].y + t[i] * h / 3,
        pts[i + 1].x - h / 3, pts[i + 1].y - t[i + 1] * h / 3,
        pts[i + 1].x, pts[i + 1].y
      );
    }
  }

  // Points for the curve over [from, to): one per bucket centre, plus
  // edge points so the line meets both sides of the plot.
  function curvePoints(timeline, from, to, xOf, yOf) {
    var pts = [];
    pts.push({ x: xOf(from), y: yOf(timeline[from] || 0) });
    for (var b = from; b < to; b++) {
      pts.push({ x: xOf(b + 0.5), y: yOf(timeline[b] || 0) });
    }
    pts.push({ x: xOf(to), y: yOf(timeline[to - 1] || 0) });
    return pts;
  }

  function strokeAndFillCurve(ctx, pts, plotBot, strokeStyle, fillStyle, lineWidth) {
    if (!pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, plotBot);
    ctx.lineTo(pts[0].x, pts[0].y);
    monotoneSegments(ctx, pts);
    ctx.lineTo(pts[pts.length - 1].x, plotBot);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    monotoneSegments(ctx, pts);
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ─────────── Main chart ───────────

  function draw() {
    if (!_ctx || !_forecast) return;
    var size = fitCanvas(_canvas, _ctx, 80);
    if (!size) return;
    var vis = visibleRange();

    var timeline = _forecast.timeline || [];
    var peakValue = _forecast.peak_value || 0;
    var peakBucket = (typeof _forecast.peak_bucket === 'number') ? _forecast.peak_bucket : 0;
    var verdict = _forecast.verdict;

    var W = size.w, H = size.h;
    var plotTop = MT, plotBot = H - MB;

    _ctx.clearRect(0, 0, W, H);

    // Hour grid. Pick the finest step (15 min … 6 h) whose labels stay
    // at least 64 px apart, so a zoomed-in range gets finer ticks. The
    // range ends get a label only when it won't collide.
    var spanHours = (vis.to - vis.from) / 4;
    var inner = W - ML - MR;
    var pxPerHour = inner / spanHours;
    var steps = [0.25, 0.5, 1, 2, 3, 6];
    var step = 6;
    for (var si = 0; si < steps.length; si++) {
      if (steps[si] * pxPerHour >= 64) { step = steps[si]; break; }
    }
    var startHour = vis.from / 4;
    var lastHour = vis.to / 4;
    var firstHour = Math.ceil(startHour / step - 1e-9) * step;
    var ticks = [];
    for (var hr = firstHour; hr <= lastHour + 1e-9; hr += step) ticks.push(Math.round(hr * 4) / 4);
    var MIN_LABEL_PX = 48;
    if (ticks.length === 0 || (ticks[0] - startHour) * pxPerHour >= MIN_LABEL_PX) {
      if (ticks[0] !== startHour) ticks.unshift(startHour);
    }
    if ((lastHour - ticks[ticks.length - 1]) * pxPerHour >= MIN_LABEL_PX) {
      ticks.push(lastHour);
    }

    _ctx.strokeStyle = tokenColor('color.border.subtle', '#1C232E');
    _ctx.lineWidth = 1;
    for (var t = 0; t < ticks.length; t++) {
      var bx = bucketToX(ticks[t] * 4, size, vis);
      _ctx.beginPath();
      _ctx.moveTo(Math.round(bx) + 0.5, plotTop);
      _ctx.lineTo(Math.round(bx) + 0.5, plotBot);
      _ctx.stroke();
    }

    // Per-event In / Out bands. Aggregate the alpha so overlapping
    // events darken naturally.
    var arrivalFill   = tokenColor('color.status.info',    '#38BDF8');
    var dispersalFill = tokenColor('color.status.warning', '#EAB308');
    var avoidWindows = _forecast.avoid_windows || [];
    for (var i = 0; i < avoidWindows.length; i++) {
      var rng = bucketsFromWindow(avoidWindows[i]);
      if (!rng || rng.to <= vis.from || rng.from >= vis.to) continue;
      var kind = avoidWindows[i].kind;
      _ctx.fillStyle = hexToRgba(kind === 'arrival' ? arrivalFill : dispersalFill,
                                 kind === 'arrival' ? 0.12 : 0.10);
      var bx0 = bucketToX(Math.max(rng.from, vis.from), size, vis);
      var bx1 = bucketToX(Math.min(rng.to, vis.to),   size, vis);
      _ctx.fillRect(bx0, plotTop, Math.max(1, bx1 - bx0), plotBot - plotTop);
    }

    // Peak window band, in the verdict colour.
    var peakWin = peakWindow(timeline, peakBucket, peakValue);
    var verdictRgb = verdictColor(verdict);
    var px0 = bucketToX(clamp(peakWin.from, vis.from, vis.to), size, vis);
    var px1 = bucketToX(clamp(peakWin.to,   vis.from, vis.to), size, vis);
    if (px1 > px0) {
      _ctx.fillStyle = hexToRgba(verdictRgb, 0.10);
      _ctx.fillRect(px0, plotTop, Math.max(2, px1 - px0), plotBot - plotTop);
      _ctx.strokeStyle = hexToRgba(verdictRgb, 0.55);
      _ctx.lineWidth = 1;
      _ctx.beginPath();
      _ctx.moveTo(px0, plotTop + 0.5);
      _ctx.lineTo(px1, plotTop + 0.5);
      _ctx.stroke();
    }

    // Smooth curve: gradient fill down to the plot bottom + stroke.
    var accentRgb = tokenColor('color.text.accent', '#34D399');
    var grad = _ctx.createLinearGradient(0, plotTop, 0, plotBot);
    grad.addColorStop(0, hexToRgba(accentRgb, 0.45));
    grad.addColorStop(1, hexToRgba(accentRgb, 0.02));
    var pts = curvePoints(timeline, vis.from, vis.to,
      function (b) { return bucketToX(b, size, vis); },
      function (v) { return valueToY(v, plotTop, plotBot, peakValue); });
    strokeAndFillCurve(_ctx, pts, plotBot, hexToRgba(accentRgb, 0.95), grad, 1.5);

    // Scrubber: vertical line + handle dot at curve height.
    var bIdx = (typeof _bucket === 'number') ? _bucket : peakBucket;
    var scrubColor = tokenColor('color.text.primary', '#F8FAFC');
    if (bIdx >= vis.from && bIdx < vis.to) {
      var sxL = bucketToX(bIdx, size, vis);
      var sxR = bucketToX(bIdx + 1, size, vis);
      var sxC = (sxL + sxR) / 2;
      _ctx.fillStyle = hexToRgba(scrubColor, 0.06);
      _ctx.fillRect(sxL, plotTop, Math.max(1, sxR - sxL), plotBot - plotTop);
      _ctx.strokeStyle = hexToRgba(scrubColor, 0.85);
      _ctx.lineWidth = 1;
      _ctx.beginPath();
      _ctx.moveTo(Math.round(sxC) + 0.5, plotTop - 4);
      _ctx.lineTo(Math.round(sxC) + 0.5, plotBot + 4);
      _ctx.stroke();
      var syHandle = valueToY(timeline[bIdx] || 0, plotTop, plotBot, peakValue);
      _ctx.fillStyle = scrubColor;
      _ctx.beginPath();
      _ctx.arc(sxC, syHandle, 4, 0, Math.PI * 2);
      _ctx.fill();
      _ctx.strokeStyle = tokenColor('color.bg.surface', '#0D1117');
      _ctx.lineWidth = 1.5;
      _ctx.stroke();
    }

    // Time labels along the bottom.
    _ctx.fillStyle = tokenColor('color.text.tertiary', '#94A3B8');
    _ctx.font = '12px ' + tokenColor('typography.font.mono', FONT_FALLBACK);
    _ctx.textBaseline = 'top';
    for (var li = 0; li < ticks.length; li++) {
      var hh = ticks[li];
      var lx = bucketToX(hh * 4, size, vis);
      _ctx.textAlign = (li === 0) ? 'left' : (li === ticks.length - 1) ? 'right' : 'center';
      _ctx.fillText(tickLabel(hh), lx, plotBot + 6);
    }

    // Peak label above the band (display face, semibold).
    if (peakValue > 0 && peakBucket >= vis.from && peakBucket < vis.to) {
      _ctx.fillStyle = verdictRgb;
      _ctx.font = '600 13px ' + tokenColor('typography.font.display', FONT_FALLBACK);
      _ctx.textAlign = 'left';
      _ctx.textBaseline = 'alphabetic';
      var labelX = clamp(px0 + 4, ML, W - MR - 120);
      _ctx.fillText('Peak · ' + bucketLabel(peakBucket), labelX, plotTop - 4);
    }

    positionScrubLine(vis);
  }

  // ─────────── Range brush ───────────

  function drawBrush() {
    if (!_brushCtx || !_forecast) return;
    var size = fitCanvas(_brushCanvas, _brushCtx, 20);
    if (!size) return;
    var n = bucketCount();
    var vis = visibleRange();
    var full = { from: 0, to: n };
    var timeline = _forecast.timeline || [];
    var peakValue = _forecast.peak_value || 0;
    var W = size.w, H = size.h;
    var top = 4, bot = H - 2;
    _brushCtx.clearRect(0, 0, W, H);

    // Whole-day miniature, muted.
    var accentRgb = tokenColor('color.text.accent', '#34D399');
    var pts = curvePoints(timeline, 0, n,
      function (b) { return bucketToX(b, size, full); },
      function (v) { return valueToY(v, top, bot, peakValue); });
    strokeAndFillCurve(_brushCtx, pts, bot, hexToRgba(accentRgb, 0.55), hexToRgba(accentRgb, 0.12), 1);

    // Dim what's outside the selected range.
    var dim = hexToRgba(tokenColor('color.bg.page', '#07090C'), 0.62);
    var x0 = bucketToX(vis.from, size, full);
    var x1 = bucketToX(vis.to, size, full);
    _brushCtx.fillStyle = dim;
    _brushCtx.fillRect(ML, 0, Math.max(0, x0 - ML), H);
    _brushCtx.fillRect(x1, 0, Math.max(0, W - MR - x1), H);

    // Selection outline.
    _brushCtx.strokeStyle = hexToRgba(tokenColor('color.text.primary', '#F8FAFC'), 0.35);
    _brushCtx.lineWidth = 1;
    _brushCtx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(1, Math.round(x1 - x0)), H - 1);

    positionBrushHandles(vis, n);
  }

  function positionBrushHandles(vis, n) {
    if (!_hFrom || !_hTo || !_brushSel) return;
    var inner = _brush.clientWidth - ML - MR;
    var xFrom = ML + (vis.from / n) * inner;
    var xTo = ML + (vis.to / n) * inner;
    _hFrom.style.left = xFrom + 'px';
    _hTo.style.left = xTo + 'px';
    _brushSel.style.left = xFrom + 'px';
    _brushSel.style.width = Math.max(0, xTo - xFrom) + 'px';
    _hFrom.querySelector('.ef-brush__label').textContent = clock12(vis.from * BUCKET_MIN);
    _hTo.querySelector('.ef-brush__label').textContent = clock12(vis.to * BUCKET_MIN);
    _hFrom.setAttribute('aria-valuetext', clock12(vis.from * BUCKET_MIN));
    _hTo.setAttribute('aria-valuetext', clock12(vis.to * BUCKET_MIN));
    _hFrom.setAttribute('aria-valuenow', String(vis.from));
    _hTo.setAttribute('aria-valuenow', String(vis.to));
    // Keep the two labels from colliding on a narrow range: push them
    // outward when the handles are close.
    var close = (xTo - xFrom) < 96;
    _hFrom.classList.toggle('ef-brush__handle--tight', close);
    _hTo.classList.toggle('ef-brush__handle--tight', close);
  }

  function brushBucketAt(clientX) {
    var rect = _brush.getBoundingClientRect();
    var inner = rect.width - ML - MR;
    var frac = clamp((clientX - rect.left - ML) / inner, 0, 1);
    return Math.round(frac * bucketCount());
  }

  function attachBrushEvents() {
    _brush.addEventListener('pointerdown', function (evt) {
      if (!_forecast) return;
      var vis = visibleRange();
      var handle = evt.target.closest ? evt.target.closest('.ef-brush__handle') : null;
      var b = brushBucketAt(evt.clientX);
      var mode;
      if (handle === _hFrom) mode = 'from';
      else if (handle === _hTo) mode = 'to';
      else if (b >= vis.from && b < vis.to) mode = 'move';
      else mode = (Math.abs(b - vis.from) <= Math.abs(b - vis.to)) ? 'from' : 'to';
      _brushDrag = { mode: mode, offset: b - vis.from, span: vis.to - vis.from };
      _brush.setPointerCapture(evt.pointerId);
      _brush.classList.add('ef-brush--dragging');
      evt.preventDefault();
      applyBrushDrag(evt.clientX, false);
    });
    _brush.addEventListener('pointermove', function (evt) {
      if (!_brushDrag) return;
      applyBrushDrag(evt.clientX, false);
    });
    var stop = function (evt) {
      if (!_brushDrag) return;
      applyBrushDrag(evt.clientX, true);
      _brushDrag = null;
      _brush.classList.remove('ef-brush--dragging');
      try { _brush.releasePointerCapture(evt.pointerId); } catch (_) {}
    };
    _brush.addEventListener('pointerup', stop);
    _brush.addEventListener('pointercancel', stop);

    // Keyboard on the handles: ←/→ move 15 min (Shift: 1 h).
    [_hFrom, _hTo].forEach(function (h, idx) {
      h.addEventListener('keydown', function (evt) {
        if (!_forecast) return;
        var vis = visibleRange();
        var step = evt.shiftKey ? 4 : 1;
        var delta = evt.key === 'ArrowLeft' ? -step : evt.key === 'ArrowRight' ? step : 0;
        if (!delta) return;
        evt.preventDefault();
        if (idx === 0) setRange(vis.from + delta, vis.to, true);
        else setRange(vis.from, vis.to + delta, true);
      });
    });
  }

  function applyBrushDrag(clientX, persist) {
    if (!_brushDrag) return;
    var n = bucketCount();
    var vis = visibleRange();
    var b = brushBucketAt(clientX);
    if (_brushDrag.mode === 'from') {
      setRange(Math.min(b, vis.to - MIN_SPAN), vis.to, persist);
    } else if (_brushDrag.mode === 'to') {
      setRange(vis.from, Math.max(b, vis.from + MIN_SPAN), persist);
    } else {
      var from = clamp(b - _brushDrag.offset, 0, n - _brushDrag.span);
      setRange(from, from + _brushDrag.span, persist);
    }
  }

  function updateAllDayChip() {
    if (!_allDayChip || !_forecast) return;
    _allDayChip.setAttribute('aria-pressed', isFullDay(visibleRange()) ? 'true' : 'false');
  }

  // ─────────── Readout / chips ───────────

  // Title: "Peak at 10:00 PM" (the day's peak), or "Quiet all day".
  function updateTitle() {
    if (!_readout || !_forecast) return;
    _readout.innerHTML = '';
    var peakValue = _forecast.peak_value || 0;
    if (peakValue > 0 && typeof _forecast.peak_bucket === 'number') {
      _readout.appendChild(document.createTextNode('Peak at '));
      _readout.appendChild(el('strong', 'ef-timeline__title-time', bucketLabel(_forecast.peak_bucket)));
    } else {
      _readout.appendChild(document.createTextNode('Quiet all day'));
    }
  }

  function updateNowChip() {
    if (!_nowChip || !_forecast || !_cityConfig) return;
    var nb = nowBucketForDate(_forecast.date, _cityConfig.timezone);
    if (nb == null) {
      _nowChip.hidden = true;
    } else {
      _nowChip.hidden = false;
      _nowChip.dataset.bucket = String(nb);
    }
  }

  // ─────────── Station lanes ───────────

  function positionScrubLine(vis) {
    if (!_scrubLine || !_forecast) return;
    var b = (typeof _bucket === 'number') ? _bucket : (_forecast.peak_bucket || 0);
    vis = vis || visibleRange();
    if (b < vis.from || b >= vis.to || !_rows.length) {
      _scrubLine.hidden = true;
      return;
    }
    _scrubLine.hidden = false;
    _scrubLine.style.left = (bucketToFrac(b + 0.5, vis) * 100) + '%';
  }

  function applyActiveChips() {
    if (!_lanes) return;
    var b = (typeof _bucket === 'number') ? _bucket : null;
    var chips = _lanes.querySelectorAll('.ef-lane__chip');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var from = parseFloat(c.getAttribute('data-from'));
      var to = parseFloat(c.getAttribute('data-to'));
      var active = b != null && b + 0.5 >= from && b + 0.5 < to;
      if (active) c.setAttribute('data-active', 'true');
      else c.removeAttribute('data-active');
    }
  }

  function linePillNode(row, l) {
    var pill = el('span', 'line-pill line-pill--' + (row.kind || 'subway'), l.label);
    if (l.color) {
      pill.style.background = l.color;
      pill.style.borderColor = l.color;
      if (l.text) pill.style.color = l.text;
    }
    return pill;
  }

  function buildChip(row, span) {
    var chip = el('button', 'ef-lane__chip');
    chip.type = 'button';
    chip.setAttribute('data-phase', span.phase || 'arrival');
    chip.setAttribute('data-kind', row.kind || 'subway');
    chip.setAttribute('data-from', String(span.fromBucket));
    chip.setAttribute('data-to', String(span.toBucket));
    chip.setAttribute('aria-label', row.name + ', ' + span.time + ', ' + span.phaseWord);
    // Line badge first, then the station name.
    (row.lines || []).slice(0, 2).forEach(function (l) { chip.appendChild(linePillNode(row, l)); });
    chip.appendChild(el('span', 'ef-lane__name', row.name));
    chip._row = row;
    chip._span = span;

    chip.addEventListener('mouseenter', function () { if (!_pinnedChip) showPop(chip); });
    chip.addEventListener('mouseleave', function () { if (!_pinnedChip) hidePop(); });
    chip.addEventListener('focus', function () { showPop(chip); });
    chip.addEventListener('blur', function () { if (_pinnedChip !== chip) hidePop(); });
    chip.addEventListener('click', function (evt) {
      evt.stopPropagation();
      // Click: jump the scrubber to the window start and pin the details.
      setBucket(Math.floor(span.fromBucket), true);
      if (_pinnedChip === chip) {
        _pinnedChip = null;
        hidePop();
      } else {
        _pinnedChip = chip;
        showPop(chip);
      }
    });
    return chip;
  }

  function layoutLanes() {
    if (!_lanes) return;
    _lanes.innerHTML = '';
    _pinnedChip = null;
    hidePop();
    if (!_forecast) return;
    var vis = visibleRange();

    _scrubLine = el('span', 'ef-lanes__scrub');
    _scrubLine.setAttribute('aria-hidden', 'true');
    _lanes.appendChild(_scrubLine);

    if (!_rows.length) {
      if (_emptyText) _lanes.appendChild(el('div', 'ef-lanes__empty', _emptyText));
      positionScrubLine(vis);
      return;
    }

    _rows.forEach(function (row) {
      var lane = el('div', 'ef-lane');
      lane.setAttribute('data-kind', row.kind || 'subway');
      var any = false;
      (row.spans || []).forEach(function (span) {
        if (span.toBucket <= vis.from || span.fromBucket >= vis.to) return;
        var chip = buildChip(row, span);
        var f0 = bucketToFrac(span.fromBucket, vis);
        var f1 = bucketToFrac(span.toBucket, vis);
        chip.style.left = (f0 * 100) + '%';
        chip.style.minWidth = ((f1 - f0) * 100) + '%';
        lane.appendChild(chip);
        any = true;
      });
      if (any) _lanes.appendChild(lane);
    });
    // A chip is at least as wide as its label, so one near the right
    // edge can run past the axis. Measure once and anchor those to the
    // window's END instead, so the chip grows leftwards.
    var laneWidth = _lanes.clientWidth;
    var chips = _lanes.querySelectorAll('.ef-lane__chip');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      if (c.offsetLeft + c.offsetWidth > laneWidth + 1) {
        var f1b = bucketToFrac(parseFloat(c.getAttribute('data-to')), vis);
        c.style.left = 'auto';
        c.style.right = ((1 - f1b) * 100) + '%';
      }
    }
    stackOverlaps();
    applyActiveChips();
    positionScrubLine(vis);
  }

  // Chips in one lane that would overlap (a wide label, a narrow
  // range, or a phone) drop to a second row instead of covering each
  // other. Measured, so it adapts to any width.
  var CHIP_H = 24, ROW_GAP = 4, MIN_CHIP_GAP = 4;
  function stackOverlaps() {
    var lanes = _lanes.querySelectorAll('.ef-lane');
    for (var li = 0; li < lanes.length; li++) {
      var lane = lanes[li];
      var chips = Array.prototype.slice.call(lane.querySelectorAll('.ef-lane__chip'));
      var items = chips.map(function (c) {
        var r = c.getBoundingClientRect();
        return { chip: c, left: r.left, right: r.right };
      }).sort(function (a, b) { return a.left - b.left; });
      var rows = [];
      items.forEach(function (it) {
        var row = 0;
        while (rows[row] && rows[row].some(function (iv) {
          return it.left < iv.right + MIN_CHIP_GAP && it.right > iv.left - MIN_CHIP_GAP;
        })) row++;
        (rows[row] = rows[row] || []).push(it);
        it.chip.style.top = (row * (CHIP_H + ROW_GAP)) + 'px';
      });
      lane.style.height = (Math.max(1, rows.length) * (CHIP_H + ROW_GAP) - ROW_GAP) + 'px';
    }
  }

  // ─────────── Details popover ───────────

  function showPop(chip) {
    if (!_pop || !chip || !chip._row) return;
    var row = chip._row, span = chip._span;
    _pop.innerHTML = '';

    var head = el('div', 'ef-pop__head');
    (row.lines || []).forEach(function (l) { head.appendChild(linePillNode(row, l)); });
    head.appendChild(el('span', 'ef-pop__name', row.name));
    head.appendChild(el('span', 'ef-pop__kind', row.kindLabel || ''));
    _pop.appendChild(head);

    var when = el('div', 'ef-pop__when');
    when.appendChild(el('span', 'ef-pop__time', span.time));
    var phase = el('span', 'ef-pop__phase', span.phaseWord);
    phase.setAttribute('data-phase', span.phase || 'arrival');
    when.appendChild(phase);
    _pop.appendChild(when);

    if (span.cause) _pop.appendChild(el('div', 'ef-pop__cause', span.cause));
    if (span.via) _pop.appendChild(el('div', 'ef-pop__via', 'via ' + span.via));
    _pop.appendChild(el('div', 'ef-pop__fine', 'Modeled from venue proximity and event timing, not measured.'));

    _pop.hidden = false;
    var lanesRect = _lanes.getBoundingClientRect();
    var chipRect = chip.getBoundingClientRect();
    var left = chipRect.left - lanesRect.left;
    var top = chipRect.bottom - lanesRect.top + 4;
    var maxLeft = Math.max(0, lanesRect.width - _pop.offsetWidth);
    _pop.style.left = clamp(left, 0, maxLeft) + 'px';
    _pop.style.top = top + 'px';
  }

  function hidePop() {
    if (_pop) _pop.hidden = true;
  }

  // ─────────── Pointer interaction (scrubber) ───────────

  function onPointer(evt) {
    var rect = _canvas.getBoundingClientRect();
    var size = { w: rect.width, h: rect.height };
    var x = evt.clientX - rect.left;
    setBucket(xToBucket(x, size, visibleRange()), true);
  }

  function attachPointerEvents() {
    _canvas.addEventListener('pointerdown', function (evt) {
      _canvas.setPointerCapture(evt.pointerId);
      _dragging = true;
      onPointer(evt);
    });
    _canvas.addEventListener('pointermove', function (evt) {
      if (!_dragging) return;
      onPointer(evt);
    });
    var stop = function (evt) {
      if (!_dragging) return;
      _dragging = false;
      try { _canvas.releasePointerCapture(evt.pointerId); } catch (_) {}
    };
    _canvas.addEventListener('pointerup', stop);
    _canvas.addEventListener('pointercancel', stop);
    _canvas.addEventListener('lostpointercapture', function () { _dragging = false; });

    // Keyboard: ←/→ to step (Shift = 1 h); Home/End = start/end of the
    // visible range; P = peak.
    _canvas.addEventListener('keydown', function (evt) {
      if (!_forecast) return;
      var vis = visibleRange();
      var b = (typeof _bucket === 'number') ? _bucket : _forecast.peak_bucket || 0;
      var step = evt.shiftKey ? 4 : 1;
      if (evt.key === 'ArrowLeft') {
        evt.preventDefault();
        setBucket(clamp(b - step, vis.from, vis.to - 1), true);
      } else if (evt.key === 'ArrowRight') {
        evt.preventDefault();
        setBucket(clamp(b + step, vis.from, vis.to - 1), true);
      } else if (evt.key === 'Home') {
        evt.preventDefault();
        setBucket(vis.from, true);
      } else if (evt.key === 'End') {
        evt.preventDefault();
        setBucket(vis.to - 1, true);
      } else if (evt.key === 'p' || evt.key === 'P') {
        evt.preventDefault();
        bringIntoRange(_forecast.peak_bucket || 0);
        setBucket(_forecast.peak_bucket || 0, true);
      }
    });

    // A click anywhere else unpins the details popover.
    document.addEventListener('click', function (evt) {
      if (!_pinnedChip) return;
      if (_pop && _pop.contains(evt.target)) return;
      _pinnedChip = null;
      hidePop();
    });
  }

  // ─────────── Public API ───────────

  function setBucket(bucket, fire) {
    if (typeof bucket !== 'number') return;
    bucket = clamp(Math.round(bucket), 0, bucketCount() - 1);
    if (bucket === _bucket) return;
    _bucket = bucket;
    draw();
    applyActiveChips();
    if (fire && typeof _onBucketChange === 'function') {
      _onBucketChange(bucket);
    }
  }

  function getBucket() { return _bucket; }

  function setForecast(forecast, cityConfig) {
    _forecast = forecast || null;
    _cityConfig = cityConfig || null;
    _pinnedChip = null;
    hidePop();
    if (!_forecast) {
      _bucket = null;
      _rows = [];
      if (_ctx) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
      if (_brushCtx) _brushCtx.clearRect(0, 0, _brushCanvas.width, _brushCanvas.height);
      if (_lanes) _lanes.innerHTML = '';
      return;
    }
    // Reset scrubber to the new day's peak bucket (M3 spec). A view with
    // nothing in it has no peak; park the scrubber at the visible start.
    var vis = visibleRange();
    _bucket = (_forecast.peak_value > 0 && typeof _forecast.peak_bucket === 'number')
      ? clamp(_forecast.peak_bucket, vis.from, vis.to - 1) : vis.from;
    draw();
    drawBrush();
    updateAllDayChip();
    updateFitChip();
    updateTitle();
    updateNowChip();
    layoutLanes();
  }

  // rows: [{id, name, kind, kindLabel, lines: [{label, color, text}],
  //         spans: [{fromBucket, toBucket, phase, phaseWord, time, cause, via}]}]
  // options.toggles: [{id, label, pressed, onToggle}] rendered in the
  // chip row (station-kind switches owned by the app); options.emptyText
  // shows when there are no rows.
  function setStations(rows, options) {
    _rows = rows || [];
    options = options || {};
    _emptyText = options.emptyText || '';
    if (_toggleHost) {
      _toggleHost.innerHTML = '';
      (options.toggles || []).forEach(function (t) {
        var chip = el('button', 'ef-timeline__chip ef-timeline__chip--toggle', t.label);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', t.pressed ? 'true' : 'false');
        chip.setAttribute('data-kind', t.id);
        chip.addEventListener('click', function () { if (t.onToggle) t.onToggle(); });
        _toggleHost.appendChild(chip);
      });
    }
    layoutLanes();
  }

  function buildHandle(label) {
    var h = el('button', 'ef-brush__handle');
    h.type = 'button';
    h.setAttribute('role', 'slider');
    h.setAttribute('aria-label', label);
    h.appendChild(el('span', 'ef-brush__grip'));
    h.appendChild(el('span', 'ef-brush__label'));
    return h;
  }

  function ensureTimeline(hostEl, onBucketChange) {
    if (!hostEl) return;
    _host = hostEl;
    _onBucketChange = onBucketChange || null;

    if (hostEl.dataset.efTimeline === 'true') return;
    hostEl.dataset.efTimeline = 'true';
    hostEl.innerHTML = '';

    _wrap = el('div', 'ef-timeline');

    var head = el('div', 'ef-timeline__head');
    _readout = el('span', 'ef-timeline__title');
    head.appendChild(_readout);

    _chips = el('div', 'ef-timeline__chips');
    _toggleHost = el('span', 'ef-timeline__toggles');
    _chips.appendChild(_toggleHost);

    _allDayChip = el('button', 'ef-timeline__chip ef-timeline__chip--toggle', 'All day');
    _allDayChip.type = 'button';
    _allDayChip.title = 'Show the whole day, midnight to 2 AM';
    _allDayChip.addEventListener('click', function () {
      if (!_forecast) return;
      if (isFullDay(visibleRange())) clearRange();
      else setRange(0, bucketCount(), true);
    });
    _chips.appendChild(_allDayChip);

    // Fit: tighten the range to the day's activity.
    _fitChip = el('button', 'ef-timeline__chip ef-timeline__chip--toggle', 'Fit');
    _fitChip.type = 'button';
    _fitChip.title = 'Fit the range to when things are happening';
    _fitChip.addEventListener('click', function () {
      if (!_forecast) return;
      var fit = activityRange();
      setRange(fit.from, fit.to, true);
    });
    _chips.appendChild(_fitChip);

    _peakChip = el('button', 'ef-timeline__chip', 'Peak');
    _peakChip.type = 'button';
    _peakChip.addEventListener('click', function () {
      if (!_forecast) return;
      var pb = _forecast.peak_bucket || 0;
      bringIntoRange(pb);
      setBucket(pb, true);
    });
    _nowChip = el('button', 'ef-timeline__chip', 'Now');
    _nowChip.type = 'button';
    _nowChip.hidden = true;
    _nowChip.addEventListener('click', function () {
      var nb = parseInt(_nowChip.dataset.bucket || '', 10);
      if (isNaN(nb)) return;
      bringIntoRange(nb);
      setBucket(nb, true);
    });
    _chips.appendChild(_peakChip);
    _chips.appendChild(_nowChip);
    head.appendChild(_chips);
    _wrap.appendChild(head);

    // Range brush: whole-day miniature + two handles.
    _brush = el('div', 'ef-brush');
    _brush.setAttribute('aria-label', 'Time range. Drag the handles to choose the start and end.');
    _brushCanvas = el('canvas', 'ef-brush__canvas');
    _brush.appendChild(_brushCanvas);
    _brushSel = el('span', 'ef-brush__sel');
    _brushSel.setAttribute('aria-hidden', 'true');
    _brush.appendChild(_brushSel);
    _hFrom = buildHandle('Range start');
    _hTo = buildHandle('Range end');
    _brush.appendChild(_hFrom);
    _brush.appendChild(_hTo);
    _wrap.appendChild(_brush);
    _brushCtx = _brushCanvas.getContext('2d');
    attachBrushEvents();

    _canvas = el('canvas', 'ef-timeline__canvas');
    _canvas.tabIndex = 0;
    _canvas.setAttribute('role', 'slider');
    _canvas.setAttribute('aria-label', 'Day busyness timeline. Drag to scrub through the day in 15-minute steps.');
    _wrap.appendChild(_canvas);

    // Station lanes + the details popover live in one positioned box so
    // the popover can be placed relative to its chip.
    var lanesWrap = el('div', 'ef-lanes-wrap');
    _lanes = el('div', 'ef-lanes');
    _lanes.setAttribute('aria-label', 'Stations likely packed, placed on the timeline');
    lanesWrap.appendChild(_lanes);
    _pop = el('div', 'ef-pop');
    _pop.setAttribute('role', 'tooltip');
    _pop.hidden = true;
    lanesWrap.appendChild(_pop);
    _wrap.appendChild(lanesWrap);

    var legend = el('div', 'ef-timeline__legend');
    var lg1 = el('span', 'ef-timeline__legend-item');
    lg1.appendChild(el('span', 'ef-timeline__legend-swatch ef-timeline__legend-swatch--arrival'));
    lg1.appendChild(document.createTextNode('In'));
    var lg2 = el('span', 'ef-timeline__legend-item');
    lg2.appendChild(el('span', 'ef-timeline__legend-swatch ef-timeline__legend-swatch--dispersal'));
    lg2.appendChild(document.createTextNode('Out'));
    var lg3 = el('span', 'ef-timeline__legend-item');
    lg3.appendChild(el('span', 'ef-timeline__legend-swatch ef-timeline__legend-swatch--peak'));
    lg3.appendChild(document.createTextNode('Peak'));
    var lg4 = el('span', 'ef-timeline__legend-note', 'Modeled estimate, not measured.');
    legend.appendChild(lg1);
    legend.appendChild(lg2);
    legend.appendChild(lg3);
    legend.appendChild(lg4);
    _wrap.appendChild(legend);

    hostEl.appendChild(_wrap);

    _ctx = _canvas.getContext('2d');
    attachPointerEvents();

    var onResize = function () { draw(); drawBrush(); layoutLanes(); };
    if (window.ResizeObserver) {
      _ro = new ResizeObserver(onResize);
      _ro.observe(_canvas);
    } else {
      window.addEventListener('resize', onResize);
    }
  }

  function destroy() {
    if (_ro) { _ro.disconnect(); _ro = null; }
    _host = _wrap = _readout = _chips = _peakChip = _nowChip = _allDayChip = _fitChip = _toggleHost = null;
    _canvas = _ctx = _brush = _brushCanvas = _brushCtx = _brushSel = _hFrom = _hTo = null;
    _lanes = _scrubLine = _pop = _pinnedChip = null;
    _forecast = _cityConfig = null;
    _rows = [];
    _bucket = null;
  }

  window.EFTimeline = {
    ensureTimeline: ensureTimeline,
    setForecast: setForecast,
    setStations: setStations,
    setBucket: setBucket,
    getBucket: getBucket,
    destroy: destroy
  };
})();
