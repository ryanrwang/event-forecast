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
    history/<city>/<YYYY-MM>.json               (compact archive, one record per day)

Everything under data/ is disposable: it is regenerated from scratch on
every run and day folders older than today are pruned. history/ is the
exception — it accumulates, is committed to the repo, and is the only
record of days the Ticketmaster API will no longer serve.

The pipeline is city-config-driven from the top: it reads
config/cities.json to learn which cities to process. Adding NYC or
Chicago later is a config-add; no code changes here.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import budget, eventfilter, gtfs, history, manual_events, scoring, status as status_writer, ticketmaster, timecurves, transit, whitelist
from .config import REPO_ROOT, load_api_key, load_cities_list, load_city_config

log = logging.getLogger("pipeline.run")


def _safe_budget_state(city_id: str, city_cfg: dict) -> dict:
    """Best-effort budget snapshot for status writes when fetch fails."""
    try:
        tz = ZoneInfo(city_cfg["timezone"])
        daily = int((city_cfg.get("ticketmaster") or {}).get(
            "daily_budget", budget.DEFAULT_DAILY_BUDGET))
        return budget.get_state(city_id, tz, daily)
    except Exception:  # pragma: no cover - never bring down the cron
        return {"calls": 0, "limit": budget.DEFAULT_DAILY_BUDGET, "exhausted": False}


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


_DAY_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _prune_old_day_dirs(out_dir: Path, tz: ZoneInfo) -> None:
    """Delete data/<city>/<YYYY-MM-DD>/ folders dated before today (city tz).

    Under GitHub Actions the checkout starts clean, so this is normally a
    no-op; it exists so a persistent-disk deploy or a local dev run can't
    accumulate old date folders and re-trigger the "earliest folders win"
    serving bug. Only date-named directories are candidates — the sibling
    raw_events.json is a file, and data/status.json + data/cache/ live
    outside data/<city>/, so none of them can ever match.
    """
    if not out_dir.is_dir():
        return
    today = datetime.now(tz).date().isoformat()
    for child in out_dir.iterdir():
        if not child.is_dir() or not _DAY_DIR_RE.match(child.name):
            continue
        if child.name >= today:
            continue
        try:
            shutil.rmtree(child)
            log.info("[prune] removed stale day folder %s", child)
        except OSError as exc:
            log.warning("[prune] could not remove %s: %s", child, exc)


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


def _primary_segment(event: dict) -> str:
    """The event's primary TM classification segment ("Music", "Sports", …).

    Shipped per event so the frontend's type-filter chips can distinguish
    a game from a concert at the same venue — the venue-level category
    can't (Coca-Cola Coliseum hosts both). Empty string when TM ships no
    classification; the frontend falls back to the venue category.
    """
    cl = (event.get("classifications") or [{}])[0]
    if not isinstance(cl, dict):
        return ""
    return ((cl.get("segment") or {}).get("name") or "").strip()


def _build_forecast_event(event: dict, venue_entry: dict, impact: float, start_local, end_local) -> dict:
    """Shape a per-day forecast event entry (the JSON consumed by the frontend)."""
    return {
        "id": event.get("id") or "",
        "name": event.get("name") or "",
        "venue_id": venue_entry["id"],
        "venue_name": venue_entry["name"],
        "category": venue_entry.get("category") or "family_other",
        "segment": _primary_segment(event),
        "source": "ticketmaster",
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
    except ticketmaster.BudgetExhausted:
        # The per-city daily budget is gone. Don't crash the cron — the
        # forecast files from the prior successful run are still on disk
        # and will continue to serve. Surface the state to the operator
        # via the status file so the frontend can render a "stale data"
        # banner with a timestamp.
        state = _safe_budget_state(city_id, city_cfg)
        status_writer.mark_tm_attempt(
            city_id,
            success=False,
            error="daily ticketmaster budget exhausted",
            calls_today=state["calls"],
            budget_per_day=state["limit"],
            budget_exhausted=True,
            tz=ZoneInfo(city_cfg["timezone"]),
        )
        log.warning(
            "[run] %s budget exhausted; previous forecast files unchanged.",
            city_id,
        )
        return 0
    except Exception as exc:  # pragma: no cover - top-level guard
        log.error("[fatal] Ticketmaster fetch failed for %s: %s", city_id, exc)
        state = _safe_budget_state(city_id, city_cfg)
        status_writer.mark_tm_attempt(
            city_id,
            success=False,
            error=str(exc)[:200],
            calls_today=state["calls"],
            budget_per_day=state["limit"],
            budget_exhausted=False,
            tz=ZoneInfo(city_cfg["timezone"]),
        )
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
    # Copy the committed station set's generation time into status.json
    # on every run. In the Actions model each run rebuilds status.json
    # from a clean checkout, so this is the only path that keeps the
    # served GTFS freshness truthful (see mark_gtfs_from_meta).
    status_writer.mark_gtfs_from_meta(
        city_id,
        refreshed_at=gtfs.load_station_meta(city_id).get("refreshed_at"),
        tz=tz,
    )
    # Curated venue → subway/GO station map (the source of the "stations
    # likely packed" list) and the operator's hand-maintained crowd days
    # (parades, marathons, festivals) that Ticketmaster never lists.
    venue_stations = transit.load_venue_stations(city_id)
    if not venue_stations["venues"]:
        log.info("[transit] no venue_stations.json for %s; falling back to GTFS stations", city_id)
    manual = manual_events.load_manual_events(city_id)
    if manual:
        log.info("[manual] %d dated manual crowd-day entries for %s", len(manual), city_id)

    matched, unmatched = whitelist.apply(events, venues)
    log.info(
        "[whitelist] %d events matched (of %d); %d distinct unmatched venues",
        len(matched),
        len(events),
        len(unmatched),
    )
    if unmatched:
        log.info("[whitelist] top unmatched venues: %s", unmatched.most_common(10))

    # Drop non-crowd listings (facility tours, parking, packages) that
    # TM attaches to whitelisted venues — they'd otherwise be scored
    # with the venue's full capacity. Rules: config/event_filters.json.
    matched = eventfilter.apply(matched)

    buckets = _bucket_by_local_day(matched, tz)

    # Track per-day scored event counts so we can fire the zero-event
    # sanity alert and feed status.json.
    days_with_events = 0
    total_scored_events = 0

    # Every day's forecast payload, collected for the compact archive.
    # The archive is written once at the end of the loop so a mid-run
    # failure leaves the previous month file untouched rather than
    # half-updated.
    archived_payloads: list[dict] = []

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
            entry["proxy_contribution"] = scoring.proxy_contribution(impact, start_local)
            # Attach parsed start_local so daily_verdict can read the hour
            # without re-parsing. Stripped before JSON serialization.
            entry["_start_local"] = start_local
            forecast_events.append(entry)

        # Operator-curated crowd days for this date (see pipeline.manual_events).
        forecast_events.extend(manual_events.forecast_entries_for_day(manual, day_key, tz))

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
        transit_flags = transit.build_transit_flags(
            forecast_events, venues, stations,
            city_cfg=city_cfg, venue_stations=venue_stations,
        )

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
            "buckets": timecurves.BUCKETS_PER_DAY,
            "span_hours": timecurves.DAY_SPAN_HOURS,
            "timeline": timeline,
            "thresholds": scoring.THRESHOLDS,
            "avoid_windows": avoid_windows,
            "transit_flags": transit_flags,
            "attribution": ticketmaster.ATTRIBUTION,
            "event_count": len(forecast_events),
            "events": forecast_events,
        }
        _write_json(out_dir / day_key / "forecast.json", forecast_payload)
        archived_payloads.append(forecast_payload)
        log.info(
            "[forecast] %s: verdict=%s peak_proxy=%.2f peak_bucket=%d peak_value=%.2f events=%d",
            day_key,
            verdict,
            peak_proxy,
            peak_bucket,
            peak_value,
            len(forecast_events),
        )

        if forecast_events:
            days_with_events += 1
            total_scored_events += len(forecast_events)

    # M6 sanity check: a run that produces zero impactful events across
    # EVERY day in the rolling window is almost always a real problem —
    # whitelist mismatch, upstream Ticketmaster outage swallowed silently,
    # or a fetch that returned [] without raising. Surface loudly to the
    # status file so the frontend can render a banner.
    if total_scored_events == 0:
        log.error(
            "[sanity] %s: ZERO impactful events across the %d-day window. "
            "Investigate: whitelist mismatch, upstream outage, or empty fetch.",
            city_id, len(meta["day_keys"]),
        )

    # Record this run's outcome to status.json. Successful fetch +
    # forecast write — TM is fresh; ``forecast`` section captures the
    # zero-event sanity bit.
    budget_state = meta.get("budget") or _safe_budget_state(city_id, city_cfg)
    status_writer.mark_tm_attempt(
        city_id,
        success=True,
        error=None,
        calls_today=budget_state["calls"],
        budget_per_day=budget_state["limit"],
        budget_exhausted=bool(budget_state.get("exhausted")),
        tz=tz,
    )
    status_writer.mark_forecast_run(
        city_id,
        days_with_events=days_with_events,
        total_events=total_scored_events,
        tz=tz,
    )

    # Compact archive. Must run BEFORE the prune conceptually and after
    # every day file is written; it reads the in-memory payloads, not the
    # disk tree, so ordering against the prune is immaterial. Never let
    # an archive failure fail the run — the live forecast is the product,
    # the archive is a bonus surface.
    try:
        history.archive_forecasts(city_id, archived_payloads)
    except Exception as exc:  # pragma: no cover - never bring down the cron
        log.error("[history] %s: archive failed (%s)", city_id, exc)

    _prune_old_day_dirs(out_dir, tz)

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
