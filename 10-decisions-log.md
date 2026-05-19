# Decisions Log

Chronological log of consequential decisions that aren't otherwise obvious from the code. Each entry records WHY the decision was made so future revisions can be judged against the original intent.

## 2026-05-18 — M1

### Verdict thresholds (placeholder)

`pipeline/scoring.py` sets `T1=5.0`, `T2=15.0`, `T3=30.0`, mapping `peak_proxy` to **Quiet / Moderate / Busy / Severe**.

These are **placeholders pending calibration** against a representative Toronto week. The rationale for the starting values:
- A single 20k-seat arena event scores `capacity_factor 20 × ~1.0 weights ≈ 20`, so a one-major-event day lands solidly in Busy.
- An empty or background-only day lands at Quiet.
- Stacked major-venue days (multiple Rogers Centre / Scotiabank Arena / Rogers Stadium events) land at Severe.

**Initial real-data observation (May 18–24, 2026):** with the M1 whitelist + thresholds, six of seven days came back Severe (peak_proxy 34–206). That's plausibly correct for a Friday-of-Memorial-Day-weekend-equivalent stretch with multiple Rogers Centre concerts and Mirvish runs, but the resolution is clearly compressed — we lose differentiation between "stadium concert" and "stadium concert + festival + arena event". Calibration in a later pass should:
1. Sample a known-quiet week and a known-busy week from the real Toronto calendar.
2. Compute peak_proxy distributions and pick thresholds that target roughly 30% Quiet, 35% Moderate, 25% Busy, 10% Severe across an average year.
3. Consider whether `peak_proxy` itself needs a different aggregator (e.g. max over time-of-day buckets rather than sum) once M3's timeline produces a real peak.

### Time-of-day concentration weights (placeholder)

`pipeline/scoring.py` `_TOD_BANDS`: morning 0.6, afternoon 0.8, evening 1.0, late 0.9.

These tilt the M1 verdict proxy toward prime-time impact. Will be retired when M3's 15-minute busyness timeline replaces `peak_proxy` with a real per-day peak.

### Whitelist threshold deviation — sub-5k venues included

The modeling spec says "roughly 5,000 seats and above plus all pro sports stadiums/arenas plus major amphitheatres". Six venues in the M1 whitelist fall below 5k and are not pro-sports or amphitheatres:

- Meridian Hall (3,191), Massey Hall (2,752), Roy Thomson Hall (2,630), Ed Mirvish Theatre (2,278), Princess of Wales Theatre (2,000), History (2,500).

**Why included:** Without them the whitelist drops to six venues, well below the spec's "~10–20 venues" target. These are the major touring-Broadway / concert-hall / mid-size-concert tier downtown — they regularly drive headline-act crowds even though the venue itself is sub-5k. Excluding them would make Toronto's downtown theatre district invisible to the model, which is worse than the small-venue-clustering false positive that the spec is trying to avoid.

**How to revisit:** if real-world calibration shows these venues meaningfully overstate crowd impact at sub-5k capacity, demote their category multiplier (e.g. `performing_arts` from 0.45 → 0.35) before removing the venue outright.

### Font choices

Loaded via Google Fonts `<link>` in `index.html`:
- **Display:** Instrument Serif (italic available) — characterful editorial serif, used for the brand mark and the verdict labels. Provides the "not generic AI dashboard" feel the visual brief asks for.
- **Body / sans:** Space Grotesk — clean geometric sans, technical without being default-y. Used for event names and body copy.
- **Mono:** JetBrains Mono — used for timestamps, the disclaimer, and the city-selector label, where the data-product feel is desired.

These are deliberately not Inter / Roboto / Arial / system defaults, per `CLAUDE.md`.

### Data deploy strategy

`data/` is not committed and not in the SFTP deploy workflow. It's a build artifact, like `cache/`.

- **Local dev:** the Python pipeline writes `data/<city>/<date>/forecast.json` locally, and the PHP layer + frontend read those files via `php -S`.
- **Production:** the same pipeline runs on Bluehost via cPanel cron (configured in M6). PHP reads the cron-written files in place.
- **M1 transition:** for a one-time manual deploy verification before M6, the operator can SFTP `data/` once. Not required for any acceptance criterion in M1.

This is consistent with the existing `.gitignore` (`data/` is ignored) and `.github/workflows/deploy.yml` (`data/**` is excluded from deploy).

### City iterator pattern

The pipeline reads `config/cities.json` (a JSON array of city ids) and iterates. The PHP layer reads the same file. Adding a second city is two new files (`config/<id>/city.json`, `config/<id>/venues.json`) and one line in `cities.json` — no code change in any layer.

`--city <id>` is preserved as an override on `pipeline.run` for one-off runs.

## 2026-05-18 — M2

### Heatmap summed client-side, not as a precomputed grid

The M2 modeling spec offers either (a) precompute the full distance-decay heat grid in Python and ship it in the per-day JSON, or (b) ship per-event venue intensities + sigmas and sum on the client.

**Chose (b).** Reasons:
- Toronto's bbox at a 75m grid is ~570 × ~407 = ~232,000 cells. Even a Float32 array would be ~900 KB before JSON encoding — too large.
- Per-event intensity + sigma is O(events) ≈ 20–60 floats per day — forecast.json stays under 20 KB for a busy day.
- M3's scrubber needs the heat to recompute at an arbitrary bucket. With (b) the client just multiplies `impact × time_curve[bucket]` and re-sums — no new endpoint, no new JSON shape.
- Heat is rendered onto a downsampled canvas (one canvas pixel ≈ 75m at the current zoom), then bilinearly upscaled. Cheap to redraw on zoom/move; cheap to re-sum on day switch.

**Trade-off accepted.** Normalization is per-redraw (`v / max(grid)`) — a Quiet day's "peak" lights up the same brightness as a Severe day's, just at smaller radius. Absolute intensity is conveyed by marker size + the daily verdict chip; the legend reads `Low → Peak` (relative), not `0 → 100` (absolute). If calibration later wants an absolute ramp, the change is one line in `map.js`.

### Per-event `time_curve` shipped in forecast.json

The per-day JSON carries each event's full 96-bucket street-presence curve (Float, rounded to 4 decimals), plus `sigma_m` and `peak_intensity`.

The curve is technically redundant with `start_local`, `end_local`, `category`, and `impact` — the client could recompute it. But:
- Duplicating the arrival-ramp / dispersal-tail math in JS is brittle (two sources of truth for the modeling spec).
- The full curve costs ~200 bytes per event after JSON-encoding zeros; ~50 events × 200 B = ~10 KB per day, acceptable.
- M3's scrubber reads `events[i].time_curve[bucket]` directly — no client-side modeling code.

### Heatmap palette + legend

Five-stop ramp (`#0EA5A5 → #22C55E → #EAB308 → #F97316 → #EF4444`) lives in `tokens.js` under `primitives.color.heatmap` and is re-exported as `semantic.color.heatmap.s0..s4`. Same hue progression as the verdict palette but the canvas overlay uses `mix-blend-mode: screen` so the dark basemap stays legible underneath.

The legend is **NOT** Leaflet's `L.control.info`-style widget — it's a custom HTML control with explicit "Modeled estimate / Not measured" eyebrow plus fine print explaining the modeling. Visible at all times per the spec.

### OSM basemap = CARTO's `dark_all`

OpenStreetMap doesn't ship a dark tile set itself. CARTO's `dark_all` is OSM-derived (no key required) and renders the city as a quiet black canvas that the heatmap reads cleanly on. Attribution string carries both OSM and CARTO credit, satisfying OSM's required attribution.

No Mapbox / MapTiler key is introduced — staying within the spec's "no third-party basemap key" rule.

### Map detail panel — single scaffold, not re-rendered on day-change

`renderDetailForSelected` builds the detail panel's DOM once (`data-scaffolded`) and reuses it on every day switch. Earlier iteration cleared `#forecast-detail` and rebuilt; that detaches the Leaflet map (still bound to the old `#map-canvas`) and breaks the heat layer + markers on second click. The fix is straightforward but worth recording so M3 doesn't trip over it when wiring the timeline.

## 2026-05-19 — M6

### Cron cadence — two TM cron entries, one weekly GTFS

Bluehost cPanel cron configures three entries instead of one shared schedule:

- **Every 30 min:** `python -m pipeline.run --window-days 1` (refreshes the next-24h window — this is the cadence that matters for "is tonight going to be a problem?").
- **Every 3 hours:** `python -m pipeline.run --window-days 7` (refreshes the full forecast window — slower because changes 2-7 days out are not time-sensitive).
- **Weekly Sun 03:30:** `python -m pipeline.gtfs` (TTC publishes a fresh static zip about monthly; refreshing weekly catches each new release within ~7 days without hammering the agency mirror).

**Why this shape and not "every 30 min for everything":** Toronto's headroom is comfortable (a single window-days=7 cycle ≈ 5-10 page fetches; 5000/day TM budget covers ~500-1000 full-window refreshes). But the architecture must remain sane if M5 adds 2 more cities — running every-30-min for all 3 cities at full 7-day window would still be safe (~432 short + 24 full = ~460 cycles/day × 3 cities × ~10 page fetches = ~13,800 calls/day, which is over budget). The tiered cadence keeps the busy short window aggressive while staying within budget at M5 scale.

The 30-min cadence was chosen over 15-min because the underlying data (Ticketmaster event listings) changes at the cadence of new event announcements (hours-days), not minutes. 30-min trades 30 mins of staleness for half the cron-process overhead on shared hosting.

### Per-city daily Ticketmaster budget

`pipeline/budget.py` tracks calls per city per local-calendar-day in `data/cache/ticketmaster/budget.json`, with a configurable per-city `daily_budget` (default 2000). When exhausted, `ticketmaster.fetch_events` raises `BudgetExhausted` and `pipeline.run` catches it — the prior forecast files stay on disk and the frontend shows a "Cached forecast — daily budget reached" banner with the last-successful timestamp.

**Why 2000/city default and not 5000:** Ticketmaster documents the free tier as ~5000 calls/day **across all keys** for one account. With one key shared across all configured cities, partitioning headroom avoids the situation where Toronto runs hot and pre-empts NYC/Chicago at the M5 expansion point. 2000 × 3 cities = 6000 nominal, but exhausting all three same-day is implausible; the practical ceiling is closer to 2-3 cities running at ~500 calls each.

### Status file — single source of truth for "is the data fresh?"

`data/status.json` is written by both the TM cron and the GTFS cron (different sections, atomic merge). PHP `/api/status.php` exposes it; `/api/city.php` includes a per-city freshness summary so the frontend can render the banner without a second roundtrip. The thresholds (TM `max_age_minutes=180`, GTFS `max_age_days=14`) live in `pipeline/status.py` and are also persisted to the status JSON so PHP / JS don't duplicate the constants.

**Staleness reflects last SUCCESS, not last ATTEMPT.** A failed fetch records `last_attempt_at` but doesn't reset `last_success_at` — the operator-facing banner ("Forecast may be stale — last good fetch was X") describes data freshness, not cron liveness. A separate `last_error` field tells the operator what just failed, without lying about how old the data they're looking at is.

### GTFS — fall back to stale cache loudly, never silently

The M4 implementation silently used a stale cached zip when the GTFS download failed. M6 changes this to log loudly (`download failed; falling back to STALE cached zip ... operator should investigate the feed URL`), record the cache's mtime to `status.json` so the frontend shows the GTFS-stale banner, and surface the age in `/api/status.php`. The cache TTL itself stays 24h.

### GTFS zip cache prune — retain 2

`pipeline/gtfs.py` calls `_prune_old_zips` at the end of every successful refresh, keeping the latest 2 zip files per city in `data/cache/gtfs/`. In steady state this is a no-op (the pipeline writes to one stable filename), but a one-off `--refresh` or a future filename rotation could pile up disk usage on shared hosting where space is finite.

### M6 stretch items — both declined

Two stretch items were optional. Both were declined for shipping reasons, not preference. Either could be a post-MVP add later.

**Street-snapped heatmap — declined.** The current radial Gaussian field renders cleanly under the CARTO dark basemap and is honestly labeled as a modeled estimate. Street snapping would require either:
- offline OSM extract preprocessing (adds a non-trivial build step, violates the no-build-tooling constraint and the $0-to-run constraint if the operator pays for hosted routing tiles), or
- a client-side library like Turf.js running over a cached OSM road graph (adds a build dependency or pulls in a CDN-loaded JS lib that the no-framework rule was meant to prevent).

The visual fidelity gain is real but doesn't pay for the architectural cost at MVP. The hook exists to add it later — the heatmap is masked at the canvas layer, so a future "intersect with street mask" pass plugs in without touching the modeling spec.

**"Was it actually busy?" feedback hook — declined.** Implementing this cleanly requires:
- a server-side WRITE endpoint (the PHP layer is currently read-only — adding a write endpoint expands the attack surface: CSRF tokens, IP rate-limiting, and a denylist for abuse mitigation),
- a per-day feedback storage file alongside `forecast.json` (anonymous but durable),
- a UI affordance on past forecast days only.

That's a meaningful chunk of work that would compromise other M6 acceptance criteria if rushed in. The decisions log notes the eventual integration point (the feedback file lives alongside per-day JSON, so it's trivial to read back when tuning the modeling spec constants).

### Footer attribution — three lines, each contractually required

The footer now renders three credits per the respective free-tier ToS:
- "Event discovery powered by Ticketmaster." — Ticketmaster developer ToS.
- "Map: OpenStreetMap contributors · CARTO basemaps" — OSM tile usage policy + CARTO basemap attribution.
- "Transit: TTC GTFS via City of Toronto Open Data (City of Toronto Open Data Licence v1.0)" — Open Data Licence v1.0 requires source + licence disclosure.

The GTFS credit is keyed by city_id; M5's NYC and Chicago expansion adds entries to `gtfs_attribution_for()` in `api/_common.php` without touching the frontend.
