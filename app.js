/*
 * Event Forecast — App entry point.
 *
 * Vanilla JS, no framework, no build step. Loads the configured cities,
 * picks one (selector appears only when >1 city is configured), pulls
 * the next 7 days of forecast JSON from the PHP layer, and renders the
 * multi-day forecast strip. Map + timeline come in later milestones.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'eventforecast.theme';
  var DEFAULT_THEME = 'dark';
  var TYPE_FILTER_KEY = 'eventforecast.typeFilter';

  // Event-type filter groups. Grouping is TM-segment first (an event's
  // own classification), venue-category fallback for forecast.json
  // written before `segment` shipped.
  var TYPE_GROUPS = [
    { id: 'sports',   label: 'Sports' },
    { id: 'concerts', label: 'Concerts' },
    { id: 'other',    label: 'Theatre & other' }
  ];

  function loadTypeFilter() {
    var out = { sports: true, concerts: true, other: true };
    try {
      var parsed = JSON.parse(localStorage.getItem(TYPE_FILTER_KEY) || '{}');
      TYPE_GROUPS.forEach(function (g) {
        if (parsed && parsed[g.id] === false) out[g.id] = false;
      });
    } catch (e) {}
    return out;
  }

  var VERDICT_MODE_KEY = 'eventforecast.verdictMode';

  function loadVerdictMode() {
    try {
      return localStorage.getItem(VERDICT_MODE_KEY) === 'filtered' ? 'filtered' : 'all';
    } catch (e) {
      return 'all';
    }
  }

  var state = {
    // Persisted event-type chip selection. All-on means "no filtering".
    typeFilter: loadTypeFilter(),
    // 'all': day verdicts reflect every modeled event (default).
    // 'filtered': verdicts re-bucket from only the events the type
    // filter shows — "how busy because of the stuff I care about".
    verdictMode: loadVerdictMode(),
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

  var BUCKETS_PER_DAY = 96;
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

  function friendlyTime(isoDateTime, tz) {
    if (!isoDateTime) return '';
    var d = new Date(isoDateTime);
    if (isNaN(d.getTime())) return '';
    var opts = { hour: 'numeric', minute: '2-digit' };
    if (tz) opts.timeZone = tz;
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  }

  function verdictKey(verdict) {
    return (verdict || '').toLowerCase();
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
  // even when the map host hasn't been initialized yet (e.g. before a
  // day is selected, or on a zero-event city).
  function renderMapAttribution(mapAttr) {
    if (!mapAttr) return;
    var node = document.getElementById('map-attribution');
    if (!node) return;
    node.innerHTML = '';
    var lead = document.createTextNode('Map: ');
    node.appendChild(lead);
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
  // MVP is Toronto-only, so the lookup always resolves to one entry,
  // but the API ships a city_id-keyed map so the M5 expansion is a
  // drop-in (one credit line per active city's transit feed).
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
    // The licence link is the contractually-required disclosure; the
    // dataset URL is the courteous "find the source" link.
    var leadText = 'Transit: ';
    node.appendChild(document.createTextNode(leadText));
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

  // ─────────── Event-type filter ───────────

  function saveTypeFilter() {
    try { localStorage.setItem(TYPE_FILTER_KEY, JSON.stringify(state.typeFilter)); } catch (e) {}
  }

  function eventTypeGroup(ev) {
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

  function typeFilterActive() {
    var f = state.typeFilter;
    return !!f && TYPE_GROUPS.some(function (g) { return f[g.id] === false; });
  }

  function eventMatchesTypeFilter(ev) {
    var f = state.typeFilter;
    return !f || f[eventTypeGroup(ev)] !== false;
  }

  // Client-side view of a day's forecast with the type filter applied.
  // Recomputes the derived fields map.js + timeline.js read (timeline,
  // peak bucket/value, per-event peak_intensity, avoid windows, transit
  // flags) exactly the way the pipeline builds them, so both modules
  // render the filtered view without changes. The day VERDICT is
  // deliberately NOT recomputed: a hidden concert still clogs the TTC,
  // so the chips filter what you browse, never what's modeled.
  function filteredForecast(forecast) {
    if (!forecast || !typeFilterActive()) return forecast;

    var events = (forecast.events || []).filter(eventMatchesTypeFilter);
    var keepIds = {};
    events.forEach(function (ev) { keepIds[ev.id || ''] = true; });

    // Re-sum the daily timeline from surviving events (mirrors
    // pipeline/timecurves.build_daily_timeline).
    var timeline = [];
    var b;
    for (b = 0; b < BUCKETS_PER_DAY; b++) timeline.push(0);
    events.forEach(function (ev) {
      var impact = ev.impact || 0;
      var curve = ev.time_curve || [];
      for (var i = 0; i < curve.length && i < BUCKETS_PER_DAY; i++) {
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
    var t2 = typeof t.T2 === 'number' ? t.T2 : 15;
    var t3 = typeof t.T3 === 'number' ? t.T3 : 30;
    if (peak < t1) return 'Quiet';
    if (peak < t2) return 'Moderate';
    if (peak < t3) return 'Busy';
    return 'Severe';
  }

  // The verdict shown for a day. Default: the server's full-model
  // verdict — a hidden concert still clogs the TTC. In 'filtered' mode
  // (opt-in toggle) the day re-buckets from only the visible events'
  // proxy_contribution (impact × time-of-day weight, shipped per event)
  // against the same thresholds the pipeline used. Falls back to raw
  // impact for pre-`proxy_contribution` day files.
  function displayVerdict(forecast) {
    if (!forecast) return '—';
    if (state.verdictMode !== 'filtered' || !typeFilterActive()) {
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

  function renderTypeFilter() {
    var host = document.getElementById('event-filter');
    if (!host) return;
    host.innerHTML = '';
    host.hidden = false;

    host.appendChild(el('span', 'event-filter__label', 'Show'));

    function rerender() {
      renderTypeFilter();
      renderForecastStrip();
      if (state.selectedDate) renderDetailForSelected();
    }

    TYPE_GROUPS.forEach(function (g) {
      var on = state.typeFilter[g.id] !== false;
      var chip = el('button', 'event-filter__chip', g.label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.setAttribute('data-group', g.id);
      chip.addEventListener('click', function () {
        state.typeFilter[g.id] = state.typeFilter[g.id] === false;
        saveTypeFilter();
        rerender();
      });
      host.appendChild(chip);
    });

    // Say what the verdict chips mean whenever the view and the full
    // model can diverge (any chip off).
    if (typeFilterActive()) {
      host.appendChild(el('span', 'event-filter__note',
        state.verdictMode === 'filtered'
          ? 'Verdicts reflect shown events only.'
          : 'Verdicts still reflect all modeled events.'));
    }

    // Right side: opt-in switch that re-buckets day verdicts from only
    // the visible events. Rendered even when no chip is off (the
    // preference persists) — it just has no visible effect until the
    // filter hides something.
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
      try { localStorage.setItem(VERDICT_MODE_KEY, state.verdictMode); } catch (e) {}
      rerender();
    });
    var toggleLabel = el('span', 'event-filter__toggle-label', 'Busyness from shown only');
    toggleWrap.appendChild(toggleLabel);
    toggleWrap.appendChild(toggle);
    host.appendChild(toggleWrap);
  }

  // ─────────── Forecast strip ───────────

  function renderEmptyEvents(filteredOut) {
    var wrap = el('div', 'day-card__empty');
    wrap.textContent = filteredOut
      ? 'No events match the filter.'
      : 'No major events scheduled.';
    return wrap;
  }

  function renderEventLine(ev, tz) {
    var line = el('div', 'day-card__event');

    var name = el('div', 'day-card__event-name', ev.name);
    line.appendChild(name);

    var meta = el('div', 'day-card__event-meta');
    var venue = el('span', 'day-card__event-venue', ev.venue_name);
    var sep   = el('span', 'day-card__event-sep', '·');
    var time  = el('span', 'day-card__event-time', friendlyTime(ev.start_local, tz));
    meta.appendChild(venue);
    meta.appendChild(sep);
    meta.appendChild(time);
    line.appendChild(meta);

    return line;
  }

  function renderDayCard(date, forecast, tz, index) {
    var verdictLabelText = displayVerdict(forecast);
    var card = el('article', 'day-card');
    card.setAttribute('data-date', date);
    card.setAttribute('data-verdict', verdictKey(verdictLabelText));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-pressed', state.selectedDate === date ? 'true' : 'false');
    if (state.selectedDate === date) card.setAttribute('data-selected', 'true');
    card.style.setProperty('--i', String(index));

    var header = el('header', 'day-card__header');
    var dateNode = el('time', 'day-card__date', friendlyDate(date, tz));
    dateNode.setAttribute('datetime', date);
    header.appendChild(dateNode);
    card.appendChild(header);

    var verdict = el('div', 'day-card__verdict');
    var verdictLabel = el('span', 'day-card__verdict-label', verdictLabelText);
    verdict.appendChild(verdictLabel);
    card.appendChild(verdict);

    var eventsWrap = el('div', 'day-card__events');
    // Card verdict above stays full-model; only the browsable event list
    // respects the type filter.
    var view = filteredForecast(forecast);
    var events = (view && view.events) || [];
    if (events.length === 0) {
      var rawCount = ((forecast && forecast.events) || []).length;
      eventsWrap.appendChild(renderEmptyEvents(rawCount > 0));
    } else {
      events.slice(0, 2).forEach(function (ev) {
        eventsWrap.appendChild(renderEventLine(ev, tz));
      });
      if (events.length > 2) {
        var more = el('div', 'day-card__more');
        more.textContent = '+' + (events.length - 2) + ' more';
        eventsWrap.appendChild(more);
      }
    }
    card.appendChild(eventsWrap);

    return card;
  }

  function renderForecastStrip() {
    var host = document.getElementById('forecast-strip');
    if (!host) return;
    host.innerHTML = '';

    var grid = el('div', 'forecast-strip__grid');
    var tz = state.cityConfig && state.cityConfig.timezone;

    state.days.forEach(function (date, i) {
      grid.appendChild(renderDayCard(date, state.forecasts[date], tz, i));
    });

    // Single delegated listener — picks up data-date off the clicked card
    // (no text parsing, no separate event channel — uses the M1 contract).
    grid.addEventListener('click', function (evt) {
      var card = evt.target && evt.target.closest && evt.target.closest('.day-card');
      if (!card) return;
      var d = card.getAttribute('data-date');
      if (d) selectDate(d);
    });
    grid.addEventListener('keydown', function (evt) {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      var card = evt.target && evt.target.closest && evt.target.closest('.day-card');
      if (!card) return;
      evt.preventDefault();
      var d = card.getAttribute('data-date');
      if (d) selectDate(d);
    });

    host.appendChild(grid);
  }

  // ─────────── Selected day ───────────

  function selectDate(date) {
    if (!date || !state.forecasts[date]) return;
    state.selectedDate = date;
    // Update card aria/data-selected flags without rebuilding the strip.
    var cards = document.querySelectorAll('.day-card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var match = c.getAttribute('data-date') === date;
      c.setAttribute('aria-pressed', match ? 'true' : 'false');
      if (match) c.setAttribute('data-selected', 'true');
      else c.removeAttribute('data-selected');
    }
    renderDetailForSelected();
  }

  // ─────────── Detail / map ───────────

  function ensureDetailScaffold() {
    // Build the detail panel's stable DOM exactly once. The Leaflet map
    // is bound to #map-canvas; tearing the host down on every day-change
    // would detach the map. We only update the header text + call
    // EFMap.setForecast / EFTimeline.setForecast / renderRail when the
    // selected day changes.
    var host = document.getElementById('forecast-detail');
    if (!host || host.dataset.scaffolded === 'true') return;
    host.innerHTML = '';

    var header = el('div', 'forecast-detail__header');
    var left = el('div');
    left.appendChild(el('div', 'forecast-detail__eyebrow', 'Where the crunch lands'));
    var title = el('div', 'forecast-detail__title');
    title.id = 'forecast-detail-title';
    left.appendChild(title);
    header.appendChild(left);
    host.appendChild(header);

    var mapHost = el('div', 'forecast-detail__map');
    mapHost.id = 'map-canvas';
    host.appendChild(mapHost);

    // Timeline host (M3). EFTimeline owns the canvas + scrubber.
    var timelineHost = el('div', 'forecast-detail__timeline');
    timelineHost.id = 'timeline-host';
    host.appendChild(timelineHost);

    // Rail host (M3). Lists events impacting the selected bucket;
    // M4 will populate the reserved transit slot inside each row.
    var railHost = el('section', 'forecast-detail__rail');
    railHost.id = 'rail-host';
    railHost.setAttribute('aria-label', 'Events impacting the selected time');
    host.appendChild(railHost);

    host.dataset.scaffolded = 'true';

    // Wire the timeline's scrubber to map + rail. The scrubber is the
    // single source of truth for state.selectedBucket.
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
    // Map, timeline, and rail all render the filtered view; the title's
    // verdict badge stays full-model (forecast.verdict below).
    var view = filteredForecast(forecast);

    var tz = state.cityConfig && state.cityConfig.timezone;
    var title = document.getElementById('forecast-detail-title');
    if (title) {
      title.textContent = '';
      title.appendChild(document.createTextNode(friendlyDate(date, tz)));
      var verdictBadge = el('span', 'forecast-detail__title-verdict', '· ' + displayVerdict(forecast));
      title.appendChild(verdictBadge);
    }

    var mapHost = document.getElementById('map-canvas');
    if (!window.EFMap || !window.L || !mapHost) {
      if (mapHost) mapHost.textContent = 'Map unavailable (Leaflet failed to load).';
      return;
    }

    var bbox = state.cityConfig && state.cityConfig.bbox;
    window.EFMap.ensureMap(mapHost, bbox, {
      defaultView: state.cityConfig && state.cityConfig.map_default_view
    });
    window.EFMap.invalidate();

    // Reset bucket selection to the new day's peak (M3 spec: "scrubber
    // resets to the new day's peak bucket"). The timeline owns the
    // visual reset; we just sync app state and the map.
    var newBucket = (typeof view.peak_bucket === 'number')
      ? view.peak_bucket : 0;
    state.selectedBucket = newBucket;

    // M4: hand the candidate transit-station set to the map BEFORE
    // setForecast so the day's bucket-flag index is built against the
    // current station collection. setStations is a no-op for the same
    // station list, but a city switch can shift it.
    if (window.EFMap.setStations) {
      window.EFMap.setStations(stationCollectionFromForecast(view));
    }

    // setForecast renders the heatmap at peak_bucket using peak_value
    // normalization. The scrubber will override via setBucket().
    window.EFMap.setForecast(view, state.cityConfig);

    if (window.EFTimeline) {
      window.EFTimeline.setForecast(view, state.cityConfig);
    }
    renderRail();
  }

  // Reduce the per-day forecast's transit_flags into a flat, deduped
  // station list for the map. Each station appears once even when
  // multiple events flag it; the per-bucket state is computed inside
  // the map module from avoid_windows + transit_flags.
  function stationCollectionFromForecast(forecast) {
    var tf = forecast && forecast.transit_flags;
    var evList = (tf && tf.events) || [];
    var byId = {};
    for (var i = 0; i < evList.length; i++) {
      var stations = evList[i].stations || [];
      for (var j = 0; j < stations.length; j++) {
        var s = stations[j];
        if (!byId[s.station_id]) {
          byId[s.station_id] = {
            station_id: s.station_id,
            station_name: s.station_name,
            lat: s.lat,
            lon: s.lon,
            lines: (s.lines || []).slice()
          };
        }
      }
    }
    var out = [];
    for (var k in byId) if (Object.prototype.hasOwnProperty.call(byId, k)) out.push(byId[k]);
    return out;
  }

  // ─────────── Detail rail ───────────

  function bucketToTimeLabel(bucket) {
    var b = Math.max(0, Math.min(BUCKETS_PER_DAY - 1, bucket || 0));
    var mins = b * BUCKET_MIN;
    var hh = Math.floor(mins / 60);
    var mm = mins % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(hh) + ':' + pad(mm);
  }

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

  // Categorize the event's presence at this bucket into a chip label.
  // Drives both copy ("Arrival underway" vs "Dispersing") and styling.
  function bucketPhaseLabel(ev, bucket, tz) {
    if (!ev) return { label: '', kind: 'during' };
    var startMin = isoMinutesOfDay(ev.start_local);
    var endMin   = isoMinutesOfDay(ev.end_local);
    var bucketMin = (bucket || 0) * BUCKET_MIN + BUCKET_MIN / 2;
    // Normalize to same-day cross-midnight: if event end_local's date
    // string differs from start_local, end straddles midnight relative
    // to the selected day. For phase labels we treat them as monotonic.
    var startDay = (ev.start_local || '').slice(0, 10);
    var endDay   = (ev.end_local   || '').slice(0, 10);
    var selDay   = state.selectedDate;
    if (startMin == null || endMin == null || !selDay) {
      return { label: 'During', kind: 'during' };
    }
    var startAbs = startMin + dayDelta(selDay, startDay) * 24 * 60;
    var endAbs   = endMin   + dayDelta(selDay, endDay)   * 24 * 60;
    if (bucketMin < startAbs) return { label: 'Arrival', kind: 'arrival' };
    if (bucketMin > endAbs)   return { label: 'Dispersal', kind: 'dispersal' };
    return { label: 'During event', kind: 'during' };
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

  function dayDelta(aIso, bIso) {
    if (!aIso || !bIso) return 0;
    var a = new Date(aIso + 'T00:00:00Z');
    var b = new Date(bIso + 'T00:00:00Z');
    return Math.round((b.getTime() - a.getTime()) / 86400000);
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
    var eyebrow = el('span', 'rail__eyebrow', 'Impacting at');
    var timeLabel = el('span', 'rail__time', bucketToTimeLabel(bucket));
    head.appendChild(eyebrow);
    head.appendChild(timeLabel);
    host.appendChild(head);

    if (!forecast) return;
    var entries = eventsForBucket(forecast, bucket);

    if (entries.length === 0) {
      var empty = el('div', 'rail__empty',
        'No major events drive the modeled crowd at this time.');
      host.appendChild(empty);
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

    // Top row: phase chip + event name
    var topRow = el('div', 'rail__row rail__row--top');
    var phase = bucketPhaseLabel(ev, bucket, tz);
    var chip = el('span', 'rail__phase rail__phase--' + phase.kind, phase.label);
    var name = el('span', 'rail__name', ev.name || '(untitled event)');
    topRow.appendChild(chip);
    topRow.appendChild(name);
    item.appendChild(topRow);

    // Meta row: venue · category · times
    var meta = el('div', 'rail__meta');
    var venue = el('span', 'rail__venue', ev.venue_name || '');
    var sep1 = el('span', 'rail__sep', '·');
    var cat = el('span', 'rail__category', humanCategory(ev.category));
    var sep2 = el('span', 'rail__sep', '·');
    var times = el('span', 'rail__times',
      friendlyTime(ev.start_local, tz) + ' – ' + friendlyTime(ev.end_local, tz));
    meta.appendChild(venue);
    meta.appendChild(sep1);
    meta.appendChild(cat);
    meta.appendChild(sep2);
    meta.appendChild(times);
    item.appendChild(meta);

    // Reserved transit slot. M3 reserved the box (min-height 36px) so
    // M4's populate-by-event pass doesn't shift the rail layout. We
    // build the eyebrow + populate fresh children here; the slot's
    // identity (data-transit-slot, data-event-id) is preserved so
    // anything that targets the slot by event id keeps working.
    var transit = el('div', 'rail__transit');
    transit.setAttribute('data-transit-slot', 'true');
    transit.setAttribute('data-event-id', ev.id || '');
    transit.appendChild(el('span', 'rail__transit-eyebrow', 'Transit'));
    populateRailTransitSlot(transit, ev, bucket, tz);
    item.appendChild(transit);

    return item;
  }

  // M4: populate the rail row's reserved transit slot with the modeled
  // stations + lines + window time text for this event. Replaces the
  // .rail__transit-placeholder child while leaving the eyebrow alone.
  function populateRailTransitSlot(slotEl, ev, bucket, tz) {
    // Drop any prior dynamic children (the eyebrow is the first child;
    // everything after is owned by this function).
    while (slotEl.children.length > 1) {
      slotEl.removeChild(slotEl.lastChild);
    }

    var date = state.selectedDate;
    var forecast = date && filteredForecast(state.forecasts[date]);
    if (!forecast) return;
    var tf = forecast.transit_flags;
    var transitEv = tf && tf.events
      ? tf.events.find(function (te) { return te.event_id === (ev.id || ''); })
      : null;

    if (!transitEv || !transitEv.stations || !transitEv.stations.length) {
      var empty = el('span', 'rail__transit-empty',
        'No major-transit stations within modeled range.');
      slotEl.appendChild(empty);
      return;
    }

    // 1. Summary row: station count + dedup'd line pills (across all
    //    nearby stations of this event).
    var summary = el('div', 'rail__transit-summary');
    var count = transitEv.stations.length;
    summary.appendChild(el('span', 'rail__transit-count',
      count + (count === 1 ? ' station' : ' stations')));

    var linesSet = {};
    var linesOrdered = [];
    transitEv.stations.forEach(function (s) {
      (s.lines || []).forEach(function (line) {
        if (!linesSet[line]) {
          linesSet[line] = true;
          linesOrdered.push(line);
        }
      });
    });
    if (linesOrdered.length) {
      summary.appendChild(el('span', 'rail__sep', '·'));
      var linesWrap = el('span', 'rail__transit-lines');
      // Cap at 8 to avoid wrapping the row; the popup carries the full
      // set for any one station.
      linesOrdered.slice(0, 8).forEach(function (line) {
        linesWrap.appendChild(el('span', 'rail__transit-line', line));
      });
      if (linesOrdered.length > 8) {
        linesWrap.appendChild(el('span', 'rail__transit-line', '+' + (linesOrdered.length - 8)));
      }
      summary.appendChild(linesWrap);
    }
    slotEl.appendChild(summary);

    // 2. Window time row: arrival / dispersal windows for THIS event,
    //    pulled from the same forecast.avoid_windows the timeline reads.
    //    Highlight whichever window the current bucket is inside so the
    //    scrubber's effect is visible row-by-row.
    var windowsForEvent = (forecast.avoid_windows || []).filter(function (w) {
      return w.event_id === (ev.id || '');
    });
    if (windowsForEvent.length) {
      var winsRow = el('div', 'rail__transit-windows');
      windowsForEvent.forEach(function (w) {
        var inWindow = (typeof bucket === 'number') &&
          bucket >= Math.floor(w.from_bucket) &&
          bucket <  Math.ceil(w.to_bucket);
        var span = el('span', 'rail__transit-window rail__transit-window--' + w.kind +
          (inWindow ? ' rail__transit-window-active' : ''));
        var label = (w.kind === 'arrival' ? 'Arrival' : 'Dispersal') + ' ' +
          minuteRangeLabel(w.from_minute, w.to_minute);
        span.textContent = label;
        winsRow.appendChild(span);
      });
      slotEl.appendChild(winsRow);
    }

    // 3. Modeled-not-measured fine print, every row, every event.
    slotEl.appendChild(el('span', 'rail__transit-fine',
      'Modeled load from proximity + dispersal timing — not measured.'));
  }

  function minuteRangeLabel(fromMin, toMin) {
    return minuteToHHMM(fromMin) + '–' + minuteToHHMM(toMin);
  }

  function minuteToHHMM(min) {
    if (typeof min !== 'number') return '';
    // Clip to [0, 1440] for display — windows are pre-intersected with
    // the displayed day server-side, but a negative or >=1440 sneak-in
    // would render as gibberish.
    var m = Math.max(0, Math.min(24 * 60, Math.round(min)));
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(hh) + ':' + pad(mm);
  }

  function humanCategory(cat) {
    switch ((cat || '').toLowerCase()) {
      case 'major_concert':   return 'Concert';
      case 'arena_sports':    return 'Sports';
      case 'performing_arts': return 'Performing arts';
      case 'comedy':          return 'Comedy';
      case 'festival':        return 'Festival';
      case 'family_other':    return 'Family / other';
      default:                return cat || '—';
    }
  }

  function renderEmptyState(message) {
    var host = document.getElementById('forecast-strip');
    if (!host) return;
    host.innerHTML = '';
    var empty = el('div', 'forecast-strip__empty', message);
    host.appendChild(empty);
  }

  // ─────────── M6: status banner + designed empty / stale states ───────────

  // Compose a friendly absolute timestamp ("yesterday at 4:12 PM") in
  // the city's timezone. Falls back to the raw ISO string on parser
  // failure so the operator can still see when the last refresh was.
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

  // Banner copy is intentionally explicit about WHY the data is stale
  // and WHEN it was last good. "Cache" is the lever the operator can
  // pull — telling them so prevents an unnecessary support ticket.
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
        ' days. Map + rail still render the last-known stations and lines.';
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

  // The forecast strip + map both need a "no whitelisted events" empty
  // state. Routed through one copy line so the two messages stay
  // synonymous.
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

  function pickInitialDate() {
    // Prefer the first day that actually has events; fall back to the
    // first day available so the map always renders something.
    for (var i = 0; i < state.days.length; i++) {
      var d = state.days[i];
      var f = state.forecasts[d];
      if (f && f.events && f.events.length > 0) return d;
    }
    return state.days[0] || null;
  }

  function loadCurrentCity() {
    var cityId = state.currentCityId;
    return fetchJson('api/city.php?id=' + encodeURIComponent(cityId)).then(function (resp) {
      state.cityConfig = resp.city;
      state.freshness = resp.freshness || null;
      // The map attribution and per-city GTFS attribution may also come
      // through here. Fall back to what /api/cities.php already loaded
      // if either field is absent (older deploys, missing endpoint).
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
