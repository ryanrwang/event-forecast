"""Event Forecast pipeline entrypoint.

Usage:
    python -m pipeline.run                # default city=toronto, 7-day window
    python -m pipeline.run --refresh      # bypass cache reads (still writes)
    python -m pipeline.run --city toronto

Writes:
    data/<city>/raw_events.json                    (full unfiltered response set)
    data/<city>/YYYY-MM-DD/raw_events.json         (whitelist-matched, per day)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import ticketmaster, whitelist
from .config import REPO_ROOT, load_api_key, load_city_config

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
        # Ticketmaster typically returns dateTime as ISO 8601 ending in 'Z'.
        dt_str = dates.get("dateTime")
        if dt_str:
            try:
                # Python 3.11+ handles 'Z'; for 3.10 we swap it for '+00:00'.
                dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            local_date = dt.astimezone(tz).date().isoformat()
        else:
            # Some all-day events only have localDate. Use it as-is.
            local_date = dates.get("localDate")
            if not local_date:
                continue
        buckets.setdefault(local_date, []).append(ev)
    return buckets


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    parser = argparse.ArgumentParser(prog="pipeline.run")
    parser.add_argument("--city", default="toronto")
    parser.add_argument("--refresh", action="store_true", help="bypass cache reads")
    parser.add_argument("--window-days", type=int, default=7)
    args = parser.parse_args(argv)

    api_key = load_api_key()
    city_cfg = load_city_config(args.city)
    tz = ZoneInfo(city_cfg["timezone"])

    try:
        events, meta = ticketmaster.fetch_events(
            city_cfg=city_cfg,
            api_key=api_key,
            window_days=args.window_days,
            force_refresh=args.refresh,
        )
    except Exception as exc:  # pragma: no cover - top-level guard
        log.error("[fatal] Ticketmaster fetch failed: %s", exc)
        return 2

    out_dir = REPO_ROOT / "data" / args.city
    raw_payload = {
        "city": args.city,
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

    matched, unmatched = whitelist.apply(events, city_cfg["venues"])
    log.info(
        "[whitelist] %d events matched (of %d); %d distinct unmatched venues",
        len(matched),
        len(events),
        len(unmatched),
    )
    if unmatched:
        # Show the top 10 unmatched venues so the M1 sanity pass can pick them up.
        top = unmatched.most_common(10)
        log.info("[whitelist] top unmatched venues: %s", top)

    buckets = _bucket_by_local_day(matched, tz)

    for day_key in meta["day_keys"]:
        day_events = buckets.get(day_key, [])
        day_payload = {
            "city": args.city,
            "date": day_key,
            "timezone": meta["timezone"],
            "attribution": ticketmaster.ATTRIBUTION,
            "source": "ticketmaster",
            "event_count": len(day_events),
            "events": day_events,
        }
        _write_json(out_dir / day_key / "raw_events.json", day_payload)
        log.info("[output] %s: %d filtered events", day_key, len(day_events))

    return 0


if __name__ == "__main__":
    sys.exit(main())
