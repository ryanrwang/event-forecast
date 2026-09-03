/*
 * Event Forecast — Day timeline (M3).
 *
 * Hand-built canvas. NOT a charting library — the timeline is part of
 * the product's identity (overview §7). Renders the day's 96-bucket
 * summed-busyness curve, peak window, per-event arrival + dispersal
 * "avoid" bands, and a draggable scrubber that emits bucket changes
 * via the onBucketChange callback set on ensureTimeline().
 *
 * The map module owns the heatmap re-render; this module just emits the
 * selected bucket so app.js can fan it out to map + rail.
 *
 *   window.EFTimeline.ensureTimeline(hostEl, onBucketChange)
 *   window.EFTimeline.setForecast(forecast, cityConfig)   // resets bucket
 *   window.EFTimeline.setBucket(bucket)                   // external set
 *   window.EFTimeline.getBucket() -> int|null
 */
(function () {
  'use strict';

  var BUCKETS = 96;
  var BUCKET_MIN = 15;

  // Avoid windows are now SERVER-COMPUTED — see
  // pipeline/timecurves.py `build_avoid_windows`. The per-day forecast
  // JSON carries `avoid_windows[]` with {event_id, kind, from_bucket,
  // to_bucket, from_minute, to_minute}, the single source of truth for
  // the timeline bands AND the M4 transit-station flagging windows. The
  // dispersal-tail-per-category constants (45/75/120) live in Python
  // (timecurves.DISPERSAL_TAIL_MIN); we never need them on the client
  // anymore. The pre-M4 client-side recomputation is gone.

  // Layout (CSS pixels). Off-grid values are intentional ONLY where the
  // 4px grid leaves a curve plot too thin; otherwise we stay on grid.
  var ML = 16, MR = 16, MT = 16, MB = 24;
  // Above the canvas: 4px gap, then the readout/chip row.
  var HEADER_HEIGHT_HINT = 32;

  // Module-private state
  var _host = null;
  var _wrap = null;
  var _readout = null;
  var _peakChip = null;
  var _nowChip = null;
  var _canvas = null;
  var _ctx = null;
  var _ro = null;
  var _onBucketChange = null;
  var _forecast = null;
  var _cityConfig = null;
  var _bucket = null;
  var _dragging = false;
  var _dpr = 1;

  // ─────────── small utils ───────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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

  // ─────────── time / bucket helpers ───────────

  // 12-hour clock — the one time format the whole UI uses.
  function clock12(mins) {
    var m = ((Math.round(mins) % (24 * 60)) + 24 * 60) % (24 * 60);
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    var h12 = hh % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (hh >= 12 ? 'PM' : 'AM');
  }

  function hourLabel12(hh) {
    var h = hh % 24;
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ' ' + (h >= 12 ? 'PM' : 'AM');
  }

  function bucketLabel(bucket) {
    var b = clamp(bucket || 0, 0, BUCKETS - 1);
    return clock12(b * BUCKET_MIN);
  }

  // Current local bucket in the city's tz, or null if the selected day
  // isn't "today" there. Uses Intl rather than Date math to avoid DST land mines.
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
    if (todayIso !== dateIso) return null;
    var hh = parseInt(bag.hour, 10);
    var mm = parseInt(bag.minute, 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    // Intl returns "24:00" for midnight in some browsers; clamp.
    if (hh === 24) hh = 0;
    return Math.min(BUCKETS - 1, Math.floor((hh * 60 + mm) / BUCKET_MIN));
  }

  // Group the server-emitted forecast.avoid_windows[] by kind for the
  // band-drawing loop. Each entry already carries from_bucket/to_bucket
  // intersected with the displayed day, so no client-side window math.
  function bucketsFromWindow(w) {
    if (!w) return null;
    var from = (typeof w.from_bucket === 'number') ? w.from_bucket : null;
    var to   = (typeof w.to_bucket   === 'number') ? w.to_bucket   : null;
    if (from == null || to == null || to <= from) return null;
    return { from: from, to: to };
  }

  // Find the contiguous run around the peak bucket where the timeline
  // stays above PEAK_BAND_FRAC × peak_value. Used to draw the "peak
  // window" band (not just the single argmax bucket).
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

  // ─────────── Canvas drawing ───────────

  function fitCanvas() {
    if (!_canvas) return null;
    var rect = _canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(200, Math.floor(rect.width));
    var h = Math.max(80, Math.floor(rect.height));
    if (_canvas.width !== w * dpr || _canvas.height !== h * dpr) {
      _canvas.width = w * dpr;
      _canvas.height = h * dpr;
    }
    _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _dpr = dpr;
    return { w: w, h: h };
  }

  function bucketToX(b, size) {
    var inner = size.w - ML - MR;
    return ML + (b / BUCKETS) * inner;
  }

  function xToBucket(x, size) {
    var inner = size.w - ML - MR;
    var raw = Math.floor(((x - ML) / inner) * BUCKETS);
    return clamp(raw, 0, BUCKETS - 1);
  }

  function valueToY(v, size, maxV) {
    var plotTop = MT;
    var plotBot = size.h - MB;
    var t = maxV > 0 ? clamp(v / maxV, 0, 1) : 0;
    return plotBot - t * (plotBot - plotTop);
  }

  function draw() {
    if (!_ctx || !_forecast) return;
    var size = fitCanvas();
    if (!size) return;

    var timeline = _forecast.timeline || [];
    var peakValue = _forecast.peak_value || 0;
    var peakBucket = (typeof _forecast.peak_bucket === 'number') ? _forecast.peak_bucket : 0;
    var verdict = _forecast.verdict;

    var W = size.w, H = size.h;
    var plotTop = MT, plotBot = H - MB;

    _ctx.clearRect(0, 0, W, H);

    // ── 1. Hour grid (every 6h: 00, 06, 12, 18). Quiet.
    // Fallback is a near-equivalent solid hex (bg.3) for the unreachable
    // TOKENS-missing case; canvas can't parse color-mix() so we can't
    // route through a token expression here.
    _ctx.strokeStyle = tokenColor('color.border.subtle', '#1C232E');
    _ctx.lineWidth = 1;
    for (var hr = 0; hr <= 24; hr += 6) {
      var bx = bucketToX((hr / 24) * BUCKETS, size);
      _ctx.beginPath();
      _ctx.moveTo(bx + 0.5, plotTop);
      _ctx.lineTo(bx + 0.5, plotBot);
      _ctx.stroke();
    }

    // ── 2. Per-event arrival + dispersal bands. Aggregate the alpha so
    // overlapping events darken naturally. avoid_windows[] is
    // pre-intersected with the displayed day by the pipeline.
    var arrivalFill   = tokenColor('color.status.info',    '#38BDF8');
    var dispersalFill = tokenColor('color.status.warning', '#EAB308');
    var avoidWindows = _forecast.avoid_windows || [];
    for (var i = 0; i < avoidWindows.length; i++) {
      var rng = bucketsFromWindow(avoidWindows[i]);
      if (!rng) continue;
      var kind = avoidWindows[i].kind;
      var fill = (kind === 'arrival') ? arrivalFill : dispersalFill;
      var alpha = (kind === 'arrival') ? 0.12 : 0.10;
      _ctx.fillStyle = hexToRgba(fill, alpha);
      var bx0 = bucketToX(rng.from, size);
      var bx1 = bucketToX(rng.to,   size);
      _ctx.fillRect(bx0, plotTop, Math.max(1, bx1 - bx0), plotBot - plotTop);
    }

    // ── 3. Peak window band. Uses verdict color, stronger than avoid bands.
    var peakWin = peakWindow(timeline, peakBucket, peakValue);
    var verdictRgb = verdictColor(verdict);
    _ctx.fillStyle = hexToRgba(verdictRgb, 0.10);
    var px0 = bucketToX(peakWin.from, size);
    var px1 = bucketToX(peakWin.to,   size);
    _ctx.fillRect(px0, plotTop, Math.max(2, px1 - px0), plotBot - plotTop);
    // Top tick line for the peak band — quiet but readable.
    _ctx.strokeStyle = hexToRgba(verdictRgb, 0.55);
    _ctx.lineWidth = 1;
    _ctx.beginPath();
    _ctx.moveTo(px0, plotTop + 0.5);
    _ctx.lineTo(px1, plotTop + 0.5);
    _ctx.stroke();

    // ── 4. Curve fill (gradient down to plot bottom).
    var accentRgb = tokenColor('color.text.accent', '#34D399');
    var grad = _ctx.createLinearGradient(0, plotTop, 0, plotBot);
    grad.addColorStop(0, hexToRgba(accentRgb, 0.45));
    grad.addColorStop(1, hexToRgba(accentRgb, 0.02));
    _ctx.fillStyle = grad;
    _ctx.beginPath();
    _ctx.moveTo(ML, plotBot);
    for (var b = 0; b < BUCKETS; b++) {
      var v = timeline[b] || 0;
      var xL = bucketToX(b, size);
      var xR = bucketToX(b + 1, size);
      var y  = valueToY(v, size, peakValue);
      _ctx.lineTo(xL, y);
      _ctx.lineTo(xR, y);
    }
    _ctx.lineTo(W - MR, plotBot);
    _ctx.closePath();
    _ctx.fill();

    // ── 5. Curve stroke (stepwise — buckets are discrete).
    _ctx.strokeStyle = hexToRgba(accentRgb, 0.95);
    _ctx.lineWidth = 1.5;
    _ctx.lineJoin = 'round';
    _ctx.beginPath();
    for (var b2 = 0; b2 < BUCKETS; b2++) {
      var v2 = timeline[b2] || 0;
      var xL2 = bucketToX(b2, size);
      var xR2 = bucketToX(b2 + 1, size);
      var y2 = valueToY(v2, size, peakValue);
      if (b2 === 0) _ctx.moveTo(xL2, y2);
      else _ctx.lineTo(xL2, y2);
      _ctx.lineTo(xR2, y2);
    }
    _ctx.stroke();

    // ── 6. Scrubber. Vertical line + handle dot at curve height.
    var bIdx = (typeof _bucket === 'number') ? _bucket : peakBucket;
    var sxL = bucketToX(bIdx, size);
    var sxR = bucketToX(bIdx + 1, size);
    var sxC = (sxL + sxR) / 2;
    var scrubColor = tokenColor('color.text.primary', '#F8FAFC');
    // Highlight the selected bucket column behind the line.
    _ctx.fillStyle = hexToRgba(scrubColor, 0.06);
    _ctx.fillRect(sxL, plotTop, Math.max(1, sxR - sxL), plotBot - plotTop);
    _ctx.strokeStyle = hexToRgba(scrubColor, 0.85);
    _ctx.lineWidth = 1;
    _ctx.beginPath();
    _ctx.moveTo(Math.round(sxC) + 0.5, plotTop - 4);
    _ctx.lineTo(Math.round(sxC) + 0.5, plotBot + 4);
    _ctx.stroke();
    // Handle dot at the curve's value for this bucket.
    var sv = (timeline[bIdx] || 0);
    var syHandle = valueToY(sv, size, peakValue);
    _ctx.fillStyle = scrubColor;
    _ctx.beginPath();
    _ctx.arc(sxC, syHandle, 4, 0, Math.PI * 2);
    _ctx.fill();
    _ctx.strokeStyle = tokenColor('color.bg.surface', '#0D1117');
    _ctx.lineWidth = 1.5;
    _ctx.stroke();

    // ── 7. Time labels along the bottom.
    var tertiary = tokenColor('color.text.tertiary', '#94A3B8');
    var monoFont = '12px ' + (tokenColor('typography.font.mono',
      '"IBM Plex Sans", "Segoe UI", Helvetica, sans-serif'));
    _ctx.fillStyle = tertiary;
    _ctx.font = monoFont;
    _ctx.textBaseline = 'top';
    var labels = [0, 6, 12, 18, 24];
    for (var li = 0; li < labels.length; li++) {
      var hh = labels[li];
      var lx = bucketToX((hh / 24) * BUCKETS, size);
      _ctx.textAlign = (hh === 0) ? 'left' : (hh === 24) ? 'right' : 'center';
      _ctx.fillText(hourLabel12(hh), lx, plotBot + 6);
    }

    // ── 8. Peak label above the peak band (display face, semibold).
    var displayFont = '13px ' + (tokenColor('typography.font.display',
      '"IBM Plex Sans", "Segoe UI", Helvetica, sans-serif'));
    _ctx.fillStyle = verdictRgb;
    _ctx.font = '600 ' + displayFont;
    _ctx.textAlign = 'left';
    _ctx.textBaseline = 'alphabetic';
    var peakLabel = 'Busiest · ' + bucketLabel(peakBucket);
    var labelX = clamp(px0 + 4, ML, W - MR - 120);
    _ctx.fillText(peakLabel, labelX, plotTop - 4);
  }

  // ─────────── Readout / chips ───────────

  function updateReadout() {
    if (!_readout || !_forecast) return;
    var b = (typeof _bucket === 'number') ? _bucket : _forecast.peak_bucket || 0;
    var v = (_forecast.timeline && _forecast.timeline[b]) || 0;
    var peakValue = _forecast.peak_value || 0;
    var pct = peakValue > 0 ? Math.round((v / peakValue) * 100) : 0;
    _readout.innerHTML = '';
    var time = el('span', 'ef-timeline__readout-time', bucketLabel(b));
    var sep  = el('span', 'ef-timeline__readout-sep', '·');
    var pctNode = el('span', 'ef-timeline__readout-pct', pct + "% of the day's peak");
    _readout.appendChild(time);
    _readout.appendChild(sep);
    _readout.appendChild(pctNode);
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

  // ─────────── Pointer interaction ───────────

  function onPointer(evt) {
    var rect = _canvas.getBoundingClientRect();
    var size = { w: rect.width, h: rect.height };
    var x = evt.clientX - rect.left;
    var b = xToBucket(x, size);
    setBucket(b, true);
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

    // Keyboard: ←/→ to step; Home/End to jump to start/end of day.
    _canvas.addEventListener('keydown', function (evt) {
      if (!_forecast) return;
      var b = (typeof _bucket === 'number') ? _bucket : _forecast.peak_bucket || 0;
      var step = evt.shiftKey ? 4 : 1;
      if (evt.key === 'ArrowLeft') {
        evt.preventDefault();
        setBucket(clamp(b - step, 0, BUCKETS - 1), true);
      } else if (evt.key === 'ArrowRight') {
        evt.preventDefault();
        setBucket(clamp(b + step, 0, BUCKETS - 1), true);
      } else if (evt.key === 'Home') {
        evt.preventDefault();
        setBucket(0, true);
      } else if (evt.key === 'End') {
        evt.preventDefault();
        setBucket(BUCKETS - 1, true);
      } else if (evt.key === 'p' || evt.key === 'P') {
        evt.preventDefault();
        setBucket(_forecast.peak_bucket || 0, true);
      }
    });
  }

  // ─────────── Public API ───────────

  function setBucket(bucket, fire) {
    if (typeof bucket !== 'number') return;
    bucket = clamp(Math.round(bucket), 0, BUCKETS - 1);
    if (bucket === _bucket) return;
    _bucket = bucket;
    draw();
    updateReadout();
    if (fire && typeof _onBucketChange === 'function') {
      _onBucketChange(bucket);
    }
  }

  function getBucket() { return _bucket; }

  function setForecast(forecast, cityConfig) {
    _forecast = forecast || null;
    _cityConfig = cityConfig || null;
    if (!_forecast) {
      _bucket = null;
      if (_ctx) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
      return;
    }
    // Reset scrubber to the new day's peak bucket (M3 spec).
    _bucket = (typeof _forecast.peak_bucket === 'number') ? _forecast.peak_bucket : 0;
    draw();
    updateReadout();
    updateNowChip();
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
    var eyebrow = el('span', 'ef-timeline__eyebrow', "When it's busiest");
    var readout = el('span', 'ef-timeline__readout');
    _readout = readout;

    var chips = el('div', 'ef-timeline__chips');
    _peakChip = el('button', 'ef-timeline__chip', 'Busiest');
    _peakChip.type = 'button';
    _peakChip.addEventListener('click', function () {
      if (_forecast) setBucket(_forecast.peak_bucket || 0, true);
    });
    _nowChip = el('button', 'ef-timeline__chip', 'Now');
    _nowChip.type = 'button';
    _nowChip.hidden = true;
    _nowChip.addEventListener('click', function () {
      var nb = parseInt(_nowChip.dataset.bucket || '', 10);
      if (!isNaN(nb)) setBucket(nb, true);
    });
    chips.appendChild(_peakChip);
    chips.appendChild(_nowChip);

    head.appendChild(eyebrow);
    head.appendChild(readout);
    head.appendChild(chips);
    _wrap.appendChild(head);

    _canvas = el('canvas', 'ef-timeline__canvas');
    _canvas.tabIndex = 0;
    _canvas.setAttribute('role', 'slider');
    _canvas.setAttribute('aria-label', 'Day busyness timeline. Drag to scrub through the day in 15-minute steps.');
    _wrap.appendChild(_canvas);

    var legend = el('div', 'ef-timeline__legend');
    var lg1 = el('span', 'ef-timeline__legend-item');
    lg1.appendChild(el('span', 'ef-timeline__legend-swatch ef-timeline__legend-swatch--arrival'));
    lg1.appendChild(document.createTextNode('Heading in'));
    var lg2 = el('span', 'ef-timeline__legend-item');
    lg2.appendChild(el('span', 'ef-timeline__legend-swatch ef-timeline__legend-swatch--dispersal'));
    lg2.appendChild(document.createTextNode('Letting out'));
    var lg3 = el('span', 'ef-timeline__legend-item');
    lg3.appendChild(el('span', 'ef-timeline__legend-swatch ef-timeline__legend-swatch--peak'));
    lg3.appendChild(document.createTextNode('Busiest'));
    var lg4 = el('span', 'ef-timeline__legend-note', 'Modeled estimate, not measured.');
    legend.appendChild(lg1);
    legend.appendChild(lg2);
    legend.appendChild(lg3);
    legend.appendChild(lg4);
    _wrap.appendChild(legend);

    hostEl.appendChild(_wrap);

    _ctx = _canvas.getContext('2d');
    attachPointerEvents();

    // Redraw on resize. Falls back to window resize if ResizeObserver is missing.
    if (window.ResizeObserver) {
      _ro = new ResizeObserver(function () { draw(); });
      _ro.observe(_canvas);
    } else {
      window.addEventListener('resize', function () { draw(); });
    }
  }

  function destroy() {
    if (_ro) { _ro.disconnect(); _ro = null; }
    _host = _wrap = _readout = _peakChip = _nowChip = null;
    _canvas = _ctx = null;
    _forecast = _cityConfig = null;
    _bucket = null;
  }

  window.EFTimeline = {
    ensureTimeline: ensureTimeline,
    setForecast: setForecast,
    setBucket: setBucket,
    getBucket: getBucket,
    destroy: destroy
  };
})();
