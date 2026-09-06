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

## 2026-07-03 — Scheduled refresh moved to GitHub Actions

### Why the move

The Bluehost cPanel Python cron (above, "Cron cadence") was never reliably set up — the live site froze on the week of 2026-05-18 because nothing was running the pipeline. Data generation now runs on GitHub Actions (`refresh.yml`, 4×/day at 10:00/15:00/20:00/01:00 UTC, timed to land before the operator's Eastern check-ins) and FTP-pushes only the generated `data/` tree to Bluehost using the same three FTP secrets as the deploy workflow. The PHP serving layer and frontend stay on Bluehost unchanged. The Ticketmaster key moves to a `TICKETMASTER_API_KEY` repo secret (`pipeline/config.py` already preferred the env var).

The old two-tier cadence (every-30-min short window + every-3h full window) is replaced by 4×/day full-window runs: GitHub cron isn't minute-precise (runs can be delayed or dropped at busy times), and event listings change at announcement cadence, not minutes. `TM_MAX_AGE_MINUTES` widened 180 → 720 accordingly (largest slot gap is 9 h; a fully missed day still flags).

### Consequences of the clean-checkout model

Each Actions run starts with no `data/` — the pipeline regenerates the whole window from scratch. Three code changes follow from this:

- **PHP serves today-onward only.** `list_forecast_days()` filters to dates ≥ today in the city's timezone and caps at 7, so stale date folders on the server (e.g. pre-migration leftovers) are never listed. `pipeline.run` also prunes pre-today date folders after each successful city run (a no-op in CI; matters for local/persistent-disk runs).
- **Staleness is recomputed at read time.** `city_freshness()` derives `stale` from `last_success_at` / `last_refresh_at` against the clock instead of trusting the write-time boolean frozen into `status.json` — a stalled pipeline never rewrites the file, which is exactly when the banner is needed. Thresholds still come from the values the pipeline persists into `status.json`.
- **GTFS freshness rides in git.** `status.json` is rebuilt from scratch each run, so the GTFS section would always be the never-ran skeleton (permanent "transit data stale" banner). `pipeline.gtfs` now writes `config/<city>/stations_meta.json` (tracked) beside the station set, and `pipeline.run` copies its `refreshed_at` into `status.json` on every run. The weekly `refresh-gtfs.yml` commits the regenerated station set + meta back to `main` — commit-back, not FTP, because the station set is a pipeline input consumed from the CI checkout; nothing server-side reads it.

The per-city daily TM budget counter (`data/cache/`) also resets every run in this model — acceptable, since 4 runs/day × ~10 page fetches is nowhere near the 5000/day tier. The FTP data push verifies today's `forecast.json` exists for every configured city before syncing, because the incremental sync deletes server files missing locally — an empty upload after a soft-failed run would otherwise wipe the served data.

## 2026-07-03 — Non-crowd listing exclusion filter

### Why

Ticketmaster attaches non-event inventory to major venues, and the whitelist happily passes it through: "Rogers Centre Ballpark Tours" and "Guided Tours of Scotiabank Arena" appeared as scored events **every day** of the observed July 3–9 window. Because scoring uses venue capacity as the attendance proxy, the Rogers Centre tour scored impact ~49 daily — the single highest-impact "event" of the week, ahead of every real concert — and pushed otherwise-ordinary days to Severe. A walking tour of an empty stadium is not a crowd event.

### What

`pipeline/eventfilter.py` applies `config/event_filters.json` immediately after the venue whitelist. This is an *exclusion* refinement of the whitelist rule, not a discovery mechanism — "an event counts only if its venue is on the whitelist" becomes "…and the listing is an actual crowd event". Two rule kinds:

- **Classification rules** (preferred): matched against the event's primary TM classification. The tours carry a crisp taxonomy — `type=Event Style, subType=Sightseeing/Facility` — so the filter is surgical, with zero risk to real concerts. Deliberately NOT excluding all of `segment=Miscellaneous`: legitimate crowd events land there too (e.g. FIFA Fan Festival is `Sports/Miscellaneous` — irrelevant today because Fort York isn't whitelisted, but the 2026 World Cup makes the caution concrete).
- **Name patterns** (operator lever): case-insensitive substrings ("ballpark tour", "parking", "vip package", …) for inventory TM classifies inconsistently. Patterns are deliberately specific — a bare "tour" would nuke half of live music ("PCD FOREVER TOUR", "Oneness Tour 2026").

One global file, not per-city: the rules are TM-taxonomy hygiene, identical for every city, so M5 cities inherit them for free. Fail-open on a missing/malformed file (an extra tour listing is a smaller error than an empty forecast), and every exclusion is logged with its matching rule.

**Not filtered:** small-but-real concerts at whitelisted venues (the operator flagged "Kes – Roots, Rock, Soca Tour" — but it plays RBC Amphitheatre, capacity ~16k; that is a major concert by this product's definition). If those ever need trimming, the honest lever is a minimum-impact floor decided against calibration data, not per-artist name patterns.

**Observed effect (July 3–9 window):** 11 of 20 scored listings were excluded (the two tours, running most days). Verdicts went from Severe×5 + Busy×2 to: Jul 3/5/7 Severe→Busy, Jul 4 Severe (Lionel Richie + two more real shows — legitimately), Jul 6 and Jul 9 → Quiet with **zero** events (the "events" those days were only the tours), Jul 8 Busy→Moderate. Verdict thresholds untouched — the inputs got honest, not the scale.

### UI event-type filter chips (same day)

The operator also wanted a browse-time filter in the UI. Design decisions:

- **Chips are Sports / Concerts / Theatre & other**, grouped by the event's own TM classification segment — the venue category can't do this job (Coca-Cola Coliseum hosts both Tempo games and concerts). `pipeline.run` now ships `segment` per forecast event; the frontend falls back to venue category for pre-`segment` day files, so stale data degrades gracefully instead of breaking the chips.
- **Client-side view filter, not a data filter.** `filteredForecast()` in `app.js` builds a per-day view: filtered events, timeline re-summed from the survivors' time curves (mirrors `build_daily_timeline`), recomputed peak bucket/value and `peak_intensity`, filtered avoid windows + transit flags. `map.js` and `timeline.js` render the view unchanged — zero modifications to either module.
- **The day verdict is deliberately NOT recomputed.** A hidden concert still clogs the TTC; the verdict answers "how busy will the city be", the chips answer "what do I want to browse". A mono-type note ("Verdicts still reflect all modeled events.") renders whenever a chip is off so the divergence is explained rather than discovered.
- **Persistence is `localStorage`** (`eventforecast.typeFilter`), matching the existing theme-preference pattern. Per-browser, no server round-trip, all-on default.

### Verdict-follows-filter toggle + downtown default map view (same day)

Two operator-requested refinements:

- **"Busyness from shown only" switch** (right side of the filter row, persisted as `eventforecast.verdictMode`). Default stays full-model — the verdict answers "how busy will the city be" and a hidden concert still clogs the TTC. The opt-in mode answers the *other* question ("how busy because of what I care about") by re-bucketing the day from only the visible events. To keep one source of truth for the modeling math, the pipeline now ships `proxy_contribution` per event (impact × time-of-day weight, computed by `scoring.proxy_contribution` — the same weighting `daily_verdict` uses), and the client sums the survivors against the `thresholds` already shipped in forecast.json. No TOD-band constants duplicated in JS; pre-`proxy_contribution` day files fall back to raw impact. The filter-active note switches copy ("Verdicts reflect shown events only.") so the chip's meaning is always declared.
- **`map_default_view` in city config** (`config/<city>/city.json`, echoed by `api/city.php`). The initial full-bbox fit rendered ~90% of Toronto's whitelisted venues as one downtown clump. The map now opens on a configured center/zoom (Toronto: 43.642, −79.395 @ z13 — downtown core through Exhibition Place) and falls back to the bbox fit for cities without the key. Config-driven per the no-hardcoded-city rule; `maxBounds` still comes from the bbox so panning stays inside the city.

## 2026-09-03 — UX rebuild after the usability audit

The audit found the product polished but not actionable: most days read
Severe, the transit rail listed dozens of bus stops with route numbers,
and the answer to "which stations, when" was spread across four panels.
Eight changes landed together on one branch; each is recorded here.

### Verdict recalibration — T1/T2/T3 = 5 / 30 / 65

The M1 placeholders (5 / 15 / 30) put a single ordinary Blue Jays game
(impact ≈ 43) at Severe, so four of seven days in a normal week read
Severe and the word carried no information. New thresholds target:

- **Quiet** (< 5): theatre-only nights.
- **Moderate** (5–30): one arena game or a mid-size show (Scotiabank
  Arena ≈ 22, Coca-Cola Coliseum ≈ 8 + theatres).
- **Busy** (30–65): one stadium game or stadium concert (Rogers Centre
  baseball ≈ 37–43, BMO Field ≈ 33, Rogers Stadium concert ≈ 63).
- **Severe** (≥ 65): stacked nights — two stadium-scale events, or a
  stadium plus an arena the same evening.

`peak_proxy` is still the time-of-day-weighted sum of impacts (not the
timeline max), so an afternoon game plus an evening concert stack into
Severe even though they don't overlap; that matches "how busy is the
day" and is left as is. `bucketVerdict()` in `app.js` carries the same
defaults for pre-threshold day files.

### Curated venue → station map replaces the transit radius

`config/<city>/venue_stations.json` is now the source of the "stations
likely packed" list: a station catalogue (subway + GO, with lat/lon and
lines) and a per-venue list of one to three stations, optionally `via` a
surface route ("Union via 509 Harbourfront streetcar" for BMO Field).
Rationale: with ~12 venues a hand list is shorter and more honest than a
600 m radius, which either missed the real stations (Rogers Centre, BMO
Field, Rogers Stadium have no subway inside the circle) or dragged in
forty bus stops. Coordinates typed from memory are marked
`verified: false` in the file; the seven downtown Line 1 stations were
copied from the GTFS-derived set.

**GO stations are included** (Union GO, Exhibition GO, Downsview Park
GO) behind an off-by-default toggle. This deviates from the "Toronto
(TTC) only" decision in a narrow way: three hand-typed catalogue rows,
no GO feed is ingested. Operator-requested.

### Station kinds; bus stops dropped; streetcar behind a toggle

`pipeline.gtfs` now reads GTFS `route_type` and writes a `kind`
(subway / streetcar / bus) per reduced station; `transit.keep_kinds` in
city.json (default subway + streetcar) drops bus-only stops at
generation time. Until the weekly GTFS job regenerates the committed
station file, `pipeline.transit` classifies the old file from line
names using the city config's `subway_lines` and
`streetcar_route_pattern`, so the fallback is still config-driven.
GTFS subway stations are used only when a venue has no curated entry.
Streetcar stops are capped at the nearest four per event and show only
their 5xx routes (not the night buses that share the pole). The
frontend shows subway by default; Streetcar and GO are persisted
toggles, off by default (operator's choice).

### Manual crowd days — `config/<city>/manual_events.json`

Parades, street festivals, marathons and road closures are the biggest
"avoid downtown" days and none are ticketed, so the whitelist can never
see them. The operator-maintained file lists them with a date, window,
area, crowd estimate, category and station ids; each dated entry is
fully modeled (impact via `scoring.score_event` on a synthetic venue,
time curve, avoid windows, heat splat, station list, verdict). This is
NOT discovery logic: nothing is inferred, the operator types every
entry. Shipped with two template entries (`date: null`, skipped) rather
than seeded 2026 dates, because those dates could not be verified at
build time. Manual events always render regardless of the type chips
(they are days, not a type) and carry `source: "manual"`.

### Today-first layout, times lead the station cards, smaller venues hidden

The detail panel order is now: date + verdict + "Because …" driver
line, the stations panel, the timeline, the map, then the events at
the scrubbed time. A one-paragraph takeaway sat between the header and
the stations in the first cut; the operator reviewed it and asked for
the station cards to carry that message instead, with the time as the
loudest element. Each card now leads with its busy windows in
title-size mono digits ("10:07–11:22 PM · letting out"), and the cause
prints once under the card. The day pills gained a "Busiest 10:00 PM"
line for the same reason. Same order on every
screen size. The 7-day strip is a row of compact verdict pills (Today /
Tomorrow / weekday, verdict, top event). Events at venues under 5,000
seats are hidden from the browsable view by default (a persisted
"Smaller venues" chip shows them); they still count toward the verdict.
All of this is client-side over data already in the day file — no new
pipeline output.

### Absolute heat scale; wording; 12-hour times

The heatmap now normalizes against the Severe threshold (`thresholds.T3`)
instead of the day's own peak, so a quiet day paints a faint smudge and
only a stacked night reaches full red; the legend reads Quiet → Severe.
The visibility floor rose from 1% to 3% of scale so the blob is
honestly sized. "Arrival" / "Dispersal" became "Heading in" /
"Letting out", "Impacting at" became "Events at", and every time in the
UI is 12-hour (timeline axis, readout, windows, cards).

### One sans for everything — IBM Plex Sans (operator veto of the type direction)

The operator found the type hard to read: the italic serif verdicts and
titles (Instrument Serif) and the wide-tracked uppercase monospace
labels and times (JetBrains Mono) at 10–12 px on a dark ground. Every
text role now resolves to IBM Plex Sans, loaded from Google Fonts. The
three font tokens (`display` / `mono` / `body`) are kept so nothing in
the cascade changes structurally; hierarchy now comes from weight
(semibold verdicts, titles, and the times on station cards) and from
tabular figures, not from switching families. All italics were removed,
letter-spacing on uppercase labels was capped at 0.06em, and the 10–11 px
literals became the 12 px micro token. The timeline canvas follows the
same tokens. This retires the M1 "characterful display + technical
mono" pairing on readability grounds; overview §7's "no Inter / Roboto /
Arial / system default" guidance still holds (Plex is none of those).

### Line pills carry the agency's line colours

Line pills ("Line 1", "504", "Lakeshore West") are painted in the
transit agency's own colours, read from `transit.line_colors` in
`config/<city>/city.json` and echoed by `api/city.php`. These are brand
data, not design tokens: a Toronto rider reads yellow as Line 1 on
sight, and the MTA's or CTA's palette will live in its own city file.
Text on each pill flips between the token text colours by luminance.
Lines 1, 2, 4 and 5 use the TTC Brand Standards values (Pantone 123 C,
347 C, 234 C, Orange 021 as RGB); Line 6 grey, the streetcar red and the
GO green are typed from memory and flagged unverified in the config.

### 26-hour modeled day — spillover past midnight stays with its day

Each day's time curves, timeline, and avoid windows now cover 12:00 AM
through 2:00 AM the next morning (104 fifteen-minute buckets instead of
96). Under the 24-hour day a show letting out at 11:30 PM lost its
tail at midnight, and the next day's file never picked it up because
events are bucketed by their own start date. The extra two hours are
this day's own spillover; the previous night's spillover lives in the
previous day's file, so nothing is double counted. The frontend reads
the bucket count from the day file (`buckets`, `span_hours` are also
shipped) and still renders older 96-bucket files. Operator-requested,
in service of the "morning to night" timeline axis below.

### Station lanes inside the timeline; overnight hours hidden by default

The separate "stations likely packed" card grid is gone. The timeline
now carries the stations as lanes under the curve: one row per
station, a compact chip (name + line badge, no times) anchored at each
busy window, so the axis above says when. Hover or focus a chip for the
full details (exact window, In / Out, the event, the "via" route);
click it to move the scrubber there. Lanes are laid out in percentages
of the visible range so they never need a re-measure. The Streetcar and
GO toggles moved into the timeline's chip row. Operator-requested: the
timeline and the station list were answering the same question in two
places.

The visible range hides midnight to 9 AM by default (persisted
"Overnight" chip shows the full 26 hours), so the axis reads
9 AM → 2 AM. A day with real early activity, above 10 % of its peak
before 9 AM (a 6 AM marathon), expands on its own down to that hour.

### Range brush, smooth curve, badge-first chips

- **Range brush.** The "Overnight" on/off chip became a proper range
  control: a miniature of the whole 26-hour day above the chart with
  two draggable handles (15-minute steps, 2-hour minimum span; drag the
  window to slide it; arrow keys on a handle). The main chart, the
  lanes, and the scrubber follow the range, and the axis picks finer
  ticks (down to 15 minutes) as the range narrows. The range persists;
  "All day" toggles the full 26 hours, and clearing it returns to the
  default (9 AM → 2 AM, or earlier on a day with early activity).
  Operator-requested: "slide between very specific times".
- **Smooth curve.** The busyness curve is drawn with monotone cubic
  (Fritsch–Carlson) interpolation through the bucket centres instead of
  15-minute steps. Monotone so it never dips below zero or invents a
  bump between two buckets; the underlying numbers are unchanged.
- **Badge first, number only.** Line badges read "1" instead of
  "Line 1" (the coloured badge already says it's a line) and sit before
  the station name: [1] Union, [504] King St West at Bay St.

### Mini graphs in the day cards

Each card in the 7-day strip carries a small canvas of that day's
busyness curve, so the week can be scanned without opening each day.
Same monotone smoothing as the main chart, drawn by the timeline module
(`EFTimeline.sparkline`). Two deliberate differences from the main
chart:

- **Absolute scale.** Every card is normalized to the Severe threshold
  (or the day's own peak when higher), so a Quiet day reads as a low
  line and a Severe day fills the box. The main chart stretches each
  day to its own peak, which is right for reading one day and wrong
  for comparing seven.
- **Shared window.** All cards cover the same hours: 9 AM to 2 AM,
  pulled earlier to the hour when any day in the outlook has modeled
  activity at or above the Quiet threshold before 9 AM. Faint stubs on
  the baseline mark 12 PM, 6 PM and midnight so the cards line up by
  time; today's card also carries a thin "now" line.

The graph follows the view filters like the peak time and the
sub-line, and is decorative for assistive tech: the verdict and the
"Peak" line carry the same information in text. Operator-requested.

### Range mode persists across days; event lane; one chip look

- **The range follows a mode, not a number.** "All day", "Fit" and the
  default are remembered as the choice itself, so switching days keeps
  All day at all day and re-fits Fit to the new day's activity; only a
  hand-brushed range keeps its hours. The chart, brush and lanes glide
  to the new range (320 ms ease-out; skipped under
  `prefers-reduced-motion`). Peak / Now light up while the scrubber
  sits on that bucket, and "Now" stays the choice across days: on a day
  that isn't today the scrubber sits on the peak and returns to now on
  today. Operator-requested.
- **Handle times sit inside the range.** The start time is flush with
  the start handle and reads rightward, the end time flush with the end
  handle reading leftward, so nothing hangs past the handles into the
  drag area. On a narrow range they flip to the outside.
- **Event lane above the curve.** One chip per event over its modeled
  crowd window (first In minute to last Out), start time as the badge,
  name after it; hover or focus for the venue, size, and the In / Out
  windows; click to scrub to the start. Same chip machinery as the
  station lanes (percent positions, right-edge anchoring, measured
  stacking when events overlap).
- **One chip look.** View filters and timeline controls share one
  style with three legible states: on (accent border + tint), off
  (plain outline, secondary text, no dimming), disabled (muted, 50 %).
  The previous off state dimmed to 75 % on muted text and read as
  disabled. The "Selected day" eyebrow is gone; the date line says it.

### Shared chip component; compact streetcar names

- **`.chip` is one component.** The view filters and the timeline
  controls looked alike but the timeline chips had tighter padding.
  Both now carry the `chip` class and share every visual rule (size,
  padding, states); the BEM classes are layout and scripting hooks
  only. Operator-requested.
- **Compact streetcar names in the lanes.** GTFS stop names such as
  "King St West at Bay St" are shown as "King W / Bay" (street-type
  words dropped after the first word, directions abbreviated, the
  " - X Station" suffix removed); the popover keeps the full name.
  Streetcar names also cap tighter than subway names, which cuts the
  stacking on a busy day.

### Tighter chips, dot separators

Chip side padding drops from 16 px to 12 px (new semantic spacing step
`smd`, the 12 px primitive already existed). The timeline chip row
separates its three groups with a middle dot instead of a hairline:
Streetcar / GO · All day / Fit · Peak / Now. Operator-requested.

### v2 adopted: absolute chart scale, now line, compact legend and rail

Built as a side-by-side proposal, then adopted whole with one change
(the peak stays labelled on the canvas; the "Peak at" title above the
chart is gone, so the peak is said once, where it sits).

- **Absolute chart scale.** The main chart and the brush normalize to
  the Severe threshold with 15 % headroom (or the day's peak when it
  climbs higher), with dashed Busy and Severe lines labelled at the
  right edge. Before, each day stretched to its own peak, so a Quiet
  Sunday drew like a Severe Saturday. Now the height of the curve
  means the same thing every day, and the day cards already worked
  this way.
- **Now line on today's chart**, dashed, with a small label.
- **"Ratings follow filters"** replaces "Busyness from shown only" on
  the verdict switch; the notes say "Ratings still count hidden
  events." Rating is the word for the Quiet / Moderate / Busy / Severe
  call in the UI; "verdict" stays a code-side term.
- **Events rail is one row per event** (phase · name · venue · time ·
  Tickets) under "On at [time]". The event lane and its popover carry
  the detail, so the rail's job is the ticket link and the Ticketmaster
  attribution.
- **One-line map legend**: ramp with Quiet / Severe ends, the In / Out
  / Several glyphs, and "Modeled, not measured"; the long wording is
  the tooltip. Phones drop the glyph row.
- **Day cards lead with the count** when there is more than one event:
  "2 events · Coldplay: Music of the Spheres…".
- **Keyboard on the day strip**: left / right arrows move a day, Home
  or T jumps to today, End to the last day; focus follows.

### Finishing touches: bare strip, filters first, flush plot

- The 7-day strip is no longer a card around cards; the day cards are
  the cards. The phone-width fade at the strip's right edge fades to
  the page colour.
- The view filters sit above the strip, since they apply to
  everything below them (strip, timeline, map, rail).
- The timeline canvas, brush and lanes have no side margins of their
  own; the plot runs edge to edge inside the panel's padding, so it
  lines up with the header, chips and legend. The "Now" label clamps
  inside the plot.

## 2026-09-05 — Day history + month calendar

### Past days are archived compactly, not kept whole

The pipeline deleted every trace of a finished day. `pipeline.run`
pruned day folders dated before today, the GitHub Actions refresh
regenerated the window from a clean checkout, and the FTP sync mirrored
deletions to Bluehost. Ticketmaster only serves upcoming events, so a
day, once past, was gone for good.

`pipeline/history.py` now distils each day into a compact record in
`history/<city>/<YYYY-MM>.json`. Measured against a real 7-day Toronto
window (2026-09-05 → 09-11):

| | per day | per year |
|---|---|---|
| full `forecast.json` | 12,286 B | 4.5 MB |
| archive record | 4,585 B | 1.67 MB |

**Why compact rather than keeping the whole file at 2.7x the size.** The
size gap is real but not decisive on its own — 4.5 MB a year would also
be affordable. The deciding reason is schema stability. `forecast.json`
is an internal pipeline artifact whose shape tracks the model: it
carries `flux_curve`, `spot_weights`, `scoring.spots`, `scoring.scopes`,
`subscore_reference` and per-station `seats_per_hour`, none of which any
frontend code reads. Committing that to a permanent, append-only record
would couple years of history to model internals, and every future
change to the scoring intermediates would silently bloat or break the
archive. The archive instead holds exactly what the UI renders, so its
shape is governed by the views, which change far more slowly.

An earlier measurement suggested a 13x saving. That figure came from
stale July fixture data written before `transit.STREETCAR_MAX_PER_EVENT`
shipped, where a single day carried 184 station rows each with a
24-float `seats_per_hour` array. On current output the honest ratio is
2.7x.

**What the archive keeps, and why each piece earns its bytes:**

- verdict, score, thresholds, timeline — the calendar cell and the day curve
- `avoid_windows`, with both the minute and bucket pairs — the timeline bands read buckets, the station lanes read minutes
- per-event `during` windows — the event lane above the curve
- per-event curves — the map heatmap and the time scrubber
- per-event stations — the "stations likely packed" lanes

Per-event curves cost almost nothing and were nearly dropped. An event
is active for ~26 of the day's 104 buckets, so storing the non-zero span
only (`{o, v}`) keeps the exact modeled shape for a few hundred bytes a
day. Dropping them would have cost the map and the scrubber on past
days for no meaningful saving.

### The archive is a field-subset of the live shape, never a renamed one

Station rows keep `station_id` / `station_name` / `via` rather than
shorter keys, and `avoid_windows` keeps all four positional fields.
Shorter names would save roughly 12 bytes a row and buy a translation
layer that rots the first time someone adds a field. Rehydration in
`app.js` is therefore only two expansions — curve spans back to full
length, per-event stations back into a `transit_flags` block — after
which `state.forecasts` holds archived and live days indistinguishably,
and the timeline, map, rail and filters all work on a past day with no
branching.

### Archive records are self-contained; live days still join from config

`api/forecast.php` deliberately does not denormalise venue lat/lon,
so a coordinate fix doesn't require regenerating every day. The archive
takes the opposite line for station name, kind and coordinates: it
stores them with the day. A live day should track current config; an
archived day should record what was actually modeled, and stay readable
after a GTFS refresh renames a stop or a venue's curated station list is
retuned. Venue lat/lon is the one exception — still joined from
`venues.json` by `api/history.php`, because a venue does not move.

### The whole rolling window is archived, not just today

Every run upserts all seven days, so a date is rewritten repeatedly and
the last run of the day wins. Archiving only today would leave a hole
in the calendar for every day the cron missed; archiving the window
leaves a slightly stale forecast instead, which is strictly better.

### `history/` sits beside `data/`, not inside it

`data/` is gitignored, regenerated every run, and FTP-mirrored with
deletions — three properties that would each destroy an archive.
`history/` is committed by `refresh.yml` (as `refresh-gtfs.yml` already
does for station sets) so it survives the clean checkout, and gets its
own FTP step because pushes made with `GITHUB_TOKEN` deliberately do not
trigger `deploy.yml`. That upload has its own emptiness guard, matching
the existing one on `data/`, since it also syncs with deletions.

### Month calendar sits behind a switch, and hides itself when empty

The 7-day strip stays the landing view; "7 days / Month" swaps in the
grid. A calendar cell is a day pill with the peak line and the wide
sub-line dropped for room — same verdict colours, same mini graph, same
selection model. The switch is not rendered at all until the archive has
a month in it, and a saved "month" preference is downgraded to the strip
in that state, so a fresh install can never land on an empty grid.

The month view fetches the displayed month plus its two neighbours in
one request. That is not speculative prefetching: a month grid always
shows the tail of the previous month and the head of the next, and those
cells are inert unless their days are loaded.

### Calendar text uses secondary, not tertiary or muted

At 12px on `--color-bg-raised`, `--color-text-tertiary` measures 3.7:1
and `--color-text-muted` 2.3:1, both under the 4.5:1 small-text floor.
Cell numbers and sub-lines use `--color-text-secondary` (6.8:1), which
also matches `.day-pill__sub`. Hierarchy in a cell comes from size and
from the verdict's colour and weight, not from dimming text toward
illegibility.

## 2026-09-05 — Mobile polish

### Phones go edge to edge; touch sizing lives behind `(pointer: coarse)`

Under 720px the outer gutter and the detail card's side chrome go, so
the chart grows from 278px to 341px on a 375px screen. Tap-target
growth is keyed to the pointer, not the width: a phone in landscape and
a touch laptop both get 32px chips padded to a 48px hit area, while a
narrow desktop window keeps the compact 27px chip. Two new semantic
tokens carry those sizes (`size.control`, `size.tap`).

### One finger scrolls past the map on touch screens

Leaflet's one-finger drag is off under a coarse pointer
(`dragging: false`); pinch still pans and zooms, and a one-finger move
shows "Use two fingers to move the map". Reason: the map, the chart and
the brush together took about 500px of an 812px phone screen and none
of them let a thumb scroll through. The chart and the brush keep their
gestures but only claim a touch once it has moved sideways
(`touch-action: pan-y` plus an 8px intent check), so vertical swipes
scroll the page and a tap still places the scrubber.

### Chips behind dropdowns on phones only

Under 720px the view filters open as a dropdown from a `Filters` chip at
the right end of the toolbar, and the timeline's Stations and Jump-to
(Peak / Now) chips open from an `Options` chip at the right end of the
chip row. The two Range chips (All day / Fit) stay in the row: with Fit
now the default they are the range control people reach for first.
Both chips carry a count of settings switched on, the verdict caveat
note is repeated under the toolbar while the filter dropdown is closed,
and both dropdowns close on outside click or Escape. Desktop keeps every
chip inline — the rows fit, and hiding them there would cost
discoverability for nothing.

### Fit is the default range, everywhere

A first visit used to open on 9 AM → 2 AM; it now opens on Fit, the
tightest range around the day's activity, on every screen size. The
9 AM → 2 AM window is still there (both Fit and All day off) and a saved
choice is respected, but the plain window is now stored explicitly
rather than being the unstored fallback.

### `--color-text-tertiary` lightened to a new `gray.350`

`gray.400` measured 3.7:1 on the raised surface, under the 4.5:1
small-text floor, and was the colour of date lines, meta lines, the
chart legend and the map attribution. `gray.350` (#7C8BA1) clears 4.5:1
on every dark surface (5.1 raised, 4.6 overlay). `--color-text-muted`
(2.5:1) is now reserved for disabled controls and decorative separators;
every "modeled, not measured" note moved to tertiary, since that
disclaimer is the one line that must always be legible.

### Global `[hidden] { display: none !important }`

Three components had grown their own `[hidden]` override after the same
bug (an author `display: flex` beating the UA stylesheet's
`display: none`). One global rule replaces them.
