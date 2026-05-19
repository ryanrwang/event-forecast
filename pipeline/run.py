"""Event Forecast pipeline entrypoint.

Usage:
    python -m pipeline.run                # iterate every city in config/cities.json
    python -m pipeline.run --city toronto # one-off run for a specific city
    python -m pipeline.run --refresh      # bypass cache reads
    python -m pipeline.run --window-days 7

Writes per configured city:
    data/<city>/raw_events.json                 (full unfiltered fetch)
    data/<city>/<YYYY-MM-DD>/raw_events.json    (whitelist-matched, per day)
    data/<city>/<YYYY-MM-DD>/forecast.json      (scored + daily verdict)

The pipeline is city-config-driven from the top: it reads
config/cities.json to learn which cities to process. Adding NYC or
Chicago later is a config-add; no code changes here.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import gtfs, scoring, ticketmaster, timecurves, transit, whitelist
from .config import REPO_ROOT, load_api_key, load_cities_list, load_city_config

log = logging.getLogger("pipeline.run")


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _bucket_by_local_day(events: list[dict], tz: ZoneInfo) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = {}
    for ev in events:
        dates = (ev.get("dates") or {}).get("start") or {}
        dt_str = dates.get("dateTime")
        if dt_str:
            try:
                dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            local_date = dt.astimezone(tz).date().isoformat()
        else:
            local_date = dates.get("localDate")
            if not local_date:
                continue
        buckets.setdefault(local_date, []).append(ev)
    return buckets


def _build_forecast_event(event: dict, venue_entry: dict, impact: float, start_local, end_local) -> dict:
    """Shape a per-day forecast event entry (the JSON consumed by the frontend)."""
    return {
        "id": event.get("id") or "",
        "name": event.get("name") or "",
        "venue_id": venue_entry["id"],
        "venue_name": venue_entry["name"],
        "category": venue_entry.get("category") or "family_other",
        "start_local": start_local.isoformat(timespec="seconds") if start_local else None,
        "end_local": end_local.isoformat(timespec="seconds") if end_local else None,
        "impact": impact,
        "ticketmaster_url": event.get("url") or "",
    }


def run_city(city_id: str, api_key: str, window_days: int, force_refresh: bool) -> int:
    """Run the full fetch -> filter -> score -> write flow for one city.

    Returns 0 on success, non-zero on a per-city failure (the caller may
    continue with other cities).
    """
    log.info("[city] === processing city: %s ===", city_id)
    try:
        city_cfg = load_city_config(city_id)
    except SystemExit:
        return 1
    tz = ZoneInfo(city_cfg["timezone"])

    try:
        events, meta = ticketmaster.fetch_events(
            city_cfg=city_cfg,
            api_key=api_key,
            window_days=window_days,
            force_refresh=force_refresh,
        )
    except Exception as exc:  # pragma: no cover - top-level guard
        log.error("[fatal] Ticketmaster fetch failed for %s: %s", city_id, exc)
        return 2

    out_dir = REPO_ROOT / "data" / city_id
    raw_payload = {
        "city": city_id,
        "fetched_at": meta["fetched_at"],
        "window": {
            "start": meta["window_start"],
            "end": meta["window_end"],
            "timezone": meta["timezone"],
        },
        "attribution": ticketmaster.ATTRIBUTION,
        "source": "ticketmaster",
        "event_count": len(events),
        "events": events,
    }
    _write_json(out_dir / "raw_events.json", raw_payload)
    log.info("[output] wrote %d events to %s", len(events), out_dir / "raw_events.json")

    venues = city_cfg["venues"]
    # M4: reduced station set for this city. Empty if pipeline.gtfs has
    # not been run yet; the per-day forecast simply ships no transit_flags
    # and the frontend skips the station layer.
    stations = gtfs.load_reduced_stations(city_id)
    if not stations:
        log.info(
            "[transit] no reduced stations for %s; run `python -m pipeline.gtfs --city %s`",
            city_id, city_id,
        )

    matched, unmatched = whitelist.apply(events, venues)
    log.info(
        "[whitelist] %d events matched (of %d); %d distinct unmatched venues",
        len(matched),
        len(events),
        len(unmatched),
    )
    if unmatched:
        log.info("[whitelist] top unmatched venues: %s", unmatched.most_common(10))

    buckets = _bucket_by_local_day(matched, tz)

    for day_key in meta["day_keys"]:
        day_events = buckets.get(day_key, [])

        # Persist the per-day raw cohort (unchanged from M0 shape).
        day_raw_payload = {
            "city": city_id,
            "date": day_key,
            "timezone": meta["timezone"],
            "attribution": ticketmaster.ATTRIBUTION,
            "source": "ticketmaster",
            "event_count": len(day_events),
            "events": day_events,
        }
        _write_json(out_dir / day_key / "raw_events.json", day_raw_payload)

        # Score each event, build forecast entries, sort by impact desc.
        forecast_events: list[dict] = []
        for ev in day_events:
            tm_venue = (ev.get("_embedded") or {}).get("venues") or []
            tm_venue = tm_venue[0] if tm_venue else {}
            venue_entry = whitelist.find_match(tm_venue, venues)
            if not venue_entry:
                # Defensive: matched but lookup miss; skip rather than crash.
                continue
            impact = scoring.score_event(ev, venue_entry, tz)
            if impact is None:
                continue
            start_local, end_local = scoring.event_times_local(ev, tz)
            entry = _build_forecast_event(ev, venue_entry, impact, start_local, end_local)
            # Attach parsed start_local so daily_verdict can read the hour
            # without re-parsing. Stripped before JSON serialization.
            entry["_start_local"] = start_local
            forecast_events.append(entry)

        forecast_events.sort(key=lambda e: e["impact"], reverse=True)
        verdict, peak_proxy = scoring.daily_verdict(forecast_events)

        # Strip the parser cookie before writing.
        for e in forecast_events:
            e.pop("_start_local", None)

        # M2: per-event time curves, daily summed timeline, peak bucket,
        # and per-event venue intensity at the peak bucket. These feed the
        # map heatmap (M2) and will feed the scrubber in M3.
        timecurves.build_event_curves(forecast_events, day_key, tz)
        timeline = timecurves.build_daily_timeline(forecast_events)
        peak_bucket, peak_value = timecurves.pick_peak_bucket(timeline)
        timecurves.annotate_peak_intensity(forecast_events, peak_bucket)

        # M4: server-computed avoid windows (single source of truth for
        # timeline bands + transit-station flagging) and per-event
        # transit flags. Both are keyed by event_id; the frontend joins
        # them when scrubbing.
        avoid_windows = timecurves.build_avoid_windows(forecast_events, day_key, tz)
        transit_flags = transit.build_transit_flags(forecast_events, venues, stations)

        forecast_payload = {
            "date": day_key,
            "city_id": city_id,
            "timezone": meta["timezone"],
            "generated_at": meta["fetched_at"],
            "verdict": verdict,
            "peak_proxy": peak_proxy,
            "peak_bucket": peak_bucket,
            "peak_value": round(peak_value, 3),
            "bucket_minutes": timecurves.BUCKET_MINUTES,
            "timeline": timeline,
            "thresholds": scoring.THRESHOLDS,
            "avoid_windows": avoid_windows,
            "transit_flags": transit_flags,
            "attribution": ticketmaster.ATTRIBUTION,
            "event_count": len(forecast_events),
            "events": forecast_events,
        }
        _write_json(out_dir / day_key / "forecast.json", forecast_payload)
        log.info(
            "[forecast] %s: verdict=%s peak_proxy=%.2f peak_bucket=%d peak_value=%.2f events=%d",
            day_key,
            verdict,
            peak_proxy,
            peak_bucket,
            peak_value,
            len(forecast_events),
        )

    return 0


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    parser = argparse.ArgumentParser(prog="pipeline.run")
    parser.add_argument(
        "--city",
        default=None,
        help="run a single city by id (defaults to every city in config/cities.json)",
    )
    parser.add_argument("--refresh", action="store_true", help="bypass cache reads")
    parser.add_argument("--window-days", type=int, default=7)
    args = parser.parse_args(argv)

    api_key = load_api_key()

    if args.city:
        cities = [args.city]
    else:
        cities = load_cities_list()
    log.info("[cities] processing %d city/cities: %s", len(cities), cities)

    failures = 0
    for city_id in cities:
        rc = run_city(city_id, api_key, args.window_days, args.refresh)
        if rc != 0:
            failures += 1

    if failures:
        log.error("[cities] %d/%d cities failed", failures, len(cities))
        return failures
    return 0


if __name__ == "__main__":
    sys.exit(main())
