# Deploy Verification — Event Forecast

Short, repeatable runbook the operator follows **after every deploy** to
confirm the production environment on Bluehost is healthy. The list is
copy-pasteable and biased toward signal — no narrative, just commands +
the value the operator should see.

Replace `eventforecast.example.com` with the actual production domain.

---

## 1. Confirm the GitHub Actions deploy succeeded

```bash
# From a local clone of github.com/ryanrwang/event-forecast
gh run list --workflow=deploy.yml --limit 1
```

Expect: `completed  success  Deploy to Bluehost  main  push`.

If `failure`, open the run and read the SFTP step log before continuing.

## 2. Confirm the deploy did NOT upload secrets or data

The deploy workflow excludes `secrets/**` and `data/**`. Re-confirm both
excludes are still present in `.github/workflows/deploy.yml`:

```bash
grep -E '^\s+(secrets|data|api/config\.example)' .github/workflows/deploy.yml
```

Expect: at least these three lines:

    secrets/**
    data/**
    api/config.example.php

Note: `api/config.php` (the real one) is gitignored, so it's never in
the git tree to be uploaded. Verify on Bluehost in step 4 below.

## 3. Confirm the cron entries

SSH into Bluehost or open cPanel → "Cron Jobs". The MVP needs three:

| Cadence | Command (replace path with your Bluehost path) |
|---|---|
| Every 30 minutes | `cd ~/public_html/apps/eventforecast && /home/USER/virtualenv/bin/python -m pipeline.run --window-days 1 >> ~/cron-eventforecast.log 2>&1` |
| Every 3 hours    | `cd ~/public_html/apps/eventforecast && /home/USER/virtualenv/bin/python -m pipeline.run --window-days 7 >> ~/cron-eventforecast.log 2>&1` |
| Weekly (Sun 03:30) | `cd ~/public_html/apps/eventforecast && /home/USER/virtualenv/bin/python -m pipeline.gtfs >> ~/cron-eventforecast.log 2>&1` |

After saving, tail the log to confirm it's firing:

```bash
tail -f ~/cron-eventforecast.log
```

Expect: a `[fetch] city=toronto window=...` line within the cadence
above. If you see no new lines after 35 minutes, the cron is not
configured correctly.

## 4. Confirm the API key is server-side only and absent from client

```bash
# On Bluehost, confirm the secret file exists and is NOT world-readable.
ls -la ~/public_html/apps/eventforecast/secrets/
# Expect: ticketmaster.env  -rw------- (or -rw-r-----)
```

Then, from a workstation, confirm the key never reaches the browser:

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

## 5. Confirm JSON artifacts are being written for every configured city

```bash
# On Bluehost
ls -la ~/public_html/apps/eventforecast/data/toronto/
# Expect: a raw_events.json + at least one YYYY-MM-DD/ subdir per
# configured day. The subdirs should be from TODAY in America/Toronto.

cat ~/public_html/apps/eventforecast/data/status.json | head -40
# Expect: schema_version=1, cities.toronto.ticketmaster.stale=false,
# last_success_at within the last hour.
```

## 6. Confirm the PHP endpoints respond with today's data

```bash
TODAY=$(TZ=America/Toronto date +%F)

curl -s https://eventforecast.example.com/api/cities.php | head -c 400
# Expect: {"cities":[{"id":"toronto",...}], "attribution":..., "map_attribution":..., "gtfs_attributions":...}

curl -s https://eventforecast.example.com/api/city.php?id=toronto | head -c 400
# Expect: city, days (today's date appears), freshness.tm.stale=false,
# freshness.gtfs.stale=false.

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
# Force the stale-data banner: temporarily edit status.json to set
# ticketmaster.stale=true, reload, confirm the banner renders with a
# "last successful refresh at <timestamp>" message. Revert.
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
- **Step 3 fails:** cron isn't firing. Confirm Bluehost cPanel cron is
  enabled for the account; confirm the python path resolves (`which python`).
- **Step 4 fails:** **stop everything**. Rotate the Ticketmaster key
  via the developer portal, redeploy with the new key in
  `secrets/ticketmaster.env` (server-side only), then re-verify.
- **Step 5–6 fail:** data isn't being written. Run the pipeline by hand
  (`python -m pipeline.run --city toronto --refresh`) and inspect the
  log; look for whitelist mismatches or fetch failures.
- **Step 7 fails:** attribution copy regressed. Restore it before
  announcing — Ticketmaster, OSM, and the GTFS licence are contractual.
- **Step 8 surfaces an issue:** the relevant designed state needs work.
