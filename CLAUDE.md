# Event Forecast

A weather-style forecast for crowd impact from major live events in a city. Instead of rain and temperature, it forecasts how busy an area will be because of big concerts and sporting events. Three coordinated views: a multi-day outlook strip (single verdict per day — Quiet / Moderate / Busy / Severe), a city map heatmap of WHERE the crunch lands on the selected day, and a custom canvas/SVG timeline of WHEN it spikes with a scrubber that re-drives the heatmap.

The full product brief is in [`00-overview.md`](00-overview.md). Read it before any non-trivial change.

## Modeled, not measured — HARD RULE

No free data source measures real crowd density or live transit crowding. Everything the product shows — the heatmap, the busyness timeline, transit-load flags — is a **modeled estimate** computed from event metadata (venue, capacity, start time, category) and proximity. Analogous to a weather model, not a thermometer.

This MUST be reflected throughout the product:
- Every UI label that could imply "live data" must be qualified as modeled.
- The legend, tooltips, and timeline labels all carry the modeled framing.
- Never use language like "current crowd level", "live", "right now" — those imply measurement.

## Locked decisions (see `00-overview.md` §3)

- **MVP city:** Toronto (TTC) only. NYC (MTA) and Chicago (CTA) are deferred post-MVP (M5). The pipeline is **city-config-driven from day one** — pipeline code iterates over a configured cities list (length 1 in MVP). No hardcoded "Toronto" in pipeline logic.
- **Major venues only, whitelist-driven:** ~10–20 venues per city, capacity ~5,000+ plus all pro sports stadiums/arenas. An event counts only if its venue is on the whitelist. Small-venue clustering effects are intentionally dropped.
- **Budget:** $0 to build, $0 to run. PredictHQ is a documented future paid upgrade, never required to ship.
- **Modeled estimates are accepted** and must be explicitly labeled.
- **Capacity sourcing:** hybrid, major-venue focused. Claude Code seeds capacities + categories from public data; operator does a sanity-check pass, not data entry.

Veto / corrections go in `10-decisions-log.md` (to be created during the build). Claude Code does NOT renegotiate these decisions.

## Tech Stack

- **Cron / data pipeline:** Python — calls Ticketmaster Discovery API server-side (key hidden), pulls events for a rolling ~7-day window, filters to whitelist, computes per-event impact scores, 15-minute busyness buckets, distance-decay heatmap grid, daily verdict, transit-proximity flags. Writes static JSON artifacts per city per day.
- **API / serving:** PHP on Bluehost shared hosting. Serves the cached JSON, proxies any client-needed Ticketmaster calls, hides the API key, emits required Ticketmaster attribution.
- **Frontend:** vanilla JavaScript + Leaflet. No framework. No build step. No client-side API keys.
- **Hosting:** Bluehost (shared PHP hosting).

## Milestone map

See `00-overview.md` §5 for the full description. MVP path is **M0 → M1 → M2 → M3 → M4 → M6**, configured for Toronto only. **M5** (NYC + Chicago) is post-MVP.

| Milestone | Scope |
|---|---|
| **M0** | Scaffold + data spine. Python cron skeleton, Ticketmaster fetch, caching, raw event list output. |
| **M1** | Scoring + multi-day forecast UI + city-config plumbing. Seed Toronto whitelist. Forecast strip + per-day verdict. |
| **M2** | Leaflet map + distance-decay heatmap. Event markers sized by impact. "Modeled estimate" legend. |
| **M3** | Busyness timeline + avoid windows. Custom canvas/SVG. Time scrubber synced to heatmap. |
| **M4** | Transit layer. Static GTFS only. Stations + lines flagged during dispersal windows. |
| **M6** | Hardening + stretch. Cron scheduling, rate-limit backoff, attribution, error/empty states, deploy verification. |
| **M5** | *(post-MVP)* NYC + Chicago config-add. |

Each milestone has its own doc + Claude Code Desktop prompt in the package (`01-modeling-spec.md`, `02-…` etc. — to be added).

## Running / Testing

Local: the frontend is static — open `index.html` in a browser, or serve from any static server. PHP and the Python cron run on Bluehost; for local PHP work, use `php -S localhost:8080` from the project root.

Until M0 lands, the page renders a placeholder shell (`Forecast loading…`) — useful for verifying the dark-mode token system and the deploy pipeline, not for product validation.

## Key Files

| File | Purpose |
|---|---|
| `00-overview.md` | Single source of truth for product, stack, milestones. Read first. |
| `10-decisions-log.md` | Chronological log of consequential decisions with rationale. |
| `tokens.js` | Two-layer design token system (primitives + semantic). Dark-first. Includes heatmap ramp (M2). |
| `styles.css` | Global styles, references CSS custom properties only. |
| `index.html` | Frontend shell. Forecast strip + detail/map region + footer. Loads Leaflet from unpkg. |
| `app.js` | Entry point. Loads cities, renders strip, drives day selection, delegates map to `map.js`. |
| `map.js` | Leaflet map + custom canvas heat overlay + markers + legend (M2). |
| `timeline.js` | Custom canvas day timeline + scrubber + per-event avoid bands (M3). |
| `pipeline/run.py` | City iterator: fetch → whitelist → score → time curves → write forecast JSON. |
| `pipeline/scoring.py` | Per-event impact score + daily verdict. M1-locked constants. |
| `pipeline/timecurves.py` | Per-event 96-bucket time curve + daily timeline + peak-bucket + sigma. M2-locked. |
| `pipeline/whitelist.py` | Apply venue whitelist to Ticketmaster events (TM id, name, alias). |
| `pipeline/eventfilter.py` | Exclusion filter for non-crowd listings at whitelisted venues (facility tours, parking, packages). Rules in `config/event_filters.json`. |
| `pipeline/ticketmaster.py` | Discovery API client + on-disk cache. M6: jittered backoff + per-city per-day budget reservation; raises `BudgetExhausted` when the day's TM quota is hit. |
| `pipeline/status.py` | M6: writes `data/status.json` (TM freshness, GTFS freshness, zero-event sanity flag per city). Single source of truth for "is the data fresh?". |
| `pipeline/budget.py` | M6: per-city per-day Ticketmaster call counter (`data/cache/ticketmaster/budget.json`). |
| `api/_common.php` | Shared PHP helpers: city allowlist, venues index, JSON response. M6: attribution loaders (TM, OSM+CARTO, per-city GTFS license), status reader, freshness summary. |
| `api/forecast.php` | Per-day forecast JSON, joined with venue lat/lon from `venues.json`. |
| `api/city.php` | Per-city config + list of available forecast days + M6 freshness summary + map / GTFS attribution. |
| `api/cities.php` | Configured cities + all attribution surfaces (TM + OSM/CARTO + per-city GTFS licenses). |
| `api/status.php` | M6: per-city cron freshness surface (TM/GTFS last success, stale flags, zero-event sanity). |
| `DEPLOY.md` | M6: post-deploy verification runbook. |
| `config/cities.json` | List of configured city ids. MVP: `["toronto"]`. |
| `config/event_filters.json` | Global (all-city) exclusion rules for non-crowd TM listings: classification matches + name patterns. Operator-tunable. |
| `config/<city>/city.json` | Per-city config: id, name, tz, bbox, TM city query. |
| `config/<city>/venues.json` | Major-venue whitelist. Single source of truth for venue lat/lon + capacity. |
| `config/<city>/stations_meta.json` | When the reduced station set was last regenerated. Written by `pipeline.gtfs`; `pipeline.run` copies it into `status.json` so GTFS freshness survives clean CI checkouts. |
| `.github/workflows/deploy.yml` | SFTP deploy to Bluehost on push to `main`. |
| `.github/workflows/refresh.yml` | Scheduled data refresh (GitHub Actions, 4×/day): runs `pipeline.run`, FTP-pushes `data/` to Bluehost. Needs the `TICKETMASTER_API_KEY` repo secret. |
| `.github/workflows/refresh-gtfs.yml` | Weekly GTFS refresh: runs `pipeline.gtfs`, commits the regenerated station set + meta back to `main`. |

This table expands as milestones land (timeline UI, GTFS data, etc.).

## Rules

- **Server-side API keys only.** Ticketmaster (and any future paid keys) live in server-only config — never `process.env` on the client, never inline in JS, never in a committed config file. Reference `api/config.example.php` for the shape; the real `api/config.php` is gitignored.
- **No Chart.js or generic charting libraries.** The busyness timeline is a **hand-built canvas/SVG visualization** per overview §7. This is a design decision, not a performance one — do not refactor to a library.
- **Major-venue whitelist is THE filter.** Don't add small-venue clustering, density heuristics, or "discover" logic. An event in scope means it's on the whitelist.
- **Ticketmaster attribution is required** wherever events are rendered (event markers, detail rail, timeline annotations). Free-tier ToS.
- **City config drives the pipeline.** No hardcoded `"Toronto"` in pipeline code — the pipeline iterates over a configured cities list. MVP just has one entry.
- **Static GTFS only.** GTFS-RT (realtime) is explicitly out of scope; some agencies require keys, and it's not part of the modeling spec.
- **Default map tiles: OpenStreetMap.** Mapbox / MapTiler keys are optional notes, not requirements.

## Design Tokens

The project uses a centralized design token system defined in `tokens.js` with **dark-first** theming. Light is the alternate, not the default — the product is a dark-mode data-visualization tool per overview §7.

`tokens.js` exposes two interfaces:
- **`window.TOKENS`** — JS object with `primitives` and `semantic` layers, plus `themes.dark` / `themes.light`.
- **CSS custom properties** — injected on `:root` (dark) with `[data-theme="light"]` overrides.

### Rules

- **All code must use tokens** for colors, spacing, sizing, typography, border-radius, shadows, opacity, and transitions. Never hardcode these values.
- **Use semantic tokens first** (`var(--color-text-primary)` or `TOKENS.semantic.color.text.primary`). Fall back to primitives only when no semantic token exists.
- **Before adding any new design value**, check `tokens.js` first. If the value exists, use it. If not, add a new primitive and semantic token before using it.
- **All spacing and sizing must use the 4px base grid:** 1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 80, 96, 128. Off-grid values are not allowed.
- **Breakpoints and z-index are intentionally NOT tokenized.** They have implicit ordering dependencies. Do not refactor without explicit approval.
- **Verdict colors come from semantic tokens.** Use `--color-verdict-quiet|moderate|busy|severe` — single source of truth across forecast strip, heatmap legend, timeline bands.

### Usage — CSS

```css
.my-element {
  color: var(--color-text-secondary);
  background: var(--color-bg-surface);
  padding: var(--spacing-md);
  border-radius: var(--radius-sm);
}
```

### Usage — JavaScript

```javascript
var t = window.TOKENS;
element.style.color = t.semantic.color.text.secondary;
```

### Tinted variants of token colors

When the same hue is needed at a lower alpha — a band fill, a swatch, a chip border, a gradient stop, a translucent surface — **route it through the token**. Never reach for a raw `rgba(R, G, B, A)` literal whose `(R, G, B)` mirrors a token color. That bypasses the token system: a future palette change won't propagate.

- **What NOT to do:** `border-color: rgba(56, 189, 248, 0.35);` — even if `56, 189, 248` is `--color-status-info` today.
- **What TO do:** `border-color: color-mix(in srgb, var(--color-status-info) 35%, transparent);`

For canvas (where `color-mix` isn't accepted by `ctx.fillStyle` / `ctx.strokeStyle`), use a token-driven helper that takes a token-sourced hex and produces an `rgba` string — see `hexToRgba()` in `timeline.js`. The hex MUST come from `tokenColor()`, never from a literal in product code.

The only place a raw `rgba(...)` literal is allowed is inside `tokens.js` itself, where it defines a semantic token (e.g. `border.subtle = 'rgba(255, 255, 255, 0.06)'`).

If a specific tint is used in **3+ rules across files**, promote it to a semantic token before using it again (e.g. `--color-highlight` was added when the decorative white-on-dark gloss appeared in four gradient backgrounds).

## Environment

- **Mac:** `gh` CLI is installed via Homebrew at `/opt/homebrew/bin/gh`.
- **Windows:** `gh` CLI is installed at `/c/Program Files/GitHub CLI/gh.exe` — use this full path since it's not on the bash PATH.

## Repo Hygiene

### On session start
- Run `git status`, `git stash list`, and `git branch -a` to check for uncommitted changes, lingering stashes, stale branches, or divergence from remote.
- Flag any issues to the user before starting work.

### Always branch for non-trivial work
Before making any non-trivial code change, auto-create a feature branch off `main`. Do not work directly on `main` for substantive features, bug fixes, or refactors.

Direct-to-main is only acceptable for genuinely minor changes: typo fixes, one-line tweaks, comment-only edits, README touch-ups, config bumps.

### After push or PR
- Run `git status`, `git stash list`, `git branch -a`, and `git fetch --prune`.
- Flag any stale branches, uncommitted changes, or divergence.
- Ask the user what they'd like to work on next.

## "Push to prod"

When the user says **"push to prod"** or **"ptp"**, execute this full pipeline:

1. **Commit** any uncommitted changes on the current branch (if any).
2. **Push** the branch to GitHub (`git push -u origin <branch>`).
3. **Create a PR** via `gh pr create`.
4. **Merge the PR** immediately via `gh pr merge --squash` — squash so the merge commit title on `main` is the PR title.
5. **Switch to main** and pull (`git checkout main && git pull`).
6. **Delete the feature branch** locally (`git branch -d <branch>`).
7. **Prune** stale remote refs (`git fetch --prune`).
8. Run the standard post-push hygiene checks.

If already on `main` with uncommitted changes AND the change qualifies as minor, commit and push directly — no PR needed. Otherwise, move the uncommitted work to a new branch first, then run the full pipeline.

## Deployment

- **Host:** Bluehost (shared PHP hosting).
- **Repo:** [github.com/ryanrwang/event-forecast](https://github.com/ryanrwang/event-forecast)
- **Deploy:** GitHub Actions SFTP on push to `main` → `public_html/apps/eventforecast/`.
- **Required secrets:** `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD` (same as the other Clearful apps) + `TICKETMASTER_API_KEY` (used by the scheduled refresh workflow).
- **Not deployed:** all `.md` files (including `00-overview.md` and milestone docs), `cache/`, `data/cache/`, `.claude/`, Python `__pycache__/` and `.venv/`, `node_modules/`.
- **Data refresh:** GitHub Actions — `refresh.yml` (4×/day) runs the Python pipeline on GitHub runners and FTP-pushes the generated `data/` tree to Bluehost; `refresh-gtfs.yml` (weekly) regenerates the station set and commits it back to `main`. No Python runs on Bluehost.
- Do not commit `cache/`, `data/cache/`, `error_log`, or any `api/config.php` / `includes/config.php` — these are gitignored.
