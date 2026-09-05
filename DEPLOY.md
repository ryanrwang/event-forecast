# Deploy Verification — Event Forecast

Short, repeatable runbook the operator follows **after every deploy** to
confirm the production environment on Bluehost is healthy. The list is
copy-pasteable and biased toward signal — no narrative, just commands +
the value the operator should see.

Replace `eventforecast.example.com` with the actual production domain.

**Required GitHub Actions secrets** (repo Settings → Secrets and
variables → Actions):

| Secret | Used by | Purpose |
|---|---|---|
| `FTP_SERVER` / `FTP_USERNAME` / `FTP_PASSWORD` | `deploy.yml`, `refresh.yml` | SFTP to Bluehost |
| `TICKETMASTER_API_KEY` | `refresh.yml` | Ticketmaster Discovery API (Consumer) key — server-side only, never shipped to the client |

---

## 1. Confirm the GitHub Actions deploy succeeded

```bash
# From a local clone of github.com/ryanrwang/event-forecast
gh run list --workflow=deploy.yml --limit 1
```

Expect: `completed  success  Deploy to Bluehost  main  push`.

If `failure`, open the run and read the SFTP step log before continuing.

## 2. Confirm the deploy did NOT upload secrets or data

The deploy workflow excludes `secrets/*.env` / `secrets/*.key` and
`data/**`. Re-confirm the excludes are still present in
`.github/workflows/deploy.yml`:

```bash
grep -E '^\s+(secrets|data|api/config\.example)' .github/workflows/deploy.yml
```

Expect: at least these four lines:

    data/**
    secrets/*.env
    secrets/*.key
    api/config.example.php

Note: `api/config.php` (the real one) is gitignored, so it's never in
the git tree to be uploaded. Verify on Bluehost in step 4 below.

`history/` is deliberately NOT in that exclude list. It is committed
source as far as the deploy is concerned, and shipping it on a normal
push is how the archive reaches a freshly rebuilt server. Do not add it
to the excludes.

## 3. Confirm the scheduled refresh workflow

Data generation runs on GitHub Actions, not on Bluehost. Two workflows:

| Workflow | Cadence | What it does |
|---|---|---|
| `refresh.yml` | 4×/day (10:00, 15:00, 20:00, 01:00 UTC) + manual | Runs `pipeline.run --window-days 7`, FTP-pushes `data/` to Bluehost |
| `refresh-gtfs.yml` | Weekly (Sun 08:00 UTC) + manual | Runs `pipeline.gtfs`, commits the regenerated station set back to `main` |

Check the latest refresh run:

```bash
gh run list --workflow=refresh.yml --limit 3
```

Expect: `completed  success` within the last ~6 hours. If `failure`,
open the run (`gh run view <run-id> --log`) and read the failing step —
the pipeline step logs `[fetch] city=toronto window=...` lines just like
the old cron did.

To trigger a refresh immediately instead of waiting for the next slot
(e.g. right after a deploy, or to seed fresh data):

```bash
gh workflow run refresh.yml
```

or open the repo's **Actions** tab → *Refresh forecast data* → **Run
workflow**. Times are UTC and fixed — in winter (EST) each slot lands
one hour earlier in Toronto local time than in summer.

## 4. Confirm the API key is server-side only and absent from client

The Ticketmaster key lives in the `TICKETMASTER_API_KEY` GitHub Actions
secret — the pipeline runs on GitHub runners, so Bluehost no longer
needs `secrets/ticketmaster.env` at all (a leftover copy is harmless but
can be deleted; the `secrets/.htaccess` deny-all stays either way).

From a workstation, confirm the key never reaches the browser:

```bash
# 1. The configured-cities endpoint must not echo any API key.
curl -s https://eventforecast.example.com/api/cities.php | grep -i apikey
# Expect: NO output.

# 2. The forecast endpoint must not echo any API key.
curl -s "https://eventforecast.example.com/api/forecast.php?city=toronto&date=$(date -I)" \
  | grep -i apikey
# Expect: NO output.

# 3. The HTML, JS, and CSS bundles must not contain any API key.
curl -s https://eventforecast.example.com/ \
     https://eventforecast.example.com/app.js \
     https://eventforecast.example.com/map.js \
     https://eventforecast.example.com/timeline.js \
     https://eventforecast.example.com/tokens.js \
     https://eventforecast.example.com/styles.css \
  | grep -i -E 'apikey|ticketmaster_api'
# Expect: NO output.

# 4. The secrets folder must NOT be web-reachable.
curl -s -o /dev/null -w "%{http_code}\n" \
  https://eventforecast.example.com/secrets/ticketmaster.env
# Expect: 403 or 404. Anything else means the file is downloadable —
# rotate the key immediately.
```

## 5. Confirm JSON artifacts are being uploaded for every configured city

The refresh workflow FTP-pushes the generated `data/` tree after each
run (it never uploads `data/cache/`).

```bash
# On Bluehost
ls -la ~/public_html/apps/eventforecast/data/toronto/
# Expect: a raw_events.json + a YYYY-MM-DD/ subdir per configured day,
# starting at TODAY in America/Toronto. Older date folders may linger
# from before the Actions migration — the PHP layer filters them out,
# and they can be deleted via cPanel File Manager for tidiness.

cat ~/public_html/apps/eventforecast/data/status.json | head -40
# Expect: schema_version=1, cities.toronto.ticketmaster.last_success_at
# within the last several hours (the refresh cadence is 4×/day).
```

## 5b. Confirm the day archive is accumulating

`history/` is the compact per-day archive. Unlike `data/`, it accumulates
and is committed back to `main` by the refresh workflow — it is the only
pipeline output that cannot be regenerated, because Ticketmaster serves
upcoming events only.

```bash
# On Bluehost
ls -la ~/public_html/apps/eventforecast/history/toronto/
# Expect: one YYYY-MM.json per month since the feature shipped, roughly
# 140 KB per full month. Months must never disappear — if one does, the
# emptiness guard in refresh.yml failed to stop a bad mirror.
```

```bash
# On GitHub: the archive should be committed, not only uploaded
git log --oneline -- history | head -5
# Expect: "chore: archive forecast day records" commits, about one a day.
# Four a day means the record is churning; none for over a day means the
# archive step is being skipped — check the "Verify archive before
# upload" step's warning in the workflow log.
```

Then confirm the API and the calendar agree:

```bash
curl -s "https://<domain>/apps/eventforecast/api/city.php?id=toronto"   | python3 -c "import json,sys; print(json.load(sys.stdin)['history_months'])"
# Expect: the same month list as the directory above. An empty list here
# hides the 7 days / Month switch entirely, which is the correct state
# before the first archive run and a bug after it.
```

## 6. Confirm the PHP endpoints respond with today's data

```bash
TODAY=$(TZ=America/Toronto date +%F)

curl -s https://eventforecast.example.com/api/cities.php | head -c 400
# Expect: {"cities":[{"id":"toronto",...}], "attribution":..., "map_attribution":..., "gtfs_attributions":...}

curl -s https://eventforecast.example.com/api/city.php?id=toronto | head -c 400
# Expect: city; days STARTING AT today (America/Toronto), length ≤ 7;
# freshness.tm.stale=false with last_success_at within the last several
# hours; freshness.gtfs.stale=false. Staleness is recomputed against the
# clock on every request, so a stalled refresh workflow flips these to
# true on its own within ~12h (TM) / 14 days (GTFS).

curl -s "https://eventforecast.example.com/api/forecast.php?city=toronto&date=$TODAY" \
  | jq '.verdict, .event_count, .peak_bucket, .attribution'
# Expect: one of Quiet/Moderate/Busy/Severe, integer event count,
# integer peak bucket, "Event discovery powered by Ticketmaster."

curl -s https://eventforecast.example.com/api/status.php | jq '.cities.toronto'
# Expect: ticketmaster.stale=false, gtfs.stale=false, forecast.zero_event_run=false.
```

## 7. Confirm both attributions are present on rendered pages

Open `https://eventforecast.example.com/` in a browser and confirm:

1. **Footer** contains:
   - "Event discovery powered by Ticketmaster." (linked to developer.ticketmaster.com)
   - "Map: OpenStreetMap contributors · CARTO basemaps" (linked)
   - "Transit: TTC GTFS via City of Toronto Open Data (Open Data Licence v1.0)" (linked)
2. **Map view** (select any day in the strip): the Leaflet attribution
   in the bottom-right shows the OpenStreetMap + CARTO credits.
3. **Map legend** (top-right of map): "Modeled estimate — Not measured."
4. **Event popups** (click any event marker): "Event powered by
   Ticketmaster." in the popup footer.

If any of those four are missing, **do not announce the deploy** —
correct the issue first.

## 8. Smoke-test the designed empty + stale states

These are easy to forget; verify them once after the first deploy.

```bash
# Force the empty-day state: temporarily remove today's forecast.json
# on Bluehost and reload the page.
mv ~/public_html/apps/eventforecast/data/toronto/$TODAY/forecast.json \
   ~/public_html/apps/eventforecast/data/toronto/$TODAY/forecast.json.bak
# In the browser: the strip should render a designed "No major events
# meet the whitelist for Toronto..." message (not a blank pane).
# When done:
mv ~/public_html/apps/eventforecast/data/toronto/$TODAY/forecast.json.bak \
   ~/public_html/apps/eventforecast/data/toronto/$TODAY/forecast.json
```

```bash
# Force the stale-data banner: staleness is recomputed from timestamps
# on every request (the stored 'stale' boolean is ignored), so edit
# status.json to set ticketmaster.last_success_at to a few days ago,
# reload, and confirm the banner renders with a "last good fetch at
# <timestamp>" message. Revert (or just wait — the next scheduled
# refresh overwrites status.json).
```

## 9. Post-verification hygiene

Once steps 1–8 pass:

```bash
git fetch --prune
git status        # expect: clean
git stash list    # expect: empty
git branch -a     # expect: only main + remotes/origin/*
```

If anything is off, fix it before declaring the deploy verified.

---

## What to do if a step fails

- **Step 1–2 fail:** the deploy itself didn't ship. Re-run; check secrets.
- **Step 3 fails:** the refresh workflow isn't succeeding. Open the
  failing run's log in the Actions tab. Common causes: missing/expired
  `TICKETMASTER_API_KEY` secret (pipeline step fails fast with a
  readable message), FTP secret drift, or a Ticketmaster outage.
- **Step 4 fails:** **stop everything**. Rotate the Ticketmaster key
  via the developer portal, update the `TICKETMASTER_API_KEY` GitHub
  secret, then re-verify.
- **Step 5–6 fail:** data isn't being generated or uploaded. Trigger
  `gh workflow run refresh.yml` and read the run log; or run the
  pipeline by hand locally (`python -m pipeline.run --city toronto
  --refresh`) and look for whitelist mismatches or fetch failures.
- **Step 7 fails:** attribution copy regressed. Restore it before
  announcing — Ticketmaster, OSM, and the GTFS licence are contractual.
- **Step 8 surfaces an issue:** the relevant designed state needs work.
