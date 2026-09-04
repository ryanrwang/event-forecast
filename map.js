/*
 * Event Forecast — Map module.
 *
 * Vanilla JS, no framework, no build step. Leaflet 1.9 is loaded
 * separately by index.html. This file owns:
 *
 *   • The Leaflet map instance (initial fit to the city bbox, OSM dark
 *     basemap, attribution).
 *   • A custom L.Layer canvas overlay that renders the modeled crowd
 *     heat field for the day's peak bucket. Heat is summed on the client
 *     from per-event venue intensities + per-event sigmas shipped in
 *     forecast.json.
 *   • Event markers sized by impact, with popups linking to Ticketmaster.
 *   • A persistent legend declaring the heatmap is a modeled estimate.
 *
 * Reads the selected city's bbox + timezone from the cityConfig the app
 * already loads; no hardcoded city anywhere.
 */
(function () {
  'use strict';

  // ─────────── Constants (modeling-spec locked, do not retune here) ───────────

  // Heat field is sampled on a roughly 75m grid (M2 modeling spec).
  // We draw onto a downsampled canvas (one canvas pixel = ~75m) and CSS-
  // scale it up; this keeps the per-day redraw cheap and the falloff
  // visually soft without leaning on browser filters.
  var HEAT_CELL_METERS = 75;
  // Truncate the Gaussian beyond 3σ — contributions are negligible there.
  var SIGMA_TRUNCATE = 3.0;
  // Where the legend buckets the normalized heat. 0..0.25 maps to stop 0,
  // etc. Values are linearly interpolated between stops on render.
  var HEAT_STOPS_T = [0.0, 0.25, 0.5, 0.75, 1.0];

  // Marker size scales with impact. Spec wants visible separation between
  // a 50k-cap stadium event and a 2k-cap theatre event; these radii hit
  // that without crowding the map.
  var MARKER_MIN_PX = 8;
  var MARKER_MAX_PX = 30;
  var MARKER_IMPACT_LOW = 2;     // ~theatre
  var MARKER_IMPACT_HIGH = 60;   // ~major stadium concert

  // OSM dark basemap (CARTO's dark-matter tiles, OSM-derived; the
  // attribution string below carries the required OSM credit).
  //
  // CARTO gates basemaps.cartocdn.com behind an API key. Keyless requests
  // still return tiles, but stamped with a repeating "API KEY REQUIRED"
  // watermark. Keys are free within CARTO's fair-use limit:
  // https://carto.com/basemaps/apikey
  //
  // The key is deliberately NOT stored in this file. It lives in
  // api/config.php (gitignored) and reaches us as
  // ensureMap(..., { basemapKey: ... }). It still ships to every visitor
  // -- the browser fetches tiles from CARTO directly, so it can never be
  // a secret -- but keeping it server-side keeps it out of the public git
  // repo and away from the scrapers that crawl public repos for keys.
  // (CARTO asks which domain you'll use it on when issuing the key, but
  // documents no enforced domain/referrer restriction, so the repo is the
  // only exposure we can actually control.) With no key configured we
  // fall back to the keyless URL, so the map still loads (watermarked)
  // rather than breaking.
  var TILE_URL_KEYLESS =
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

  function tileUrl(basemapKey) {
    var key = typeof basemapKey === 'string' ? basemapKey.trim() : '';
    return key
      ? TILE_URL_KEYLESS + '?key=' + encodeURIComponent(key)
      : TILE_URL_KEYLESS;
  }

  var TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  // ─────────── Module-private state ───────────

  var _map = null;
  var _basemap = null;
  var _heatLayer = null;
  var _markerLayer = null;
  var _stationLayer = null;
  var _legendControl = null;
  var _currentForecast = null;
  // Bucket the heatmap is currently rendered for. Mirrors app state's
  // selectedBucket; the map owns this only as a cache so a Leaflet
  // moveend/zoomend redraw uses the right curve sample.
  var _currentBucket = null;

  // M4 transit-station bookkeeping. Kept on the map module so setBucket
  // can update marker states in O(stations) without re-creating markers.
  //   _stations             — last setStations() input, by station_id.
  //   _stationMarkers       — station_id → { marker, el } (el lazily
  //                            resolved once the marker is in the DOM).
  //   _bucketFlags          — per-bucket Map<station_id, FlagInfo> built
  //                            once on setForecast; FlagInfo carries the
  //                            kinds (Set of "arrival"|"dispersal") and
  //                            the count of distinct events flagging it.
  //   _stationEventIndex    — station_id → Set<event_id> for the rail's
  //                            "events impacting this station" cross-ref.
  var _stations = {};
  var _stationMarkers = {};
  var _bucketFlags = null;
  var _stationEventIndex = {};
  // M6: map-level transit empty-state notice. Renders only when a day
  // has zero flagged stations across all whitelisted events (i.e.
  // transit_flags.events is empty). Distinct from "GTFS hasn't run" —
  // that's an entirely missing station collection. Kept on the map
  // module so setForecast can toggle it without app-level plumbing.
  var _transitNoticeControl = null;

  // ─────────── Utilities ───────────

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

  // Parse "#RRGGBB" into [r,g,b]. Tolerates shorthand "#RGB".
  function hexToRgb(hex) {
    if (!hex) return [0, 0, 0];
    var h = hex.replace('#', '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    var n = parseInt(h, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // Build the active 5-stop heat ramp from semantic tokens at draw time
  // (so a future light-mode flip picks up the override automatically).
  function buildHeatRamp() {
    var stops = [
      hexToRgb(tokenColor('color.heatmap.s0', '#0EA5A5')),
      hexToRgb(tokenColor('color.heatmap.s1', '#22C55E')),
      hexToRgb(tokenColor('color.heatmap.s2', '#EAB308')),
      hexToRgb(tokenColor('color.heatmap.s3', '#F97316')),
      hexToRgb(tokenColor('color.heatmap.s4', '#EF4444'))
    ];
    return stops;
  }

  function colorAt(t, ramp) {
    // t in [0, 1]. Below 0 = transparent; we'll handle alpha at the caller.
    if (t <= 0) return [ramp[0][0], ramp[0][1], ramp[0][2]];
    if (t >= 1) return [ramp[4][0], ramp[4][1], ramp[4][2]];
    // Find segment.
    var seg = Math.floor(t / 0.25);
    if (seg > 3) seg = 3;
    var local = (t - HEAT_STOPS_T[seg]) / (HEAT_STOPS_T[seg + 1] - HEAT_STOPS_T[seg]);
    var a = ramp[seg];
    var b = ramp[seg + 1];
    return [
      Math.round(lerp(a[0], b[0], local)),
      Math.round(lerp(a[1], b[1], local)),
      Math.round(lerp(a[2], b[2], local))
    ];
  }

  // ─────────── Heat overlay (custom L.Layer) ───────────
  //
  // We could have shipped a precomputed heat grid from Python, but the
  // M2 spec lets us sum per-event Gaussians on the client. That keeps
  // forecast.json compact AND makes M3's scrubber trivial (just pick a
  // different bucket and re-sum). The canvas covers the map pane and is
  // redrawn on every zoom/move.

  function makeHeatLayer() {
    var Layer = L.Layer.extend({
      onAdd: function (map) {
        this._map = map;
        var size = map.getSize();
        var canvas = L.DomUtil.create('canvas', 'ef-heat-canvas');
        canvas.width = size.x;
        canvas.height = size.y;
        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.pointerEvents = 'none';
        // Below markerPane so popups + markers stay clickable above.
        map.getPanes().overlayPane.appendChild(canvas);
        this._canvas = canvas;

        map.on('moveend zoomend resize viewreset', this._redraw, this);
        // Keep canvas pinned to top-left of overlayPane during moves.
        map.on('move', this._reposition, this);
        this._redraw();
      },

      onRemove: function (map) {
        map.off('moveend zoomend resize viewreset', this._redraw, this);
        map.off('move', this._reposition, this);
        if (this._canvas && this._canvas.parentNode) {
          this._canvas.parentNode.removeChild(this._canvas);
        }
        this._canvas = null;
        this._map = null;
      },

      setData: function (events, peakValue) {
        // Each entry must carry: lat, lon, sigma_m, and either
        // `intensity` (current-bucket value, set by the scrubber) or
        // `peak_intensity` (legacy day-peak fallback).
        var src = (events || []).filter(function (e) {
          var i = typeof e.intensity === 'number' ? e.intensity : e.peak_intensity;
          return e && typeof e.lat === 'number' && typeof e.lon === 'number' &&
                 typeof i === 'number' && i > 0 &&
                 typeof e.sigma_m === 'number' && e.sigma_m > 0;
        });
        // Normalize the working shape so _redraw doesn't care which key
        // the caller used — the splat reads `_drawIntensity` only.
        this._events = src.map(function (e) {
          return {
            lat: e.lat,
            lon: e.lon,
            sigma_m: e.sigma_m,
            _drawIntensity: typeof e.intensity === 'number' ? e.intensity : e.peak_intensity
          };
        });
        // Absolute scale (the Severe threshold, see heatScaleFor). The
        // heat dims and brightens as the scrubber moves AND stays
        // comparable across days. Falls back to grid max only if missing.
        this._normMax = (typeof peakValue === 'number' && peakValue > 0)
          ? peakValue : null;
        this._redraw();
      },

      _reposition: function () {
        if (!this._canvas || !this._map) return;
        var topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
      },

      _redraw: function () {
        if (!this._canvas || !this._map) return;
        var map = this._map;
        var size = map.getSize();
        this._canvas.width = size.x;
        this._canvas.height = size.y;
        this._reposition();

        var ctx = this._canvas.getContext('2d');
        ctx.clearRect(0, 0, size.x, size.y);

        var events = this._events || [];
        if (events.length === 0) return;

        // Pixels per meter at the map's current zoom + center latitude.
        // This is a local linearization that's fine at city scale.
        var center = map.getCenter();
        var p1 = map.project(center, map.getZoom());
        var oneMeterEast = L.latLng(
          center.lat,
          center.lng + (1 / 111320 / Math.cos(center.lat * Math.PI / 180))
        );
        var p2 = map.project(oneMeterEast, map.getZoom());
        var pxPerMeter = Math.abs(p2.x - p1.x); // px per meter

        // Heat canvas is downsampled to a ~75m grid. We accumulate floats
        // into a typed array, then map → colors once.
        var cellPx = Math.max(2, Math.round(HEAT_CELL_METERS * pxPerMeter));
        var gw = Math.max(1, Math.ceil(size.x / cellPx));
        var gh = Math.max(1, Math.ceil(size.y / cellPx));
        var grid = new Float32Array(gw * gh);

        // Per-event Gaussian splat onto the grid.
        for (var i = 0; i < events.length; i++) {
          var e = events[i];
          var pt = map.latLngToContainerPoint([e.lat, e.lon]);
          var cx = pt.x / cellPx;
          var cy = pt.y / cellPx;
          var sigmaCells = (e.sigma_m * pxPerMeter) / cellPx;
          if (sigmaCells <= 0) continue;
          var r = sigmaCells * SIGMA_TRUNCATE;
          var x0 = Math.max(0, Math.floor(cx - r));
          var x1 = Math.min(gw - 1, Math.ceil(cx + r));
          var y0 = Math.max(0, Math.floor(cy - r));
          var y1 = Math.min(gh - 1, Math.ceil(cy + r));
          var inv2s2 = 1.0 / (2.0 * sigmaCells * sigmaCells);
          var intensity = e._drawIntensity;
          for (var y = y0; y <= y1; y++) {
            for (var x = x0; x <= x1; x++) {
              var dx = x - cx;
              var dy = y - cy;
              var d2 = dx * dx + dy * dy;
              grid[y * gw + x] += intensity * Math.exp(-d2 * inv2s2);
            }
          }
        }

        // Normalize against the day's absolute peak_value (timeline max)
        // so scrubbing visibly dims and brightens. The grid's peak-bucket
        // max ≈ peak_value when the dominant venue dominates, which
        // anchors t≈1 at the brightest pixel of the peak bucket. Falls
        // back to the per-redraw grid max if peak_value wasn't supplied.
        var maxV = this._normMax;
        if (!(maxV > 0)) {
          maxV = 0;
          for (var k = 0; k < grid.length; k++) if (grid[k] > maxV) maxV = grid[k];
        }
        if (maxV <= 0) return;

        var ramp = buildHeatRamp();

        // Render to a small ImageData matching the grid, then blit
        // upscaled (smooth interpolation = soft falloff for free).
        var img = ctx.createImageData(gw, gh);
        for (var j = 0; j < grid.length; j++) {
          var v = grid[j] / maxV;
          if (v < 0.03) continue;  // skip the long tail — keeps the blob honest-sized
          var t = clamp(v, 0, 1);
          var rgb = colorAt(t, ramp);
          // Alpha ramps with intensity so the basemap stays readable
          // under the cool/low end of the field.
          var alpha = Math.round(clamp(30 + t * 180, 30, 210));
          var idx = j * 4;
          img.data[idx]     = rgb[0];
          img.data[idx + 1] = rgb[1];
          img.data[idx + 2] = rgb[2];
          img.data[idx + 3] = alpha;
        }

        // Draw downsampled, then upscale to canvas.
        var tmp = document.createElement('canvas');
        tmp.width = gw; tmp.height = gh;
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.globalAlpha = 0.85;
        ctx.drawImage(tmp, 0, 0, gw, gh, 0, 0, size.x, size.y);
        ctx.globalAlpha = 1.0;
      }
    });

    return new Layer();
  }

  // ─────────── Markers ───────────

  function markerRadius(impact) {
    var safe = isFinite(impact) ? impact : 0;
    var t = (safe - MARKER_IMPACT_LOW) / (MARKER_IMPACT_HIGH - MARKER_IMPACT_LOW);
    t = clamp(t, 0, 1);
    // Sqrt scaling so visual AREA tracks impact roughly linearly — a
    // big stadium event looks meaningfully larger than a theatre event
    // without dwarfing it past usability.
    var r = MARKER_MIN_PX + (MARKER_MAX_PX - MARKER_MIN_PX) * Math.sqrt(t);
    return r;
  }

  function verdictBandColor(verdict) {
    var key = (verdict || '').toLowerCase();
    if (key === 'quiet')    return tokenColor('color.verdict.quiet', '#22C55E');
    if (key === 'moderate') return tokenColor('color.verdict.moderate', '#EAB308');
    if (key === 'busy')     return tokenColor('color.verdict.busy', '#F97316');
    if (key === 'severe')   return tokenColor('color.verdict.severe', '#EF4444');
    return tokenColor('color.text.accent', '#34D399');
  }

  function fmtTime(iso, tz) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var opts = { hour: 'numeric', minute: '2-digit' };
    if (tz) opts.timeZone = tz;
    try { return new Intl.DateTimeFormat('en-US', opts).format(d); }
    catch (_) { return ''; }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildPopupHtml(ev, tz) {
    var time = fmtTime(ev.start_local, tz);
    var name = escapeHtml(ev.name || '(untitled event)');
    var venue = escapeHtml(ev.venue_name || '');
    var html =
      '<div class="ef-popup">' +
        '<div class="ef-popup__name">' + name + '</div>' +
        '<div class="ef-popup__meta">' +
          '<span class="ef-popup__venue">' + venue + '</span>' +
          (time ? '<span class="ef-popup__sep">·</span>' +
                  '<span class="ef-popup__time">' + escapeHtml(time) + '</span>' : '') +
        '</div>';
    if (ev.ticketmaster_url) {
      html +=
        '<a class="ef-popup__link" href="' + escapeHtml(ev.ticketmaster_url) +
        '" target="_blank" rel="noopener noreferrer">Tickets on Ticketmaster</a>' +
        '<div class="ef-popup__attribution">Event powered by Ticketmaster.</div>';
    }
    html += '</div>';
    return html;
  }

  function renderMarkers(events, tz, verdict) {
    if (!_markerLayer) return;
    _markerLayer.clearLayers();
    if (!events || events.length === 0) return;
    var stroke = verdictBandColor(verdict);
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (typeof ev.lat !== 'number' || typeof ev.lon !== 'number') continue;
      var r = markerRadius(ev.impact || 0);
      var marker = L.circleMarker([ev.lat, ev.lon], {
        radius: r,
        color: stroke,
        weight: 1.5,
        opacity: 0.95,
        fillColor: stroke,
        fillOpacity: 0.25,
        className: 'ef-marker'
      });
      marker.bindPopup(buildPopupHtml(ev, tz), {
        className: 'ef-popup-wrap',
        closeButton: true,
        autoPan: true
      });
      marker.addTo(_markerLayer);
    }
  }

  // ─────────── Legend ───────────

  function _legendStationGlyph(stateName, label) {
    var item = el('span', 'ef-legend__station');
    var dot = el('span', 'ef-legend__station-dot');
    // Re-use the same data-state attribute as live markers so a token
    // tweak propagates to the legend without a second styling pass.
    dot.setAttribute('data-state', stateName === 'multi' ? 'multi' : 'single');
    if (stateName === 'dispersal') dot.setAttribute('data-kind', 'dispersal');
    else if (stateName === 'arrival') dot.setAttribute('data-kind', 'arrival');
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    return item;
  }

  function buildLegendControl() {
    var Ctl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        // One line: [ramp] Quiet → Severe · In / Out / Several · modeled.
        // The long wording moved into the tooltip; the footer and the
        // timeline carry the "modeled, not measured" line in full.
        var wrap = el('div', 'ef-legend');
        wrap.setAttribute('role', 'note');
        wrap.title =
          'Same colour scale every day: crowd modeled from event size, ' +
          'start time, and distance. Stations flagged from venue proximity ' +
          'and event timing. Not live crowd or transit data.';

        var heat = el('span', 'ef-legend__heat');
        heat.appendChild(el('span', 'ef-legend__end', 'Quiet'));
        var ramp = el('span', 'ef-legend__ramp');
        ramp.setAttribute('aria-hidden', 'true');
        for (var i = 0; i < 5; i++) {
          var stop = el('span', 'ef-legend__stop');
          stop.style.background = tokenColor('color.heatmap.s' + i, '#22C55E');
          ramp.appendChild(stop);
        }
        heat.appendChild(ramp);
        heat.appendChild(el('span', 'ef-legend__end', 'Severe'));
        wrap.appendChild(heat);

        // M4: transit-station glyphs — arrival (info hue), dispersal
        // (warning hue), multi-event (severe accent).
        var stationsRow = el('span', 'ef-legend__stations');
        stationsRow.appendChild(_legendStationGlyph('arrival',   'In'));
        stationsRow.appendChild(_legendStationGlyph('dispersal', 'Out'));
        stationsRow.appendChild(_legendStationGlyph('multi',     'Several'));
        wrap.appendChild(stationsRow);

        wrap.appendChild(el('span', 'ef-legend__note', 'Modeled, not measured'));

        // Block map drag/scroll while interacting with the legend.
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        return wrap;
      }
    });
    return new Ctl();
  }

  // ─────────── Stations (M4) ───────────
  //
  // Stations are L.marker entries with L.divIcon, in a dedicated
  // layerGroup. Each marker carries a stable DOM div whose data-state
  // attribute the scrubber re-paints via CSS — no marker re-creation per
  // tick. Three states: "dormant" (in candidate set, not currently
  // flagged), "single" (one event has it inside its avoid window),
  // "multi" (two or more). The "single" state's tint is further split
  // arrival vs dispersal via data-kind.

  function kindLabel(kind) {
    if (kind === 'go') return 'GO';
    if (kind === 'streetcar') return 'Streetcar';
    return 'Subway';
  }

  function buildStationIcon(station) {
    var kind = (station && station.kind) || 'subway';
    return L.divIcon({
      className: 'ef-station-marker',
      html:
        '<span class="ef-station-marker__dot" data-state="dormant" data-transit="' +
        escapeHtml(kind) + '" aria-hidden="true"></span>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function buildStationPopupHtml(station) {
    var lines = (station.lines || []);
    var linesHtml = lines.length
      ? '<span class="ef-popup__lines">' +
          lines.map(function (l, i) {
            var c = station.lineColors && station.lineColors[i];
            var t = station.lineText && station.lineText[i];
            var style = c
              ? ' style="background:' + escapeHtml(c) + ';border-color:' + escapeHtml(c) +
                (t ? ';color:' + escapeHtml(t) : '') + '"'
              : '';
            return '<span class="ef-popup__line"' + style + '>' + escapeHtml(l) + '</span>';
          }).join('') +
        '</span>'
      : '<span class="ef-popup__lines-empty">No lines listed</span>';
    return (
      '<div class="ef-popup ef-popup--station">' +
        '<div class="ef-popup__name">' + escapeHtml(station.station_name || 'Station') + '</div>' +
        '<div class="ef-popup__meta">' +
          '<span class="ef-popup__eyebrow">' + escapeHtml(kindLabel(station.kind)) + '</span>' +
          '<span class="ef-popup__sep">·</span>' +
          linesHtml +
        '</div>' +
        '<div class="ef-popup__fine">Flagged while nearby crowds are heading in or letting out. Modeled, not measured.</div>' +
      '</div>'
    );
  }

  function setStations(stations) {
    if (!_map || !_stationLayer) return;
    _stationLayer.clearLayers();
    _stations = {};
    _stationMarkers = {};
    if (!stations || !stations.length) return;

    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') continue;
      _stations[s.station_id] = s;
      var marker = L.marker([s.lat, s.lon], {
        icon: buildStationIcon(s),
        // Make sure stations float above events without intercepting
        // every map click — popups still open via the marker itself.
        zIndexOffset: 600,
        keyboard: false,
        riseOnHover: true
      });
      marker.bindPopup(buildStationPopupHtml(s), {
        className: 'ef-popup-wrap ef-popup-wrap--station',
        closeButton: true,
        autoPan: true,
        offset: L.point(0, -4)
      });
      marker.addTo(_stationLayer);
      _stationMarkers[s.station_id] = { marker: marker, station: s, el: null };
    }
  }

  // Resolve the dot child for a given station id, caching it. Leaflet
  // creates the icon's DOM lazily on first render; the cache avoids a
  // querySelector per scrub tick.
  function stationDotEl(stationId) {
    var entry = _stationMarkers[stationId];
    if (!entry) return null;
    if (entry.el && entry.el.isConnected) return entry.el;
    var iconEl = entry.marker.getElement();
    if (!iconEl) return null;
    entry.el = iconEl.querySelector('.ef-station-marker__dot');
    return entry.el;
  }

  // Build per-bucket flag index from avoid_windows + transit_flags.
  // _bucketFlags[b] = Map<station_id, {kinds:Set, eventCount:number}>.
  function buildBucketFlags(forecast) {
    var byEvent = {};
    var tf = forecast && forecast.transit_flags;
    var tfEvents = (tf && tf.events) || [];
    for (var i = 0; i < tfEvents.length; i++) {
      byEvent[tfEvents[i].event_id] = tfEvents[i].stations || [];
    }
    _stationEventIndex = {};
    // Bucket count comes from the day file (a modeled day is 26 hours =
    // 104 buckets; older files carry 96).
    var BUCKETS = Math.max(96, (forecast && forecast.timeline && forecast.timeline.length) || 0);
    var flags = new Array(BUCKETS);
    var windows = (forecast && forecast.avoid_windows) || [];
    for (var w = 0; w < windows.length; w++) {
      var win = windows[w];
      var stations = byEvent[win.event_id];
      if (!stations || !stations.length) continue;
      var from = Math.max(0, Math.floor(win.from_bucket));
      var to   = Math.min(BUCKETS, Math.ceil(win.to_bucket));
      for (var b = from; b < to; b++) {
        var bucketMap = flags[b];
        if (!bucketMap) { bucketMap = new Map(); flags[b] = bucketMap; }
        for (var s = 0; s < stations.length; s++) {
          var sid = stations[s].station_id;
          var rec = bucketMap.get(sid);
          if (!rec) {
            rec = { kinds: new Set(), events: new Set() };
            bucketMap.set(sid, rec);
          }
          rec.kinds.add(win.kind);
          rec.events.add(win.event_id);
        }
      }
      // Maintain the static (day-level) station→events index too — used by
      // the rail to list which events flag each station, independent of
      // current bucket.
      for (var s2 = 0; s2 < stations.length; s2++) {
        var sid2 = stations[s2].station_id;
        var set = _stationEventIndex[sid2];
        if (!set) { set = new Set(); _stationEventIndex[sid2] = set; }
        set.add(win.event_id);
      }
    }
    _bucketFlags = flags;
  }

  function applyStationStatesForBucket(bucket) {
    var ids = Object.keys(_stationMarkers);
    if (!ids.length) return;
    var bucketMap = (_bucketFlags && typeof bucket === 'number') ? _bucketFlags[bucket] : null;
    for (var i = 0; i < ids.length; i++) {
      var sid = ids[i];
      var dot = stationDotEl(sid);
      if (!dot) continue;
      var rec = bucketMap ? bucketMap.get(sid) : null;
      if (!rec) {
        dot.setAttribute('data-state', 'dormant');
        dot.removeAttribute('data-kind');
        continue;
      }
      var eventCount = rec.events.size;
      dot.setAttribute('data-state', eventCount >= 2 ? 'multi' : 'single');
      // Multi-kind = both arrival AND dispersal active right now.
      // Single-kind = either, used as a hue swap. The map module never
      // claims one kind is "more" than the other — just visually distinct.
      var kind = rec.kinds.size > 1
        ? 'both'
        : (rec.kinds.has('dispersal') ? 'dispersal' : 'arrival');
      dot.setAttribute('data-kind', kind);
    }
  }

  // Public hook for the rail: at bucket B, which events flag station S
  // (or null if none). Returns the kinds set as well for label copy.
  function stationFlagsAtBucket(stationId, bucket) {
    if (!_bucketFlags || typeof bucket !== 'number') return null;
    var bucketMap = _bucketFlags[bucket];
    if (!bucketMap) return null;
    return bucketMap.get(stationId) || null;
  }

  // ─────────── Public API ───────────

  function ensureMap(hostEl, bbox, options) {
    if (_map) return _map;
    if (!hostEl) return null;
    options = options || {};

    _map = L.map(hostEl, {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: false,
      // Keep the user inside the city. A 0.5° pad lets them roam a bit
      // without losing the basemap entirely.
      maxBounds: bbox ? [
        [bbox[1] - 0.5, bbox[0] - 0.5],
        [bbox[3] + 0.5, bbox[2] + 0.5]
      ] : null,
      maxBoundsViscosity: 0.6
    });

    _basemap = L.tileLayer(tileUrl(options.basemapKey), {
      attribution: TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 19,
      detectRetina: true
    }).addTo(_map);

    _heatLayer = makeHeatLayer().addTo(_map);
    _markerLayer = L.layerGroup().addTo(_map);
    // Stations sit ABOVE the heat canvas (which lives in overlayPane)
    // and ABOVE the event markers — so a flagged subway station reads
    // clearly even on a saturated red Severe day. Toggling visibility +
    // updating per-bucket state stays a layerGroup operation, never
    // touches the heat or event-marker layers.
    _stationLayer = L.layerGroup().addTo(_map);
    _legendControl = buildLegendControl().addTo(_map);

    // Initial view: prefer the city config's map_default_view (e.g.
    // Toronto opens on the downtown core where most whitelisted venues
    // cluster — a full-bbox fit renders them as one clump). Fall back
    // to fitting the whole bbox for cities without a configured view.
    var dv = options.defaultView;
    if (dv && typeof dv.lat === 'number' && typeof dv.lon === 'number') {
      _map.setView([dv.lat, dv.lon], typeof dv.zoom === 'number' ? dv.zoom : 12);
    } else if (bbox && bbox.length === 4) {
      _map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [16, 16] });
    } else if (options.fallbackCenter) {
      _map.setView(options.fallbackCenter, 11);
    } else {
      _map.setView([0, 0], 2);
    }

    // Recompute heat after Leaflet finishes its initial fit animation.
    setTimeout(function () { if (_heatLayer) _heatLayer._redraw(); }, 250);
    return _map;
  }

  // Absolute heat scale. Normalizing against the Severe threshold (the
  // same number the day verdict uses) means a quiet day paints a faint
  // teal smudge and only a stacked stadium night reaches full red — the
  // colour now means the same thing on every day. Falls back to the
  // day's own peak for forecast files written before thresholds shipped.
  function heatScaleFor(forecast) {
    var t = forecast && forecast.thresholds;
    if (t && typeof t.T3 === 'number' && t.T3 > 0) return t.T3;
    return forecast && forecast.peak_value;
  }

  function eventsForBucket(forecast, bucket) {
    var events = (forecast && forecast.events) || [];
    if (typeof bucket !== 'number') return events;
    var out = new Array(events.length);
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var curve = ev && ev.time_curve;
      var w = (curve && bucket >= 0 && bucket < curve.length) ? curve[bucket] : 0;
      var impact = (ev && typeof ev.impact === 'number') ? ev.impact : 0;
      // Shallow-copy the event with an intensity field reflecting the
      // selected bucket. Avoids mutating the forecast object the rail
      // and timeline are also reading.
      out[i] = {
        lat: ev.lat,
        lon: ev.lon,
        sigma_m: ev.sigma_m,
        intensity: impact * w
      };
    }
    return out;
  }

  // M6: a compact top-left Leaflet control that explains why no station
  // markers are visible. Distinguishes three states:
  //   * No whitelisted events at all this day → "No major events".
  //   * Events present but none have nearby transit stations →
  //     "No major transit within range".
  //   * Reduced station set is empty (pipeline.gtfs hasn't run) →
  //     suppressed; the GTFS-stale banner above the map covers that.
  function buildTransitNoticeControl() {
    var Ctl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var wrap = el('div', 'ef-transit-empty');
        wrap.setAttribute('role', 'note');
        wrap.appendChild(el('span', 'ef-transit-empty__eyebrow', 'Stations'));
        var msg = el('span', 'ef-transit-empty__body');
        msg.setAttribute('data-msg', 'true');
        wrap.appendChild(msg);
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        this._wrap = wrap;
        this._msg = msg;
        return wrap;
      },
      setMessage: function (text) {
        if (this._msg) this._msg.textContent = text;
      }
    });
    return new Ctl();
  }

  function transitFlagsHaveStations(forecast) {
    var tf = forecast && forecast.transit_flags;
    var list = (tf && tf.events) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].stations && list[i].stations.length) return true;
    }
    return false;
  }

  function updateTransitNotice(forecast) {
    if (!_map) return;
    var stationsConfigured = Object.keys(_stationMarkers).length > 0;
    var hasEvents = !!(forecast && forecast.events && forecast.events.length);
    var hasFlaggedStations = transitFlagsHaveStations(forecast);

    // If the city has no station collection at all, the GTFS layer is
    // simply not present — the global stale-data banner covers that.
    // Suppress this map-level notice in that case.
    var shouldShow = stationsConfigured && !hasFlaggedStations;
    if (!shouldShow) {
      if (_transitNoticeControl) {
        _map.removeControl(_transitNoticeControl);
        _transitNoticeControl = null;
      }
      return;
    }

    if (!_transitNoticeControl) {
      _transitNoticeControl = buildTransitNoticeControl().addTo(_map);
    }
    var msg = hasEvents
      ? 'No subway station within walking distance of these events.'
      : 'Nothing major on this day, so no stations are flagged.';
    _transitNoticeControl.setMessage(msg);
  }

  function setForecast(forecast, cityConfig) {
    if (!_map) return;
    _currentForecast = forecast || null;
    var tz = cityConfig && cityConfig.timezone;
    var events = (forecast && forecast.events) || [];
    var verdict = forecast && forecast.verdict;

    renderMarkers(events, tz, verdict);

    // Rebuild the per-bucket transit-flag index for the new day. This
    // walks avoid_windows[] + transit_flags.events[] once on day change,
    // so subsequent setBucket() calls stay O(stations).
    buildBucketFlags(forecast);
    updateTransitNotice(forecast);

    // Default the heatmap to the day's peak bucket. The scrubber will
    // call setBucket() to override.
    var peakBucket = (forecast && typeof forecast.peak_bucket === 'number')
      ? forecast.peak_bucket : null;
    _currentBucket = peakBucket;
    if (_heatLayer && _heatLayer.setData) {
      _heatLayer.setData(eventsForBucket(forecast, peakBucket), heatScaleFor(forecast));
    }
    applyStationStatesForBucket(peakBucket);
  }

  // Recompute per-event intensity at the given 15-minute bucket and
  // re-splat the heat canvas. The scrubber calls this on every drag tick;
  // no server round-trip, no sigma recomputation. peak_value (set on
  // setForecast) anchors the normalization so brightness varies with
  // the bucket's timeline value. Also repaints flagged-station states
  // off the precomputed _bucketFlags index.
  function setBucket(bucket) {
    if (!_map || !_currentForecast || !_heatLayer) return;
    if (typeof bucket !== 'number') return;
    _currentBucket = bucket;
    _heatLayer.setData(
      eventsForBucket(_currentForecast, bucket),
      heatScaleFor(_currentForecast)
    );
    applyStationStatesForBucket(bucket);
  }

  function invalidate() {
    if (_map) _map.invalidateSize();
  }

  window.EFMap = {
    ensureMap: ensureMap,
    setForecast: setForecast,
    setBucket: setBucket,
    setStations: setStations,
    stationFlagsAtBucket: stationFlagsAtBucket,
    invalidate: invalidate
  };
})();
