/*
 * Event Forecast — App entry point.
 *
 * Vanilla JS, no framework, no build step. Loads the configured cities,
 * picks one (selector appears only when >1 city is configured), pulls
 * the next 7 days of forecast JSON from the PHP layer, and renders:
 *
 *   1. the 7-day outlook strip (one compact verdict pill per day),
 *   2. the view filters (event-type chips, "smaller venues" chip,
 *      verdict-follows-filter switch),
 *   3. the selected day in today-first order: the "Because …" driver
 *      line, the busyness timeline with the stations likely packed
 *      drawn as lanes under the curve, the map, and the events active
 *      at the scrubbed time.
 *
 * Map + timeline modules are owned by map.js / timeline.js; this file
 * fans state out to them.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'eventforecast.theme';
  var DEFAULT_THEME = 'dark';
  var TYPE_FILTER_KEY = 'eventforecast.typeFilter';
  var VERDICT_MODE_KEY = 'eventforecast.verdictMode';
  var SMALL_VENUES_KEY = 'eventforecast.smallVenues';
  var TRANSIT_KINDS_KEY = 'eventforecast.transitKinds';

  // Venues under this capacity are "smaller venues": hidden from the
  // browsable view by default (they still count toward the verdict).
  // Mirrors the whitelist's ~5,000 guideline in 00-overview.md §3.
  var SMALL_VENUE_CAP = 5000;

  // Event-type filter groups. Grouping is TM-segment first (an event's
  // own classification), venue-category fallback for forecast.json
  // written before `segment` shipped. Operator-curated crowd days
  // ("City event") always show — they are days, not a type.
  var TYPE_GROUPS = [
    { id: 'sports',   label: 'Sports' },
    { id: 'concerts', label: 'Concerts' },
    { id: 'other',    label: 'Theatre & other' }
  ];

  // Station kinds the transit panel + map can show. Subway is always
  // on; the other two are opt-in toggles (persisted).
  var TRANSIT_TOGGLES = [
    { id: 'streetcar', label: 'Streetcar' },
    { id: 'go',        label: 'GO' }
  ];

  function loadJson(key, fallback) {
    try {
      var parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed == null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function loadTypeFilter() {
    var out = { sports: true, concerts: true, other: true };
    var parsed = loadJson(TYPE_FILTER_KEY, {});
    TYPE_GROUPS.forEach(function (g) {
      if (parsed && parsed[g.id] === false) out[g.id] = false;
    });
    return out;
  }

  function loadTransitKinds() {
    var out = { streetcar: false, go: false };
    var parsed = loadJson(TRANSIT_KINDS_KEY, {});
    TRANSIT_TOGGLES.forEach(function (t) {
      if (parsed && parsed[t.id] === true) out[t.id] = true;
    });
    return out;
  }

  var state = {
    // Persisted event-type chip selection. All-on means "no filtering".
    typeFilter: loadTypeFilter(),
    // Persisted "smaller venues" chip. Off by default: sub-5k theatres
    // and halls stay out of the browsable view.
    smallVenues: loadJson(SMALL_VENUES_KEY, false) === true,
    // 'all': day verdicts reflect every modeled event (default).
    // 'filtered': verdicts re-bucket from only the events the filters
    // show — "how busy because of the stuff I care about".
    verdictMode: loadJson(VERDICT_MODE_KEY, 'all') === 'filtered' ? 'filtered' : 'all',
    // Persisted transit toggles (subway is always shown).
    transitKinds: loadTransitKinds(),
    cities: [],
    currentCityId: null,
    cityConfig: null,
    days: [],
    forecasts: {},
    selectedDate: null,
    // 15-minute bucket index [0, 95] for the day timeline / scrubber.
    // null until a forecast is loaded; reset to the new day's peak
    // bucket on day-change per M3 spec.
    selectedBucket: null,
    // M6: per-city freshness + attributions surfaced by /api/cities.php
    // and /api/city.php. Drives the status banner + GTFS attribution
    // footer. Empty defaults so a missing API field renders cleanly.
    gtfsAttributions: {},
    mapAttribution: null,
    freshness: null
  };

  var BUCKET_MIN = 15;

  // ─────────── Theme ───────────

  function applyTheme() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    var theme = saved === 'light' ? 'light' : DEFAULT_THEME;
    document.documentElement.setAttribute('data-theme', theme);
  }

  // ─────────── Net ───────────

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (body) {
          throw new Error('HTTP ' + resp.status + ' from ' + url + ': ' + body.slice(0, 200));
        });
      }
      return resp.json();
    });
  }

  // ─────────── Rendering helpers ───────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function friendlyDate(isoDate, tz) {
    // Render "Mon · May 18" in the city's local time. isoDate is a bare
    // YYYY-MM-DD so we anchor it to noon UTC to dodge timezone underflow.
    var d = new Date(isoDate + 'T12:00:00Z');
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (tz) opts.timeZone = tz;
    var fmt = new Intl.DateTimeFormat('en-US', opts).format(d);
    // "Mon, May 18" → "Mon · May 18"
    return fmt.replace(',', ' ·');
  }

  // Today's date (YYYY-MM-DD) in the city's timezone.
  function todayIso(tz) {
    try {
      var fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit'
      });
      var parts = fmt.formatToParts(new Date());
      var bag = {};
      for (var i = 0; i < parts.length; i++) bag[parts[i].type] = parts[i].value;
      return bag.year + '-' + bag.month + '-' + bag.day;
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function dayDelta(aIso, bIso) {
    if (!aIso || !bIso) return 0;
    var a = new Date(aIso + 'T00:00:00Z');
    var b = new Date(bIso + 'T00:00:00Z');
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  // "Today", "Tomorrow", or the short weekday ("Mon") for the strip.
  function relativeDayLabel(isoDate, tz) {
    var delta = dayDelta(todayIso(tz), isoDate);
    if (delta === 0) return 'Today';
    if (delta === 1) return 'Tomorrow';
    var d = new Date(isoDate + 'T12:00:00Z');
    var opts = { weekday: 'short' };
    if (tz) opts.timeZone = tz;
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  }

  function shortDate(isoDate, tz) {
    var d = new Date(isoDate + 'T12:00:00Z');
    var opts = { month: 'short', day: 'numeric' };
    if (tz) opts.timeZone = tz;
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  }

  // 12-hour clock, the one time format used everywhere in the UI.
  function friendlyTime(isoDateTime, tz) {
    if (!isoDateTime) return '';
    var d = new Date(isoDateTime);
    if (isNaN(d.getTime())) return '';
    var opts = { hour: 'numeric', minute: '2-digit' };
    if (tz) opts.timeZone = tz;
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  }

  // Minutes-since-midnight → "5:40 PM". Minutes past 1440 are the next
  // morning (a modeled day runs to 2 AM), so 1500 renders as "1:00 AM".
  function clockFromMinutes(min) {
    if (typeof min !== 'number' || isNaN(min)) return '';
    var m = ((Math.round(min) % (24 * 60)) + 24 * 60) % (24 * 60);
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    var suffix = hh >= 12 ? 'PM' : 'AM';
    var h12 = hh % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + suffix;
  }

  function clockFromBucket(bucket) {
    return clockFromMinutes(Math.max(0, bucket || 0) * BUCKET_MIN);
  }

  // "5:40–6:50 PM" when both ends share a meridiem, else "11:30 AM–1:00 PM".
  function rangeLabel(fromMin, toMin) {
    var a = clockFromMinutes(fromMin);
    var b = clockFromMinutes(toMin);
    if (!a || !b) return a || b;
    var sa = a.slice(-2), sb = b.slice(-2);
    if (sa === sb) return a.slice(0, -3) + '–' + b;
    return a + '–' + b;
  }

  function verdictKey(verdict) {
    return (verdict || '').toLowerCase();
  }

  function roundPeople(n) {
    if (typeof n !== 'number' || !(n > 0)) return '';
    var rounded = n >= 10000 ? Math.round(n / 1000) * 1000 : Math.round(n / 500) * 500;
    return rounded.toLocaleString('en-US');
  }

  // ─────────── Attribution ───────────

  function renderAttribution(attribution) {
    if (!attribution || !attribution.text) return;
    var node = document.getElementById('ticketmaster-attribution');
    if (!node) return;
    node.innerHTML = '';
    if (attribution.url) {
      var a = el('a', null, attribution.text);
      a.href = attribution.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node.appendChild(a);
    } else {
      node.textContent = attribution.text;
    }
  }

  // M6: render the OSM + CARTO basemap attribution into the footer.
  // The map module also renders this via Leaflet's L.control.attribution;
  // the footer line is a redundant safeguard so the credit is present
  // even when the map host hasn't been initialized yet.
  function renderMapAttribution(mapAttr) {
    if (!mapAttr) return;
    var node = document.getElementById('map-attribution');
    if (!node) return;
    node.innerHTML = '';
    node.appendChild(document.createTextNode('Map: '));
    if (mapAttr.osm_url) {
      var a1 = el('a', null, 'OpenStreetMap contributors');
      a1.href = mapAttr.osm_url;
      a1.target = '_blank';
      a1.rel = 'noopener noreferrer';
      node.appendChild(a1);
    } else {
      node.appendChild(document.createTextNode('OpenStreetMap contributors'));
    }
    node.appendChild(document.createTextNode(' · '));
    if (mapAttr.carto_url) {
      var a2 = el('a', null, 'CARTO basemaps');
      a2.href = mapAttr.carto_url;
      a2.target = '_blank';
      a2.rel = 'noopener noreferrer';
      node.appendChild(a2);
    } else {
      node.appendChild(document.createTextNode('CARTO basemaps'));
    }
  }

  // M6: render the per-city GTFS feed attribution in the footer.
  function renderGtfsAttribution(cityId) {
    var node = document.getElementById('gtfs-attribution');
    if (!node) return;
    var attr = state.gtfsAttributions && state.gtfsAttributions[cityId];
    if (!attr || !attr.text) {
      node.hidden = true;
      node.innerHTML = '';
      return;
    }
    node.hidden = false;
    node.innerHTML = '';
    node.appendChild(document.createTextNode('Transit: '));
    if (attr.url) {
      var src = el('a', null, attr.agency ? (attr.agency + ' GTFS') : 'GTFS feed');
      src.href = attr.url;
      src.target = '_blank';
      src.rel = 'noopener noreferrer';
      node.appendChild(src);
      node.appendChild(document.createTextNode(' via City of Toronto Open Data '));
    } else {
      node.appendChild(document.createTextNode('TTC GTFS via City of Toronto Open Data '));
    }
    if (attr.license_url) {
      var lic = el('a', null, '(' + (attr.license || 'Open Data Licence') + ')');
      lic.href = attr.license_url;
      lic.target = '_blank';
      lic.rel = 'noopener noreferrer';
      node.appendChild(lic);
    } else if (attr.license) {
      node.appendChild(document.createTextNode('(' + attr.license + ')'));
    }
  }

  // ─────────── City selector ───────────

  function renderCitySelector(cities, currentId) {
    var slot = document.getElementById('city-selector');
    if (!slot) return;
    slot.innerHTML = '';

    // One-city case: keep the selector hidden, the spec is explicit.
    if (!cities || cities.length <= 1) {
      slot.hidden = true;
      return;
    }
    slot.hidden = false;

    var label = el('label', 'city-selector__label', 'City');
    label.htmlFor = 'city-selector-input';

    var select = el('select', 'city-selector__input');
    select.id = 'city-selector-input';
    cities.forEach(function (c) {
      var opt = el('option', null, c.name);
      opt.value = c.id;
      if (c.id === currentId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', function () {
      switchCity(select.value);
    });

    slot.appendChild(label);
    slot.appendChild(select);
  }

  // ─────────── View filters ───────────

  function eventTypeGroup(ev) {
    if (ev && ev.source === 'manual') return 'city';
    var seg = ((ev && ev.segment) || '').toLowerCase();
    if (seg === 'sports') return 'sports';
    if (seg === 'music')  return 'concerts';
    if (seg) return 'other';
    // Pre-`segment` forecast.json fallback: the venue category is close
    // enough until the next pipeline refresh rewrites the day files.
    var cat = ((ev && ev.category) || '').toLowerCase();
    if (cat === 'arena_sports') return 'sports';
    if (cat === 'major_concert' || cat === 'festival') return 'concerts';
    return 'other';
  }

  function isSmallVenue(ev) {
    if (!ev || ev.source === 'manual') return false;
    return typeof ev.venue_capacity === 'number' && ev.venue_capacity < SMALL_VENUE_CAP;
  }

  function typeFilterActive() {
    var f = state.typeFilter;
    return !!f && TYPE_GROUPS.some(function (g) { return f[g.id] === false; });
  }

  // Any view filter that can make the browsable view diverge from the
  // full model: a type chip off, or smaller venues hidden (the default).
  function viewFilterActive() {
    return typeFilterActive() || !state.smallVenues;
  }

  function eventVisible(ev) {
    var group = eventTypeGroup(ev);
    if (group !== 'city' && state.typeFilter && state.typeFilter[group] === false) return false;
    if (!state.smallVenues && isSmallVenue(ev)) return false;
    return true;
  }

  // Client-side view of a day's forecast with the view filters applied.
  // Recomputes the derived fields map.js + timeline.js read (timeline,
  // peak bucket/value, per-event peak_intensity, avoid windows, transit
  // flags) exactly the way the pipeline builds them, so both modules
  // render the filtered view without changes. The day VERDICT is
  // deliberately NOT recomputed here: a hidden concert still clogs the
  // TTC, so the filters change what you browse, never what's modeled.
  function filteredForecast(forecast) {
    if (!forecast || !viewFilterActive()) return forecast;

    var events = (forecast.events || []).filter(eventVisible);
    if (events.length === (forecast.events || []).length) return forecast;

    var keepIds = {};
    events.forEach(function (ev) { keepIds[ev.id || ''] = true; });

    // Re-sum the daily timeline from surviving events (mirrors
    // pipeline/timecurves.build_daily_timeline).
    var n = (forecast.timeline || []).length || 96;
    var timeline = [];
    var b;
    for (b = 0; b < n; b++) timeline.push(0);
    events.forEach(function (ev) {
      var impact = ev.impact || 0;
      var curve = ev.time_curve || [];
      for (var i = 0; i < curve.length && i < n; i++) {
        if (curve[i]) timeline[i] += impact * curve[i];
      }
    });
    var peakBucket = 0;
    var peakValue = 0;
    for (b = 0; b < timeline.length; b++) {
      if (timeline[b] > peakValue) { peakValue = timeline[b]; peakBucket = b; }
    }

    // peak_intensity is defined against the day's peak bucket, which
    // just moved — recompute per event (mirrors annotate_peak_intensity).
    events = events.map(function (ev) {
      var clone = {};
      for (var k in ev) if (Object.prototype.hasOwnProperty.call(ev, k)) clone[k] = ev[k];
      var curve = ev.time_curve || [];
      clone.peak_intensity = (ev.impact || 0) * (curve[peakBucket] || 0);
      return clone;
    });

    var out = {};
    for (var key in forecast) if (Object.prototype.hasOwnProperty.call(forecast, key)) out[key] = forecast[key];
    out.events = events;
    out.event_count = events.length;
    out.timeline = timeline;
    out.peak_bucket = peakBucket;
    out.peak_value = peakValue;
    out.avoid_windows = (forecast.avoid_windows || []).filter(function (w) {
      return keepIds[w.event_id];
    });
    if (forecast.transit_flags) {
      var tfOut = {};
      for (var tk in forecast.transit_flags) {
        if (Object.prototype.hasOwnProperty.call(forecast.transit_flags, tk)) {
          tfOut[tk] = forecast.transit_flags[tk];
        }
      }
      tfOut.events = (forecast.transit_flags.events || []).filter(function (te) {
        return keepIds[te.event_id];
      });
      out.transit_flags = tfOut;
    }
    return out;
  }

  // ─────────── Verdict display (all-events vs filtered) ───────────

  function bucketVerdict(peak, thresholds) {
    var t = thresholds || {};
    var t1 = typeof t.T1 === 'number' ? t.T1 : 5;
    var t2 = typeof t.T2 === 'number' ? t.T2 : 30;
    var t3 = typeof t.T3 === 'number' ? t.T3 : 65;
    if (peak < t1) return 'Quiet';
    if (peak < t2) return 'Moderate';
    if (peak < t3) return 'Busy';
    return 'Severe';
  }

  // The verdict shown for a day. Default: the server's full-model
  // verdict. In 'filtered' mode (opt-in switch) the day re-buckets from
  // only the visible events' proxy_contribution (impact × time-of-day
  // weight, shipped per event) against the same thresholds the
  // pipeline used. Falls back to raw impact for pre-`proxy_contribution`
  // day files.
  function displayVerdict(forecast) {
    if (!forecast) return '—';
    if (state.verdictMode !== 'filtered' || !viewFilterActive()) {
      return forecast.verdict || '—';
    }
    var events = ((filteredForecast(forecast) || {}).events) || [];
    var peak = 0;
    events.forEach(function (ev) {
      peak += (typeof ev.proxy_contribution === 'number')
        ? ev.proxy_contribution
        : (ev.impact || 0);
    });
    return bucketVerdict(peak, forecast.thresholds);
  }

  function rerenderAll() {
    renderTypeFilter();
    renderForecastStrip();
    if (state.selectedDate) renderDetailForSelected();
  }

  function renderTypeFilter() {
    var host = document.getElementById('event-filter');
    if (!host) return;
    host.innerHTML = '';
    host.hidden = false;

    TYPE_GROUPS.forEach(function (g) {
      var on = state.typeFilter[g.id] !== false;
      var chip = el('button', 'event-filter__chip', g.label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.setAttribute('data-group', g.id);
      chip.addEventListener('click', function () {
        state.typeFilter[g.id] = state.typeFilter[g.id] === false;
        saveJson(TYPE_FILTER_KEY, state.typeFilter);
        rerenderAll();
      });
      host.appendChild(chip);
    });

    // "Smaller venues" chip — sub-5k halls and theatres. Off by default
    // so the browsable view stays about the stadium-scale events.
    var small = el('button', 'event-filter__chip event-filter__chip--small', 'Smaller venues');
    small.type = 'button';
    small.setAttribute('aria-pressed', state.smallVenues ? 'true' : 'false');
    small.setAttribute('data-group', 'small');
    small.title = 'Venues under ' + SMALL_VENUE_CAP.toLocaleString('en-US') + ' seats';
    small.addEventListener('click', function () {
      state.smallVenues = !state.smallVenues;
      saveJson(SMALL_VENUES_KEY, state.smallVenues);
      rerenderAll();
    });
    host.appendChild(small);

    // Say what the verdicts mean when a type chip hides something big,
    // or when the switch below re-buckets them. Hidden smaller venues
    // alone don't earn the note — they barely move the verdict.
    if (state.verdictMode === 'filtered' && viewFilterActive()) {
      host.appendChild(el('span', 'event-filter__note', 'Busyness counts shown events only.'));
    } else if (typeFilterActive()) {
      host.appendChild(el('span', 'event-filter__note', 'Busyness still counts hidden events.'));
    }

    // Right side: opt-in switch that re-buckets day verdicts from only
    // the visible events.
    var toggleWrap = el('label', 'event-filter__toggle-wrap');
    var toggle = el('button', 'event-filter__toggle');
    toggle.type = 'button';
    toggle.id = 'verdict-mode-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', state.verdictMode === 'filtered' ? 'true' : 'false');
    toggle.setAttribute('aria-label', 'Busyness from shown events only');
    toggle.appendChild(el('span', 'event-filter__toggle-knob'));
    toggle.addEventListener('click', function () {
      state.verdictMode = state.verdictMode === 'filtered' ? 'all' : 'filtered';
      saveJson(VERDICT_MODE_KEY, state.verdictMode);
      rerenderAll();
    });
    toggleWrap.appendChild(el('span', 'event-filter__toggle-label', 'Busyness from shown only'));
    toggleWrap.appendChild(toggle);
    host.appendChild(toggleWrap);
  }

  // ─────────── Event helpers ───────────

  // Events sorted by impact (the pipeline ships them that way; re-sort
  // defensively so a hand-edited file still reads right).
  function sortedEvents(list) {
    return (list || []).slice().sort(function (a, b) { return (b.impact || 0) - (a.impact || 0); });
  }

  function majorEvents(forecast) {
    return sortedEvents(forecast && forecast.events).filter(function (ev) { return !isSmallVenue(ev); });
  }

  function smallEvents(forecast) {
    return sortedEvents(forecast && forecast.events).filter(isSmallVenue);
  }

  function humanCategory(cat) {
    switch ((cat || '').toLowerCase()) {
      case 'major_concert':   return 'Concert';
      case 'arena_sports':    return 'Sports';
      case 'performing_arts': return 'Performing arts';
      case 'comedy':          return 'Comedy';
      case 'festival':        return 'City event';
      case 'family_other':    return 'Family / other';
      default:                return cat || '—';
    }
  }

  // Badge text for a line. The coloured badge already says "line", so a
  // subway line is just its number ("1"), a streetcar its route ("504").
  function lineLabel(line, kind) {
    return String(line == null ? '' : line);
  }

  // Agency line colour from city config (line_colors: subway line id →
  // hex, plus "streetcar" / "go" per kind). Brand data, not a design
  // token — the MTA's or CTA's palette lands in its own city.json.
  function lineColor(line, kind) {
    var colors = (state.cityConfig && state.cityConfig.line_colors) || {};
    var key = kind === 'subway' ? String(line) : kind;
    var c = colors[key];
    return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : null;
  }

  // Dark or light text on a coloured pill, from the token text colours.
  function contrastTextFor(hex) {
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    var t = window.TOKENS && window.TOKENS.semantic && window.TOKENS.semantic.color.text;
    if (lum > 0.55) return (t && t.inverse) || '#020617';
    return (t && t.primary) || '#F8FAFC';
  }

  function joinNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  }

  // ─────────── Forecast strip (7-day outlook) ───────────

  function pillSubline(forecast) {
    var view = filteredForecast(forecast);
    var events = sortedEvents(view && view.events);
    var hiddenSmall = (!state.smallVenues) ? smallEvents(forecast).length : 0;
    if (events.length === 0) {
      if (hiddenSmall > 0) {
        return { text: hiddenSmall + ' smaller show' + (hiddenSmall === 1 ? '' : 's') + ' only', muted: true };
      }
      var rawCount = ((forecast && forecast.events) || []).length;
      return { text: rawCount > 0 ? 'Filtered out' : 'Nothing major', muted: true };
    }
    var top = events[0];
    var more = events.length - 1;
    return { text: top.name + (more > 0 ? ' +' + more : ''), muted: false };
  }

  function renderDayPill(date, forecast, tz, index) {
    var verdictLabelText = displayVerdict(forecast);
    var pill = el('button', 'day-pill');
    pill.type = 'button';
    pill.setAttribute('data-date', date);
    pill.setAttribute('data-verdict', verdictKey(verdictLabelText));
    pill.setAttribute('aria-pressed', state.selectedDate === date ? 'true' : 'false');
    if (state.selectedDate === date) pill.setAttribute('data-selected', 'true');
    pill.style.setProperty('--i', String(index));

    var when = el('span', 'day-pill__when');
    when.appendChild(el('span', 'day-pill__day', relativeDayLabel(date, tz)));
    when.appendChild(el('span', 'day-pill__date', shortDate(date, tz)));
    pill.appendChild(when);

    pill.appendChild(el('span', 'day-pill__verdict', verdictLabelText));

    // Mini busyness graph, drawn once the strip is in the DOM (see
    // drawSparklines). Decorative for assistive tech: the verdict and
    // the peak line below carry the same information in text.
    var spark = document.createElement('canvas');
    spark.className = 'day-pill__spark';
    spark.setAttribute('aria-hidden', 'true');
    pill.appendChild(spark);

    // The "when" in the headline strip: the peak 15 minutes of the
    // browsable view, so it moves with the filters like the sub-line.
    var view = filteredForecast(forecast);
    if (view && view.events && view.events.length && typeof view.peak_bucket === 'number') {
      pill.appendChild(el('span', 'day-pill__peak', 'Peak ' + clockFromBucket(view.peak_bucket)));
    }

    var sub = pillSubline(forecast);
    var subNode = el('span', 'day-pill__sub' + (sub.muted ? ' day-pill__sub--muted' : ''), sub.text);
    subNode.title = sub.text;
    pill.appendChild(subNode);

    return pill;
  }

  function renderForecastStrip() {
    var host = document.getElementById('forecast-strip');
    if (!host) return;
    host.innerHTML = '';

    var grid = el('div', 'forecast-strip__grid');
    grid.setAttribute('role', 'group');
    var tz = state.cityConfig && state.cityConfig.timezone;

    state.days.forEach(function (date, i) {
      grid.appendChild(renderDayPill(date, state.forecasts[date], tz, i));
    });

    grid.addEventListener('click', function (evt) {
      var pill = evt.target && evt.target.closest && evt.target.closest('.day-pill');
      if (!pill) return;
      var d = pill.getAttribute('data-date');
      if (d) selectDate(d);
    });

    host.appendChild(grid);
    drawSparklines();
    observeStripResize(grid);
  }

  // ─────────── Mini graphs in the day cards ───────────

  var SPARK_DAY_START = 9 * 4;   // 9 AM in 15-minute buckets
  var _sparkRO = null;
  var _sparkRaf = 0;

  // One time window for every card so the mini graphs line up: 9 AM to
  // the end of the modeled day, pulled earlier (to the hour) when any
  // day in the outlook has modeled activity at or above the Quiet
  // threshold before that. Mirrors the main chart's default range.
  function sparkWindow() {
    var n = 0;
    var start = SPARK_DAY_START;
    state.days.forEach(function (date) {
      var view = filteredForecast(state.forecasts[date]);
      var tl = (view && view.timeline) || [];
      n = Math.max(n, tl.length);
      var th = view && view.thresholds;
      var t1 = (th && typeof th.T1 === 'number') ? th.T1 : 5;
      for (var b = 0; b < start; b++) {
        if (tl[b] >= t1) { start = Math.floor(b / 4) * 4; break; }
      }
    });
    if (!n) n = 96;
    return { from: Math.min(start, n - 2), to: n };
  }

  function drawSparklines() {
    var tl = window.EFTimeline;
    if (!tl || !tl.sparkline) return;
    var win = sparkWindow();
    var tz = state.cityConfig && state.cityConfig.timezone;
    var pills = document.querySelectorAll('.day-pill');
    for (var i = 0; i < pills.length; i++) {
      var canvas = pills[i].querySelector('.day-pill__spark');
      if (!canvas) continue;
      var date = pills[i].getAttribute('data-date');
      var forecast = state.forecasts[date];
      var now = (tl.nowBucketForDate && tz) ? tl.nowBucketForDate(date, tz) : null;
      tl.sparkline(canvas, filteredForecast(forecast), {
        from: win.from,
        to: win.to,
        verdict: displayVerdict(forecast),
        now: now
      });
    }
  }

  function scheduleSparklines() {
    if (_sparkRaf) return;
    _sparkRaf = window.requestAnimationFrame(function () {
      _sparkRaf = 0;
      drawSparklines();
    });
  }

  // Cards change width with the viewport (7-up grid on desktop, a
  // scroll strip on phones), so redraw when the grid is resized.
  function observeStripResize(grid) {
    if (window.ResizeObserver) {
      if (_sparkRO) _sparkRO.disconnect();
      _sparkRO = new ResizeObserver(scheduleSparklines);
      _sparkRO.observe(grid);
    } else if (!observeStripResize.bound) {
      observeStripResize.bound = true;
      window.addEventListener('resize', scheduleSparklines);
    }
  }

  // ─────────── Selected day ───────────

  function selectDate(date) {
    if (!date || !state.forecasts[date]) return;
    state.selectedDate = date;
    var pills = document.querySelectorAll('.day-pill');
    for (var i = 0; i < pills.length; i++) {
      var p = pills[i];
      var match = p.getAttribute('data-date') === date;
      p.setAttribute('aria-pressed', match ? 'true' : 'false');
      if (match) p.setAttribute('data-selected', 'true');
      else p.removeAttribute('data-selected');
    }
    renderDetailForSelected();
  }

  // ─────────── Detail scaffold ───────────

  function ensureDetailScaffold() {
    // Build the detail panel's stable DOM exactly once. The Leaflet map
    // is bound to #map-canvas; tearing the host down on every day-change
    // would detach the map. Day changes only update text + call the
    // module setters.
    var host = document.getElementById('forecast-detail');
    if (!host || host.dataset.scaffolded === 'true') return;
    host.innerHTML = '';

    var header = el('div', 'forecast-detail__header');
    var left = el('div', 'forecast-detail__header-main');
    left.appendChild(el('div', 'forecast-detail__eyebrow', 'Selected day'));
    var title = el('div', 'forecast-detail__title');
    title.id = 'forecast-detail-title';
    left.appendChild(title);
    var driver = el('div', 'forecast-detail__driver');
    driver.id = 'forecast-detail-driver';
    left.appendChild(driver);
    header.appendChild(left);
    host.appendChild(header);

    var timelineHost = el('div', 'forecast-detail__timeline');
    timelineHost.id = 'timeline-host';
    host.appendChild(timelineHost);

    var mapWrap = el('div', 'forecast-detail__map-wrap');
    var mapHost = el('div', 'forecast-detail__map');
    mapHost.id = 'map-canvas';
    mapWrap.appendChild(mapHost);
    host.appendChild(mapWrap);

    var railHost = el('section', 'forecast-detail__rail');
    railHost.id = 'rail-host';
    railHost.setAttribute('aria-label', 'Events at the selected time');
    host.appendChild(railHost);

    host.dataset.scaffolded = 'true';

    // Wire the timeline's scrubber to map + stations + rail. The scrubber
    // is the single source of truth for state.selectedBucket.
    if (window.EFTimeline) {
      window.EFTimeline.ensureTimeline(timelineHost, function (bucket) {
        state.selectedBucket = bucket;
        if (window.EFMap && window.EFMap.setBucket) {
          window.EFMap.setBucket(bucket);
        }
        renderRail();
      });
    }
  }

  function renderDetailForSelected() {
    ensureDetailScaffold();
    var date = state.selectedDate;
    var forecast = date && state.forecasts[date];
    if (!forecast) return;
    // Map, timeline, stations, and rail render the filtered view; the
    // header verdict and driver line stay full-model.
    var view = filteredForecast(forecast);
    var tz = state.cityConfig && state.cityConfig.timezone;

    var verdictText = displayVerdict(forecast);
    var title = document.getElementById('forecast-detail-title');
    if (title) {
      title.textContent = '';
      title.setAttribute('data-verdict', verdictKey(verdictText));
      title.appendChild(document.createTextNode(friendlyDate(date, tz) + ' · '));
      title.appendChild(el('span', 'forecast-detail__title-verdict', verdictText));
    }
    var driver = document.getElementById('forecast-detail-driver');
    if (driver) driver.textContent = driverText(forecast, tz);

    // Reset bucket selection to the new day's peak (M3 spec).
    var newBucket = (typeof view.peak_bucket === 'number') ? view.peak_bucket : 0;
    state.selectedBucket = newBucket;

    if (window.EFTimeline) {
      window.EFTimeline.setForecast(view, state.cityConfig);
      renderTimelineStations(view);
    }

    var mapHost = document.getElementById('map-canvas');
    if (!window.EFMap || !window.L || !mapHost) {
      if (mapHost) mapHost.textContent = 'Map unavailable (Leaflet failed to load).';
    } else {
      var bbox = state.cityConfig && state.cityConfig.bbox;
      window.EFMap.ensureMap(mapHost, bbox, {
        defaultView: state.cityConfig && state.cityConfig.map_default_view
      });
      window.EFMap.invalidate();
      if (window.EFMap.setStations) {
        window.EFMap.setStations(stationCollectionFromForecast(view));
      }
      window.EFMap.setForecast(view, state.cityConfig);
    }
    renderRail();
  }

  // ─────────── Driver line ───────────

  // "Because Toronto Blue Jays vs. New York Yankees at Rogers Centre
  // (about 39,000 people)." Full-model, so it explains the verdict.
  function driverText(forecast, tz) {
    var major = majorEvents(forecast);
    var small = smallEvents(forecast);
    if (major.length === 0) {
      if (small.length === 0) return 'Nothing major on.';
      return 'Only smaller shows on: ' + small.length + ' at venues under ' +
        SMALL_VENUE_CAP.toLocaleString('en-US') + ' seats.';
    }
    var top = major[0];
    var people = roundPeople(top.venue_capacity);
    var text = 'Because ' + top.name +
      (top.source === 'manual' ? ' along ' + top.venue_name : ' at ' + top.venue_name);
    if (people) text += ' (about ' + people + ' people)';
    if (major.length > 1) text += ', plus ' + (major.length - 1) + ' more';
    return text + '.';
  }

  // ─────────── Stations panel ───────────

  function kindShown(kind) {
    if (kind === 'subway') return true;
    if (kind === 'go' || kind === 'streetcar') return state.transitKinds[kind] === true;
    return false;
  }

  // Invert the per-event transit flags into per-station busy windows,
  // merged across events, for the current view.
  function stationRows(view) {
    var tf = view && view.transit_flags;
    var evList = (tf && tf.events) || [];
    var eventsById = {};
    (view.events || []).forEach(function (ev) { eventsById[ev.id || ''] = ev; });
    var windowsByEvent = {};
    (view.avoid_windows || []).forEach(function (w) {
      (windowsByEvent[w.event_id] = windowsByEvent[w.event_id] || []).push(w);
    });

    var byId = {};
    var hiddenKinds = {};
    evList.forEach(function (te) {
      var ev = eventsById[te.event_id];
      if (!ev) return;
      var wins = windowsByEvent[te.event_id] || [];
      (te.stations || []).forEach(function (s) {
        if (!kindShown(s.kind)) { hiddenKinds[s.kind] = true; return; }
        var rec = byId[s.station_id];
        if (!rec) {
          rec = byId[s.station_id] = {
            id: s.station_id,
            name: s.station_name,
            kind: s.kind,
            lines: (s.lines || []).slice(),
            lat: s.lat,
            lon: s.lon,
            windows: []
          };
        }
        wins.forEach(function (w) {
          rec.windows.push({
            from: w.from_minute,
            to: w.to_minute,
            phase: w.kind,
            event: ev.name,
            via: s.via || ''
          });
        });
      });
    });

    var rows = [];
    Object.keys(byId).forEach(function (id) {
      var rec = byId[id];
      rec.windows.sort(function (a, b) { return a.from - b.from; });
      // Merge overlapping windows into busy spans.
      var spans = [];
      rec.windows.forEach(function (w) {
        var last = spans[spans.length - 1];
        if (last && w.from <= last.to) {
          last.to = Math.max(last.to, w.to);
          if (last.phases.indexOf(w.phase) < 0) last.phases.push(w.phase);
          if (last.causes.indexOf(w.event) < 0) last.causes.push(w.event);
          if (w.via && !last.via) last.via = w.via;
        } else {
          spans.push({ from: w.from, to: w.to, phases: [w.phase], causes: [w.event], via: w.via });
        }
      });
      rec.spans = spans;
      rec.first = spans.length ? spans[0].from : Infinity;
      rows.push(rec);
    });
    // Subway first, then streetcar, then GO; within a kind, earliest
    // window first. Kind wins over time so the toggles append groups
    // below the subway rows instead of shuffling them.
    var order = { subway: 0, streetcar: 1, go: 2 };
    function rank(kind) { return Object.prototype.hasOwnProperty.call(order, kind) ? order[kind] : 9; }
    rows.sort(function (a, b) {
      return (rank(a.kind) - rank(b.kind)) || (a.first - b.first) || a.name.localeCompare(b.name);
    });
    return { rows: rows, hiddenKinds: hiddenKinds };
  }

  function phaseWord(phases) {
    var hasIn = phases.indexOf('arrival') >= 0;
    var hasOut = phases.indexOf('dispersal') >= 0;
    if (hasIn && hasOut) return 'In + out';
    if (hasOut) return 'Out';
    return 'In';
  }

  function kindLabel(kind) {
    if (kind === 'go') return 'GO';
    if (kind === 'streetcar') return 'Streetcar';
    return 'Subway';
  }

  // Rows for the timeline's station lanes: a compact chip per busy
  // window (name + line badge), full details for the hover popover.
  function stationLaneRows(view) {
    var result = stationRows(view);
    var rows = result.rows.map(function (row) {
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        kindLabel: kindLabel(row.kind),
        lines: row.lines.slice(0, 3).map(function (l) {
          var c = lineColor(l, row.kind);
          return { label: lineLabel(l, row.kind), color: c, text: c ? contrastTextFor(c) : null };
        }),
        spans: row.spans.map(function (sp) {
          var cause = sp.causes.slice(0, 2).join(', ') +
            (sp.causes.length > 2 ? ' +' + (sp.causes.length - 2) : '');
          return {
            fromBucket: sp.from / BUCKET_MIN,
            toBucket: sp.to / BUCKET_MIN,
            phase: sp.phases.length > 1 ? 'both' : sp.phases[0],
            phaseWord: phaseWord(sp.phases),
            time: rangeLabel(sp.from, sp.to),
            cause: cause,
            via: sp.via || ''
          };
        })
      };
    });
    return { rows: rows, hiddenKinds: result.hiddenKinds };
  }

  function stationsEmptyText(view, hiddenKinds) {
    var hasEvents = !!(view && view.events && view.events.length);
    if (!hasEvents) return 'Nothing major on, so no stations are flagged.';
    var hidden = [];
    if (hiddenKinds.streetcar) hidden.push('Streetcar');
    if (hiddenKinds.go) hidden.push('GO');
    if (hidden.length) {
      return 'No subway station within walking distance of these events. Turn on ' +
        joinNames(hidden) + ' to see the surface routes that will fill up instead.';
    }
    return 'No subway station within walking distance of these events.';
  }

  // Hand the day's station rows and the kind toggles to the timeline,
  // which draws them as lanes under the curve.
  function renderTimelineStations(view) {
    if (!window.EFTimeline || !window.EFTimeline.setStations) return;
    if (!view) {
      window.EFTimeline.setStations([], {});
      return;
    }
    var r = stationLaneRows(view);
    var toggles = TRANSIT_TOGGLES.map(function (t) {
      return {
        id: t.id,
        label: t.label,
        pressed: state.transitKinds[t.id] === true,
        onToggle: function () {
          state.transitKinds[t.id] = !state.transitKinds[t.id];
          saveJson(TRANSIT_KINDS_KEY, state.transitKinds);
          renderTimelineStations(view);
          if (window.EFMap && window.EFMap.setStations) {
            window.EFMap.setStations(stationCollectionFromForecast(view));
            window.EFMap.setForecast(view, state.cityConfig);
            if (typeof state.selectedBucket === 'number') window.EFMap.setBucket(state.selectedBucket);
          }
        }
      };
    });
    window.EFTimeline.setStations(r.rows, {
      toggles: toggles,
      emptyText: stationsEmptyText(view, r.hiddenKinds)
    });
  }

  // Flat, deduped station list for the map, respecting the kind toggles.
  function stationCollectionFromForecast(forecast) {
    var tf = forecast && forecast.transit_flags;
    var evList = (tf && tf.events) || [];
    var byId = {};
    for (var i = 0; i < evList.length; i++) {
      var stations = evList[i].stations || [];
      for (var j = 0; j < stations.length; j++) {
        var s = stations[j];
        if (!kindShown(s.kind)) continue;
        if (!byId[s.station_id]) {
          byId[s.station_id] = {
            station_id: s.station_id,
            station_name: s.station_name,
            kind: s.kind,
            lat: s.lat,
            lon: s.lon,
            lines: (s.lines || []).map(function (l) { return lineLabel(l, s.kind); }),
            lineColors: (s.lines || []).map(function (l) { return lineColor(l, s.kind); }),
            lineText: (s.lines || []).map(function (l) {
              var c = lineColor(l, s.kind);
              return c ? contrastTextFor(c) : null;
            })
          };
        }
      }
    }
    var out = [];
    for (var k in byId) if (Object.prototype.hasOwnProperty.call(byId, k)) out.push(byId[k]);
    return out;
  }

  // ─────────── Events rail ───────────

  // The rail shows events that have meaningful presence at the selected
  // bucket. "Meaningful" = time_curve[bucket] above a small floor so the
  // 10%-during-event background doesn't bury an event's peak neighbours.
  var RAIL_PRESENCE_FLOOR = 0.05;

  function eventsForBucket(forecast, bucket) {
    var events = (forecast && forecast.events) || [];
    var out = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var curve = ev && ev.time_curve;
      if (!curve) continue;
      var w = (bucket >= 0 && bucket < curve.length) ? curve[bucket] : 0;
      if (w < RAIL_PRESENCE_FLOOR) continue;
      out.push({ ev: ev, w: w, intensity: (ev.impact || 0) * w });
    }
    out.sort(function (a, b) { return b.intensity - a.intensity; });
    return out;
  }

  function isoMinutesOfDay(s) {
    if (!s || typeof s !== 'string') return null;
    var t = s.indexOf('T');
    if (t < 0) return null;
    var hh = parseInt(s.substr(t + 1, 2), 10);
    var mm = parseInt(s.substr(t + 4, 2), 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    return hh * 60 + mm;
  }

  // Categorize the event's presence at this bucket into a chip label.
  function bucketPhaseLabel(ev, bucket) {
    if (!ev) return { label: '', kind: 'during' };
    var startMin = isoMinutesOfDay(ev.start_local);
    var endMin   = isoMinutesOfDay(ev.end_local);
    var bucketMin = (bucket || 0) * BUCKET_MIN + BUCKET_MIN / 2;
    var startDay = (ev.start_local || '').slice(0, 10);
    var endDay   = (ev.end_local   || '').slice(0, 10);
    var selDay   = state.selectedDate;
    if (startMin == null || endMin == null || !selDay) {
      return { label: 'During', kind: 'during' };
    }
    var startAbs = startMin + dayDelta(selDay, startDay) * 24 * 60;
    var endAbs   = endMin   + dayDelta(selDay, endDay)   * 24 * 60;
    if (bucketMin < startAbs) return { label: 'In', kind: 'arrival' };
    if (bucketMin > endAbs)   return { label: 'Out', kind: 'dispersal' };
    return { label: 'During', kind: 'during' };
  }

  function renderRail() {
    var host = document.getElementById('rail-host');
    if (!host) return;
    var date = state.selectedDate;
    var forecast = date && filteredForecast(state.forecasts[date]);
    var tz = state.cityConfig && state.cityConfig.timezone;
    var bucket = (typeof state.selectedBucket === 'number')
      ? state.selectedBucket
      : (forecast && forecast.peak_bucket) || 0;

    host.innerHTML = '';

    var head = el('div', 'rail__head');
    head.appendChild(el('span', 'rail__eyebrow', 'Events at'));
    head.appendChild(el('span', 'rail__time', clockFromBucket(bucket)));
    host.appendChild(head);

    if (!forecast) return;
    var entries = eventsForBucket(forecast, bucket);

    if (entries.length === 0) {
      host.appendChild(el('div', 'rail__empty', 'No major event is moving a crowd at this time.'));
      return;
    }

    var list = el('ol', 'rail__list');
    list.setAttribute('role', 'list');
    for (var i = 0; i < entries.length; i++) {
      list.appendChild(renderRailItem(entries[i], bucket, tz));
    }
    host.appendChild(list);
  }

  function renderRailItem(entry, bucket, tz) {
    var ev = entry.ev;
    var item = el('li', 'rail__item');
    item.setAttribute('data-event-id', ev.id || '');

    var topRow = el('div', 'rail__row rail__row--top');
    var phase = bucketPhaseLabel(ev, bucket);
    topRow.appendChild(el('span', 'rail__phase rail__phase--' + phase.kind, phase.label));
    topRow.appendChild(el('span', 'rail__name', ev.name || '(untitled event)'));
    item.appendChild(topRow);

    var meta = el('div', 'rail__meta');
    meta.appendChild(el('span', 'rail__venue', ev.venue_name || ''));
    meta.appendChild(el('span', 'rail__sep', '·'));
    meta.appendChild(el('span', 'rail__category', humanCategory(ev.category)));
    meta.appendChild(el('span', 'rail__sep', '·'));
    meta.appendChild(el('span', 'rail__times',
      friendlyTime(ev.start_local, tz) + ' – ' + friendlyTime(ev.end_local, tz)));
    var people = roundPeople(ev.venue_capacity);
    if (people) {
      meta.appendChild(el('span', 'rail__sep', '·'));
      meta.appendChild(el('span', 'rail__people', 'about ' + people + ' people'));
    }
    item.appendChild(meta);

    if (ev.note) item.appendChild(el('div', 'rail__note', ev.note));

    if (ev.ticketmaster_url) {
      var link = el('a', 'rail__link', 'Tickets on Ticketmaster');
      link.href = ev.ticketmaster_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.appendChild(link);
    }
    return item;
  }

  function renderEmptyState(message) {
    var host = document.getElementById('forecast-strip');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(el('div', 'forecast-strip__empty', message));
  }

  // ─────────── M6: status banner + designed empty / stale states ───────────

  function friendlyTimestamp(iso, tz) {
    if (!iso) return 'never';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      var dateOpts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      if (tz) dateOpts.timeZone = tz;
      return new Intl.DateTimeFormat('en-US', dateOpts).format(d);
    } catch (_) {
      return iso;
    }
  }

  function renderStatusBanner(freshness, cityCfg) {
    var node = document.getElementById('status-banner');
    if (!node) return;
    node.innerHTML = '';
    node.removeAttribute('data-kind');
    if (!freshness || !freshness.present) {
      node.hidden = true;
      return;
    }
    var tz = cityCfg && cityCfg.timezone;
    var kind = null;
    var eyebrow = '';
    var body = '';

    var tm = freshness.tm || {};
    var gtfs = freshness.gtfs || {};
    var zeroEvent = !!freshness.zero_event_run;

    if (tm.budget_exhausted) {
      kind = 'warning';
      eyebrow = 'Cached forecast';
      body = 'Daily Ticketmaster budget reached. Showing the last successful refresh from ' +
        friendlyTimestamp(tm.last_success_at, tz) + '.';
    } else if (tm.stale && tm.last_success_at) {
      kind = 'warning';
      eyebrow = 'Forecast may be stale';
      body = 'Ticketmaster refresh hasn’t completed in over ' + (tm.max_age_minutes || 180) +
        ' minutes. Last good fetch: ' + friendlyTimestamp(tm.last_success_at, tz) + '.';
    } else if (tm.stale && !tm.last_success_at) {
      kind = 'error';
      eyebrow = 'Forecast unavailable';
      body = 'No successful Ticketmaster refresh on record yet. The pipeline may not have run.';
    } else if (zeroEvent) {
      kind = 'info';
      eyebrow = 'Quiet week';
      body = 'No major events meet the whitelist for any day in the window. Either a genuinely quiet stretch or an upstream feed change worth investigating.';
    } else if (gtfs.stale) {
      kind = 'info';
      eyebrow = 'Transit data older than expected';
      body = 'Static GTFS hasn’t refreshed in over ' + (gtfs.max_age_days || 14) +
        ' days. Map + stations still use the last-known lines.';
    }

    if (!kind) {
      node.hidden = true;
      return;
    }

    node.hidden = false;
    node.setAttribute('data-kind', kind);
    var dot = el('span', 'status-banner__dot');
    dot.setAttribute('aria-hidden', 'true');
    node.appendChild(dot);
    var content = el('div', 'status-banner__content');
    content.appendChild(el('span', 'status-banner__eyebrow', eyebrow));
    content.appendChild(el('span', 'status-banner__body', body));
    node.appendChild(content);
  }

  function designedEmptyForecastMessage(cityCfg) {
    var name = (cityCfg && cityCfg.name) || 'this city';
    return 'No major events meet the whitelist for ' + name + ' in the next 7 days. ' +
      'The forecast only tracks venues ~5,000+ capacity (plus all pro sports venues), so a quiet ' +
      'week here can be a genuinely quiet week, not a data problem.';
  }

  // ─────────── City switching ───────────

  function switchCity(cityId) {
    if (!cityId || cityId === state.currentCityId) return;
    state.currentCityId = cityId;
    state.cityConfig = null;
    state.days = [];
    state.forecasts = {};
    state.selectedDate = null;
    renderEmptyState('Loading ' + cityId + '…');
    loadCurrentCity().catch(function (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      renderEmptyState('Could not load forecast for ' + cityId + '.');
    });
  }

  // Today first. The API already serves today-onward, so the first day
  // is today (or the earliest day available when today has no file).
  function pickInitialDate() {
    return state.days[0] || null;
  }

  function loadCurrentCity() {
    var cityId = state.currentCityId;
    return fetchJson('api/city.php?id=' + encodeURIComponent(cityId)).then(function (resp) {
      state.cityConfig = resp.city;
      state.freshness = resp.freshness || null;
      if (resp.map_attribution) {
        state.mapAttribution = resp.map_attribution;
        renderMapAttribution(resp.map_attribution);
      }
      if (resp.gtfs_attribution) {
        state.gtfsAttributions[cityId] = resp.gtfs_attribution;
      }
      renderGtfsAttribution(cityId);
      renderStatusBanner(state.freshness, state.cityConfig);
      state.days = (resp.days || []).slice(0, 7);
      if (state.days.length === 0) {
        renderEmptyState(designedEmptyForecastMessage(state.cityConfig));
        return;
      }
      return Promise.all(
        state.days.map(function (d) {
          return fetchJson(
            'api/forecast.php?city=' + encodeURIComponent(cityId) + '&date=' + encodeURIComponent(d)
          );
        })
      ).then(function (forecasts) {
        state.days.forEach(function (d, i) {
          state.forecasts[d] = forecasts[i];
        });
        state.selectedDate = pickInitialDate();
        renderTypeFilter();
        renderForecastStrip();
        if (state.selectedDate) renderDetailForSelected();
      });
    });
  }

  // ─────────── Bootstrap ───────────

  function init() {
    applyTheme();
    fetchJson('api/cities.php').then(function (resp) {
      state.cities = resp.cities || [];
      renderAttribution(resp.attribution);
      if (resp.map_attribution) {
        state.mapAttribution = resp.map_attribution;
        renderMapAttribution(resp.map_attribution);
      }
      if (resp.gtfs_attributions && typeof resp.gtfs_attributions === 'object') {
        state.gtfsAttributions = resp.gtfs_attributions;
      }

      if (state.cities.length === 0) {
        renderEmptyState('No cities configured.');
        return;
      }

      state.currentCityId = state.cities[0].id;
      renderCitySelector(state.cities, state.currentCityId);
      renderGtfsAttribution(state.currentCityId);
      return loadCurrentCity();
    }).catch(function (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      renderEmptyState(
        'Forecast unavailable. Check that the API is reachable, then refresh. ' +
        'If the issue persists, the cron may not be running.'
      );
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
