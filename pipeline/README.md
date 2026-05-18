# Event Forecast — Python pipeline (M0)

Fetches Ticketmaster Discovery events for a configured city in a rolling
~7-day window, caches the responses, applies a venue whitelist, and writes
raw JSON artifacts to `data/<city>/`.

This is the **data spine only**. No scoring, no UI. Scoring and the
multi-day forecast UI land in M1.

## Setup

```powershell
# from repo root
python -m venv .venv
.venv\Scripts\Activate.ps1     # PowerShell
# .venv/bin/activate           # bash / zsh
pip install -r requirements.txt
```

## Credentials

The Ticketmaster API key is read from (in priority order):

1. `$TICKETMASTER_API_KEY` env var
2. `secrets/ticketmaster.env` (gitignored), as `TICKETMASTER_API_KEY=<your_key>`

The `secrets/` directory is gitignored and excluded from the Bluehost
deploy workflow. Never commit the key.

## Run

```powershell
# Default: city=toronto, 7-day window, uses cache (6h TTL) when fresh
python -m pipeline.run

# Force a refresh (still writes to cache)
python -m pipeline.run --refresh

# Explicit city (only `toronto` exists in M0; M1 introduces the cities list)
python -m pipeline.run --city toronto
```

## Outputs

```
data/<city>/raw_events.json                # full unfiltered Ticketmaster response set
data/<city>/YYYY-MM-DD/raw_events.json     # whitelist-matched events, one file per day
data/cache/ticketmaster/<sha1>.json        # per-request response cache
```

All of `data/` is gitignored — the pipeline regenerates it from configs + API.

## Config

- `config/<city>/city.json` — name, country/state codes, timezone, Ticketmaster query params.
- `config/<city>/venues.json` — the venue whitelist. **M0 ships a 4-entry
  Toronto stub with placeholder capacities/categories** so M1's seeding and
  sanity-check pass has something to replace. Matching is normalized name
  (case- and punctuation-insensitive). Unmatched venues are logged so the
  operator can see candidates for the M1 whitelist.

## Acceptance check (M0)

1. First run hits the API, writes `data/toronto/raw_events.json`, and writes
   a per-day file for each of the next 7 days.
2. Second run within 6 hours logs `[cache hit]` for every page.
3. Replacing `config/toronto/venues.json` with `[]` and re-running with
   `--refresh` writes per-day files with `event_count: 0`.
4. With the key cleared from both env and `secrets/ticketmaster.env`,
   the run exits with a clear message (no stack trace).
5. `git status` shows no tracked changes under `secrets/` or `data/`.

## Rate limits and paging

- 250 ms inter-request delay (well under the 5 req/s free tier).
- Exponential backoff on `429` / `5xx`, honoring `Retry-After`, max 5 retries.
- Discovery API's 1000-item hard cap: if a single window query reports
  `totalElements > 1000`, the client falls back to 7 per-day queries.
  Toronto in a 7-day window is unlikely to trigger this.
