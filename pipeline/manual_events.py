"""Operator-curated crowd days that Ticketmaster never lists.

Parades, street festivals, marathons, and road closures are the biggest
"avoid downtown" days of the year and none of them are ticketed, so the
venue whitelist can never see them. ``config/<city>/manual_events.json``
is the operator's hand-maintained list. Each entry with a real date
inside the forecast window becomes a modeled event like any other: it
gets an impact score, a time curve, avoid windows, a heat splat, and a
station list, and it counts toward the day verdict.

This is NOT discovery logic. Nothing is inferred; the operator types the
date, the area, and a crowd estimate. Entries whose ``date`` is null are
templates and are skipped with a log line, so the shipped file can carry
worked examples without rendering anything until real dates are filled in.

Entry shape::

    {
      "id": "pride-parade",
      "name": "Pride Parade",
      "date": "2026-06-28",            # null = template, skipped
      "start": "14:00",                # local HH:MM
      "end": "17:00",                  # local HH:MM
      "area": "Church-Wellesley to Yonge-Dundas",
      "lat": 43.6595, "lon": -79.3820, # heat centre
      "crowd_estimate": 150000,        # people on the street, order of magnitude
      "category": "festival",          # scoring.CATEGORY_WEIGHT key
      "stations": ["wellesley", "college", "dundas"],  # ids from venue_stations.json
      "note": "Yonge closed Bloor to Dundas",
      "source_url": "https://..."
    }

City-config driven: the loader is keyed by city id; adding a city means
adding its own manual_events.json (or none — the file is optional).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import scoring
from .config import CONFIG_DIR

log = logging.getLogger("pipeline.manual_events")

VENUE_ID_PREFIX = "manual:"
SOURCE = "manual"


def load_manual_events(city_id: str) -> list[dict]:
    """Load config/<city_id>/manual_events.json. Missing file → []."""
    path = CONFIG_DIR / city_id / "manual_events.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        log.error("[manual] %s unreadable (%s); ignoring", path, exc)
        return []
    entries = data.get("events") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        log.error("[manual] %s has no events list; ignoring", path)
        return []
    out = []
    for e in entries:
        if not isinstance(e, dict) or not e.get("id"):
            continue
        if not e.get("date"):
            log.info("[manual] %s: template entry (no date), skipped", e.get("id"))
            continue
        out.append(e)
    return out


def _parse_hhmm(value: str | None, default: str) -> tuple[int, int]:
    raw = (value or default).strip()
    try:
        hh, mm = raw.split(":")
        return int(hh), int(mm)
    except (ValueError, AttributeError):
        hh, mm = default.split(":")
        return int(hh), int(mm)


def forecast_entries_for_day(entries: list[dict], day_iso: str, tz: ZoneInfo) -> list[dict]:
    """Return forecast-shaped event dicts for manual entries dated ``day_iso``.

    Reuses ``scoring.score_event`` on a synthetic Ticketmaster-shaped
    event + venue so the impact math has exactly one implementation.
    The returned entries carry ``lat``/``lon`` inline because there is no
    venues.json row for the PHP layer to join against.
    """
    out: list[dict] = []
    for e in entries:
        dates = e.get("date")
        if isinstance(dates, str):
            dates = [dates]
        if not isinstance(dates, list) or day_iso not in dates:
            continue
        try:
            day = datetime.fromisoformat(day_iso).date()
        except ValueError:
            continue
        sh, sm = _parse_hhmm(e.get("start"), "12:00")
        eh, em = _parse_hhmm(e.get("end"), "18:00")
        start_local = datetime(day.year, day.month, day.day, sh, sm, tzinfo=tz)
        end_local = datetime(day.year, day.month, day.day, eh, em, tzinfo=tz)
        if end_local <= start_local:
            end_local = start_local + timedelta(hours=3)

        def _z(dt: datetime) -> str:
            return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        synthetic_event = {
            "id": f"manual-{e['id']}-{day_iso}",
            "name": e.get("name") or e["id"],
            "dates": {
                "start": {"dateTime": _z(start_local)},
                "end": {"dateTime": _z(end_local)},
            },
        }
        try:
            crowd = int(e.get("crowd_estimate") or 0)
        except (TypeError, ValueError):
            crowd = 0
        synthetic_venue = {
            "id": VENUE_ID_PREFIX + str(e["id"]),
            "name": e.get("area") or e.get("name") or e["id"],
            "capacity": crowd,
            "category": e.get("category") or "festival",
        }
        impact = scoring.score_event(synthetic_event, synthetic_venue, tz)
        if impact is None:
            continue
        try:
            lat = float(e["lat"])
            lon = float(e["lon"])
        except (KeyError, TypeError, ValueError):
            log.warning("[manual] %s: missing lat/lon, skipped", e["id"])
            continue

        entry = {
            "id": synthetic_event["id"],
            "name": synthetic_event["name"],
            "venue_id": synthetic_venue["id"],
            "venue_name": synthetic_venue["name"],
            "category": synthetic_venue["category"],
            "segment": "City event",
            "source": SOURCE,
            "start_local": start_local.isoformat(timespec="seconds"),
            "end_local": end_local.isoformat(timespec="seconds"),
            "impact": impact,
            "ticketmaster_url": "",
            "source_url": e.get("source_url") or "",
            "lat": lat,
            "lon": lon,
            "venue_capacity": crowd,
            "note": e.get("note") or "",
            "stations": [s for s in (e.get("stations") or []) if isinstance(s, str)],
        }
        entry["proxy_contribution"] = scoring.proxy_contribution(impact, start_local)
        entry["_start_local"] = start_local
        out.append(entry)
    return out
