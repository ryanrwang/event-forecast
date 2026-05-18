# Event Forecast — Build Overview

Read this first. This is the single document that explains what the product is, how it is built, and the order it gets built in. Every other file in this package either expands one section of this document or is the prompt for one milestone of the build.

## 1. What the product is

Event Forecast is a weather-style forecast for crowd impact from major live events in a city. Instead of rain and temperature, it forecasts how busy an area will be because of big concerts and sporting events.

The user interaction has three coordinated views:

A multi-day outlook — a weather-app-style strip of the next several days, each day showing a single crowd verdict (Quiet, Moderate, Busy, Severe).

For a selected day, a city map with a heatmap showing WHERE it will be busy and event markers for the venues driving the impact.

For that same day, a custom timeline showing WHEN it will be busy, with a time scrubber that re-drives the heatmap so the user can see how the busy zone moves across the day. Streets and transit stations near major events during arrival and dispersal windows are surfaced as a WHAT-to-avoid list.

The core question the product answers is: "Is there a major game or concert that will clog downtown before or after the event, and when and where should I avoid?" The multi-day look-ahead is the headline value, not a side feature. The weather-forecast analogy is literal and central.

## 2. Honesty constraint — modeled, not measured

No free data source measures real crowd density or live transit crowding. Everything the product shows — the heatmap, the busyness timeline, transit load flags — is a modeled estimate computed from event metadata (venue, capacity, start time, category) and proximity, analogous to a weather model rather than a thermometer.

This must be reflected throughout the product: in every doc, in the UI legend, in the timeline labels, and in any tooltip that could be misread as "live data." Never imply measured or realtime crowd levels.

## 3. Locked decisions

These are decided. The build is not allowed to renegotiate them; the operator may veto an assumption (see 10-decisions-log.md), but Claude Code should not.

Cities. MVP ships Toronto (TTC) only. New York (MTA) and Chicago (CTA) are a deferred post-MVP expansion. The architecture is city-config-driven from day one — the MVP pipeline iterates over a configured cities list (length one in MVP) so adding NYC and Chicago later is a config-add, not a refactor.

Major venues only, whitelist-driven. Inclusion guideline is roughly 5,000+ capacity, plus all professional sports stadiums and arenas and major amphitheatres or festival grounds regardless of seated number. The whitelist (~10 to 20 venues per city) IS the filter: an event counts only if its venue is on the list. Small-venue clustering effects are intentionally dropped. This is an accepted, documented limitation.

Budget: $0 to build and $0 to run. PredictHQ is documented as a future paid upgrade only and is never required to go live.

Modeled estimates are accepted and must be explicitly labeled in the UI and in the docs.

Hybrid prompt approach: the modeling spec (the "intelligence") is embedded verbatim as exact spec in the milestone prompts; the boilerplate parts (scaffolding, fetch, caching, cron, UI plumbing) are directive — goals and constraints, with internals left to Claude Code.

Stack: Python cron job precomputes everything, writes static JSON artifacts, PHP serves the JSON and proxies and hides the Ticketmaster API key server-side, frontend is vanilla JavaScript plus Leaflet. Hosted on Bluehost. No build tooling, no framework, no client-side API keys.

Capacity sourcing is hybrid, major-venue focused. Claude Code seeds the major-venue whitelist with capacities and categories (these are public and stable for the venues in scope); the operator does a sanity-check pass rather than manual data entry.

A separate concept prototype has already been prompted independently (single city, fixture data, validates the modeling spec and the visual concept). The prototype is an OPTIONAL pre-build validation step. The build's modeling spec is the prototype's baseline and is explicitly tunable from anything learned by running the prototype.

## 4. Architecture

All geospatial and time-bucketing math is precomputed. Bluehost shared hosting cannot do per-request geospatial compute, and the product does not need to: forecasts change at the cadence of new event listings, not per page view.

Python cron, on a schedule, for each city: calls the Ticketmaster Discovery API server-side (key hidden), pulls events for a rolling ~7-day window, filters to the venue whitelist, then computes per day the per-event impact scores, the 15-minute busyness buckets, the distance-decay heatmap grid, the daily verdict, and the transit-proximity flags. Output is written as static JSON artifacts per city per day.

PHP layer serves the cached JSON, handles refresh and proxying, hides the Ticketmaster API key, and emits the required Ticketmaster attribution.

Frontend (vanilla JS + Leaflet) renders: a city selector (conditionally rendered — hidden in MVP because only Toronto is configured, appears automatically if a future M5 configures NYC and Chicago), the multi-day forecast strip, the map with heatmap, event markers, and transit-flag markers, the custom canvas/SVG busyness timeline with a time scrubber, and a detail rail. App state is "selected city + selected day + selected time." Selecting a day swaps the day's JSON into view; the scrubber drills into time within the day.

### External data inputs

Ticketmaster Discovery API: free tier; deep-paging hard cap of 1,000 items per query (page around it by date and venue narrowing); rate limits are ~5 requests/second and ~5,000 calls/day on the public tier (build in backoff and treat the docs as authoritative); attribution is required wherever events are shown; local caching is mandatory — never hit the API per page view. Query by city plus stateCode and countryCode plus a date range.

GTFS: only static feeds are used (schedule + station locations + line associations), not realtime. Static GTFS for the TTC, MTA, and CTA are open downloads and require no API key or account. (Realtime GTFS-RT for some agencies does require keys — that is explicitly out of scope.)

Map tiles: OpenStreetMap raster tiles by default (free, no key). Mapbox or MapTiler free tier is an optional nicer dark basemap but needs a key — leave as an optional note, default to OSM.

### Diagram (mental model)

    Ticketmaster Discovery API ──┐
                                 ├──> Python cron (per city, scheduled)
    Static GTFS (TTC/MTA/CTA) ───┘            │
                                              ▼
                                       per-city, per-day
                                       static JSON artifacts
                                              │
                                              ▼
                                       PHP serves + proxies + attribution
                                              │
                                              ▼
                                       Vanilla JS + Leaflet frontend
                                       (forecast strip / map+heatmap /
                                        canvas timeline / detail rail)

## 5. Milestone map

The MVP path is M0 → M1 → M2 → M3 → M4 → M6, configured for Toronto only. M5 is a post-MVP expansion. Each milestone has a clear validation gate to check before moving on; each builds on the prior milestone's outputs.

M0 — Scaffold and data spine. Project structure, Python cron skeleton, Ticketmaster Discovery fetch for Toronto (server-side, key hidden), caching layer, raw event list output. Validate live data shape and that whitelist filtering is wired (whitelist may be a stub here). Single-city bootstrap — generalization to a configured cities list happens in M1.

M1 — Scoring, multi-day forecast UI, and city-config-driven plumbing. Seed Toronto major-venue whitelist with capacities and categories; implement the impact score; build the weather-app-style multi-day forecast strip and per-day verdict. Also introduce the city-iterator pattern (pipeline reads a cities config list, MVP has one entry: Toronto), the city-driven PHP routing, and a frontend city selector that hides itself when only one city is configured. This is the whitelist sanity-check point for the operator.

M2 — Map and distance-decay heatmap. Dark Leaflet map, event markers sized by impact, time-aware radial heatmap, "modeled estimate" legend. Code reads from city config; functionally only Toronto in MVP.

M3 — Busyness timeline and avoid windows. Custom canvas/SVG day timeline with a time scrubber synced to the heatmap; peak window and avoid windows marked; detail rail.

M4 — Transit layer. Iterate over configured cities' static GTFS sources, reduce to stations near whitelisted venues with line associations, flag stations and lines during dispersal windows, render on the map and in the rail. Modeled, labeled. In MVP only TTC is ingested; the generic shape supports MTA and CTA when M5 lands.

M6 — Hardening and stretch. Cron scheduling and refresh cadence, Ticketmaster rate-limit backoff plus required attribution, error and empty states, deploy verification. Stretch (explicitly optional): street-snapped heatmap; a lightweight "was it actually busy?" feedback hook. M6 is the last MVP milestone — the product is shippable when M6 passes.

M5 — Post-MVP expansion: NYC and Chicago. Seed NYC and Chicago whitelists, place the MTA and CTA static GTFS source URLs in their city configs, sanity-check Chicago timezone behavior. Because the architecture is already city-config-driven, M5 is a config-add, not a refactor.

Each milestone is encoded as its own doc in this package, with an embedded plaintext prompt for Claude Code Desktop.

## 6. Manual dependencies (operator)

1. Create a free Ticketmaster developer account and generate a Discovery API key.
2. Sanity-check the major-venue whitelist and capacities that Claude Code seeds for Toronto — a review pass, not data entry. (For post-MVP M5, repeat for NYC and Chicago.)
3. Obtain the TTC static GTFS feed file from the City of Toronto Open Data Portal (or confirm its URL so the pipeline can auto-fetch). No keys or accounts required. (For post-MVP M5, also obtain the MTA and CTA static feeds.)
4. Bluehost deploy: upload code, configure PHP, set up the Python cron job, place the API key in server-side config (never client-side).
5. Lightweight upkeep: refresh GTFS feeds a few times a year; re-check the whitelist if a venue or capacity changes.

Full ordering, with milestone insertion points and gates, is in 09-setup-guide.md — which is now an interactive Cowork coach prompt rather than a static runbook (though it is still readable as one).

## 7. Visual design direction

Dark mode, sleek, heavy data visualization. Treated as a deliberately designed product, not a default dashboard. The visual brief is:

A cohesive dark aesthetic with depth and atmosphere — layered surfaces, subtle texture or gradient, considered shadows. Not flat grey slabs.

One dominant dark palette with a single sharp accent for intensity and alerts. Avoid the generic purple-on-dark "AI" look.

Distinctive typography: a characterful display face for verdicts and headlines paired with a clean technical or mono face for data. Do not use Inter, Roboto, Arial, or system defaults.

One well-orchestrated entrance (staggered reveal); restrained, high-impact motion; smooth transitions on day or time change. No scattered micro-animations.

The busyness timeline must be a bespoke hand-built canvas/SVG visualization — NOT Chart.js or any generic charting library.

Data density done with precision: the UI should read like an instrument.

The forecast strip is the headline element — give it the most design care.

## 8. PredictHQ — paid upgrade path (deferred)

PredictHQ is a paid event-intelligence provider. It is not part of the $0 build and is never required to go live. If the operator later pays for PredictHQ, it would swap in at exactly one place in the pipeline:

The Python cron's "fetch events for a city in a rolling ~7-day window" step. The downstream filter (whitelist), the impact/time-curve/heatmap math, the JSON artifact shape, PHP, and the frontend would be unchanged. PredictHQ's pre-computed predicted-attendance and impact ratings would either replace or augment the per-event impact score; the rest of the modeling spec stays.

The decisions log notes this so the upgrade can be done without re-architecting the system.

## 9. How to use this package

1. Read this overview.
2. Read 01-modeling-spec.md — the canonical math.
3. Open 09-setup-guide.md. It is an interactive Cowork coach prompt: paste the block between BEGIN COACH PROMPT and END COACH PROMPT into a fresh Cowork session with this folder selected. Cowork will then walk you through each setup step, hand you the right milestone prompt to paste into Claude Code Desktop at each point, and verify the validation gates by reading project files.
4. After each milestone passes its validation gate, Cowork advances to the next step. The MVP is shippable when M6 (the sixth and final MVP milestone) passes. M5 (NYC + Chicago) is post-MVP and triggers only if you opt in.
5. 10-decisions-log.md is the place to record any veto on a flagged assumption or any tuning corrections discovered during the build.
