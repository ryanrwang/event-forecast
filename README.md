# Event Forecast

A weather-style forecast for crowd impact from major live events in a city. Instead of rain and temperature, it forecasts how busy an area will be because of big concerts and sporting events — a multi-day outlook, a city map heatmap of where the crunch lands, and a custom timeline of when to avoid which streets and transit stations.

Forecasts are **modeled estimates** computed from event metadata (venue, capacity, start time, category) and proximity — analogous to a weather model, not a thermometer. Never a measurement of live crowd density.

Built with: Python cron, PHP, vanilla JS + Leaflet. Hosted on Bluehost.

## Documentation

- [`00-overview.md`](00-overview.md) — product brief, locked decisions, architecture.
- [`CLAUDE.md`](CLAUDE.md) — project rules and conventions.
- Per-milestone docs land in `01-…`, `02-…` etc. as each milestone ships.

## Python pipeline (M0+)

The data spine lives in [`pipeline/`](pipeline/). See [`pipeline/README.md`](pipeline/README.md) for setup and run instructions. Output JSON artifacts are written to `data/<city>/` (gitignored).
