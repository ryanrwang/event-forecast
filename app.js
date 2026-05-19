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

  var state = {
    cities: [],
    currentCityId: null,
    cityConfig: null,
    days: [],
    forecasts: {},
    selectedDate: null
  };

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

  // ─────────── Forecast strip ───────────

  function renderEmptyEvents() {
    var wrap = el('div', 'day-card__empty');
    wrap.textContent = 'No major events scheduled.';
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
    var card = el('article', 'day-card');
    card.setAttribute('data-date', date);
    card.setAttribute('data-verdict', verdictKey(forecast && forecast.verdict));
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
    var verdictLabel = el('span', 'day-card__verdict-label', (forecast && forecast.verdict) || '—');
    verdict.appendChild(verdictLabel);
    card.appendChild(verdict);

    var eventsWrap = el('div', 'day-card__events');
    var events = (forecast && forecast.events) || [];
    if (events.length === 0) {
      eventsWrap.appendChild(renderEmptyEvents());
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
    // EFMap.setForecast when the selected day changes.
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

    host.dataset.scaffolded = 'true';
  }

  function renderDetailForSelected() {
    ensureDetailScaffold();
    var date = state.selectedDate;
    var forecast = date && state.forecasts[date];
    if (!forecast) return;

    var tz = state.cityConfig && state.cityConfig.timezone;
    var title = document.getElementById('forecast-detail-title');
    if (title) {
      title.textContent = friendlyDate(date, tz);
      var verdictBadge = el('span', 'forecast-detail__title-verdict', '· ' + (forecast.verdict || '—'));
      title.appendChild(verdictBadge);
    }

    var mapHost = document.getElementById('map-canvas');
    if (!window.EFMap || !window.L || !mapHost) {
      if (mapHost) mapHost.textContent = 'Map unavailable (Leaflet failed to load).';
      return;
    }

    var bbox = state.cityConfig && state.cityConfig.bbox;
    window.EFMap.ensureMap(mapHost, bbox);
    window.EFMap.invalidate();
    window.EFMap.setForecast(forecast, state.cityConfig);
  }

  function renderEmptyState(message) {
    var host = document.getElementById('forecast-strip');
    if (!host) return;
    host.innerHTML = '';
    var empty = el('div', 'forecast-strip__empty', message);
    host.appendChild(empty);
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
      state.days = (resp.days || []).slice(0, 7);
      if (state.days.length === 0) {
        renderEmptyState('No forecast days available for ' + (state.cityConfig.name || cityId) + ' yet.');
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

      if (state.cities.length === 0) {
        renderEmptyState('No cities configured.');
        return;
      }

      state.currentCityId = state.cities[0].id;
      renderCitySelector(state.cities, state.currentCityId);
      return loadCurrentCity();
    }).catch(function (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      renderEmptyState('Forecast unavailable. Check that the API is reachable.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
