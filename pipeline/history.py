"""Compact per-day archive so past forecast days survive the prune.

``pipeline.run`` writes a full ``forecast.json`` per day and then deletes
day folders dated before today (see ``_prune_old_day_dirs``). The rolling
window is also regenerated from a clean checkout on every GitHub Actions
run, and the FTP sync mirrors deletions to the server. Nothing about a
past day survives any of that.

This module distills each day into a compact record roughly 16x smaller
than the full file and upserts it into ``history/<city>/<YYYY-MM>.json``.
The archive deliberately lives OUTSIDE the gitignored ``data/`` tree so
it can be committed: history is the one pipeline artifact that cannot be
regenerated from the Ticketmaster API, because the API only serves
upcoming events.

What survives, and what each piece is for:

===========================  ===================================
kept                         renders
===========================  ===================================
verdict, score, thresholds   the calendar cell + the verdict pill
timeline                     the day curve and the mini graph
avoid_windows                the arrival / dispersal bands
per-event during windows     the event lane above the curve
per-event curves             the map heatmap and the time scrubber
per-event stations           the "stations likely packed" lanes
===========================  ===================================

Dropped: scoring internals (``spots``, ``scopes``,
``subscore_reference``), per-event ``flux_curve`` and ``spot_weights``,
and per-station ``seats_per_hour``. Those are model intermediates the UI
never renders; keeping them is what makes the full file 134 KB.

Per-event curves are stored as their non-zero span only (an offset plus
the values that are actually above the floor). A single event is active
for roughly 23 of the day's 104 buckets, so this costs a few hundred
bytes per day while preserving the exact modeled shape.

Records are SELF-CONTAINED by design. A station's name, kind and
coordinates are stored with the day rather than joined from config at
serve time, so an archived day still reads correctly after a GTFS
refresh renames a stop or a venue's curated station list is retuned.
This is the opposite of the choice ``api/forecast.php`` makes for live
days, and deliberately so: a live day should track current config, an
archived day should record what was actually modeled.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .config import REPO_ROOT

log = logging.getLogger("pipeline.history")

SCHEMA_VERSION = 1

# Directory name at the repo root. NOT under data/ — that tree is
# gitignored and FTP-mirrored with deletions.
HISTORY_DIRNAME = "history"

# Curve values at or below this are treated as zero when trimming an
# event's curve to its non-zero span. The daily timeline routinely sits
# in the 10s, so 0.05 is well inside the noise floor.
CURVE_EPSILON = 0.05

# Rounding. Two decimals everywhere: the underlying numbers are modeled
# estimates, and the extra digit costs ~10% of the record for precision
# nobody reads off a chart.
_ND = 2

# Per-event fields copied straight through from the forecast file.
_EVENT_PASSTHROUGH = (
    "id",
    "name",
    "venue_id",
    "venue_name",
    "category",
    "segment",
    "start_local",
    "end_local",
    "expected_attendance",
    "ticketmaster_url",
)

# Per-station fields kept, under their LIVE names.
#
# The archive is a strict field-subset of the live forecast shape, never a
# renamed variant: map.js and app.js read station_id / station_name / via
# directly, so a shorter key here would buy ~12 bytes a row and cost a
# translation layer that silently rots the day someone adds a field.
# Everything else on a station row — notably seats_per_hour, 24 floats
# per station — is dropped.
_STATION_KEEP = ("station_id", "station_name", "kind", "lines", "lat", "lon", "via")

# Station rows dominate the record's size, and streetcar stops are dense
# (a theatre block can have 15 within 600 m). pipeline.transit already
# caps them per event, but the archive is permanent and must not inherit
# a bad day upstream: cap here too. Curated subway/GO rows are few by
# construction and always kept; streetcar rows are kept nearest-first.
#
# Deliberately a literal rather than importing
# transit.STREETCAR_MAX_PER_EVENT: importing transit pulls in the GTFS
# module and its network dependency, and this module stays stdlib-only so
# that an archive write can never be the thing that breaks the cron. Keep
# it in step with pipeline/transit.py if that cap ever changes.
_STREETCAR_MAX_PER_EVENT = 4
# Absolute backstop per event regardless of kind, so a malformed or
# unclassified station list can never balloon a month file.
_STATIONS_MAX_PER_EVENT = 12


def _r(value, nd: int = _ND):
    """Round a number for storage; pass non-numbers through untouched."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    return round(float(value), nd)


def _sparse_curve(curve: list, eps: float = CURVE_EPSILON) -> dict | None:
    """Trim a per-event curve to its non-zero span.

    Returns ``{"o": <first kept bucket index>, "v": [...]}`` or ``None``
    when the curve is empty or entirely below ``eps``. Callers rebuild
    the full-length curve by padding with zeros on both sides.
    """
    if not curve:
        return None
    lo, hi = 0, len(curve)
    while lo < hi and (curve[lo] or 0) <= eps:
        lo += 1
    while hi > lo and (curve[hi - 1] or 0) <= eps:
        hi -= 1
    if lo >= hi:
        return None
    return {"o": lo, "v": [_r(v) for v in curve[lo:hi]]}


def _cap_stations(stations: list[dict]) -> list[dict]:
    """Keep every curated (subway / GO) row, the nearest few streetcar rows.

    ``pipeline.transit`` hands stations over already sorted by kind then
    distance, so "nearest few" is just the first N streetcar rows in the
    order they arrive. Rows with no ``kind`` are treated as curated: the
    only way that happens is a station set written before kinds shipped,
    and those are subway rows.
    """
    kept: list[dict] = []
    streetcar = 0
    for station in stations:
        if (station.get("kind") or "").lower() == "streetcar":
            streetcar += 1
            if streetcar > _STREETCAR_MAX_PER_EVENT:
                continue
        kept.append(station)
        if len(kept) >= _STATIONS_MAX_PER_EVENT:
            break
    return kept


def _stations_by_event(forecast: dict) -> dict[str, list[dict]]:
    """Index the day's transit flags by event id, keeping display fields."""
    out: dict[str, list[dict]] = {}
    flags = (forecast.get("transit_flags") or {}).get("events") or []
    for entry in flags:
        event_id = entry.get("event_id")
        if not event_id:
            continue
        rows = []
        for station in _cap_stations(entry.get("stations") or []):
            row = {}
            for key in _STATION_KEEP:
                if station.get(key) is not None:
                    row[key] = station[key]
            if station.get("distance_m") is not None:
                row["distance_m"] = round(float(station["distance_m"]))
            if station.get("load_share") is not None:
                row["load_share"] = _r(station["load_share"], 4)
            rows.append(row)
        out[event_id] = rows
    return out


def build_record(forecast: dict) -> dict:
    """Distill one full forecast payload into its archive record."""
    stations = _stations_by_event(forecast)
    transit_flags = forecast.get("transit_flags") or {}

    events = []
    for event in forecast.get("events") or []:
        row = {k: event[k] for k in _EVENT_PASSTHROUGH if event.get(k) is not None}
        row["impact"] = _r(event.get("impact"))
        for key in ("sigma_m", "peak_intensity", "street_weight"):
            if event.get(key) is not None:
                row[key] = _r(event[key])
        if event.get("transit_people") is not None:
            row["transit_people"] = int(event["transit_people"])
        for key in ("during_from_bucket", "during_to_bucket"):
            if event.get(key) is not None:
                row[key] = _r(event[key])
        curve = _sparse_curve(event.get("time_curve") or [])
        if curve is not None:
            row["curve"] = curve
        event_stations = stations.get(event.get("id"))
        if event_stations:
            row["stations"] = event_stations
        events.append(row)

    record = {
        "date": forecast.get("date"),
        "generated_at": forecast.get("generated_at"),
        "verdict": forecast.get("verdict"),
        "score": _r(forecast.get("peak_proxy")),
        "peak_bucket": forecast.get("peak_bucket"),
        "peak_value": _r(forecast.get("peak_value")),
        "bucket_minutes": forecast.get("bucket_minutes"),
        "buckets": forecast.get("buckets") or len(forecast.get("timeline") or []),
        "span_hours": forecast.get("span_hours"),
        "thresholds": {k: _r(v) for k, v in (forecast.get("thresholds") or {}).items()},
        "timeline": [_r(v) for v in (forecast.get("timeline") or [])],
        "event_count": forecast.get("event_count", len(events)),
        # All four positional fields: the timeline bands are drawn from
        # the bucket pair, the station lanes from the minute pair.
        "avoid_windows": [
            {
                "event_id": w.get("event_id"),
                "kind": w.get("kind"),
                "from_minute": _r(w.get("from_minute")),
                "to_minute": _r(w.get("to_minute")),
                "from_bucket": _r(w.get("from_bucket")),
                "to_bucket": _r(w.get("to_bucket")),
            }
            for w in (forecast.get("avoid_windows") or [])
        ],
        "events": events,
    }
    if transit_flags.get("service_profile"):
        record["service_profile"] = transit_flags["service_profile"]
    return record


# ─────────── Month files ───────────

def history_root(root: Path | None = None) -> Path:
    return (root or REPO_ROOT) / HISTORY_DIRNAME


def month_path(city_id: str, month: str, root: Path | None = None) -> Path:
    return history_root(root) / city_id / f"{month}.json"


def _load_month(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        # A corrupt month file must not take down the cron, but it also
        # must not be silently overwritten with a single day — log loudly
        # and start fresh so the run still archives today.
        log.error("[history] unreadable month file %s (%s); rebuilding", path, exc)
        return {}
    return payload if isinstance(payload, dict) else {}


def upsert_days(
    city_id: str,
    records: list[dict],
    root: Path | None = None,
) -> list[Path]:
    """Merge ``records`` into their month files, newest write winning.

    Called on every pipeline run for every day in the rolling window, so
    a given date is written repeatedly and the last run of the day is the
    one that sticks. Archiving the whole window (not just today) means a
    stretch of failed cron runs leaves a slightly stale forecast for
    those dates rather than a hole in the calendar.
    """
    by_month: dict[str, list[dict]] = {}
    for record in records:
        date = record.get("date")
        if not isinstance(date, str) or len(date) < 7:
            continue
        by_month.setdefault(date[:7], []).append(record)

    written: list[Path] = []
    for month, month_records in sorted(by_month.items()):
        path = month_path(city_id, month, root)
        existing = _load_month(path)
        days = {
            d["date"]: d
            for d in (existing.get("days") or [])
            if isinstance(d, dict) and isinstance(d.get("date"), str)
        }
        for record in month_records:
            days[record["date"]] = record

        payload = {
            "schema_version": SCHEMA_VERSION,
            "city_id": city_id,
            "month": month,
            "day_count": len(days),
            "days": [days[k] for k in sorted(days)],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        # Compact separators: these files are committed and served as-is,
        # and the day arrays are long. Readability is not worth ~25%.
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        written.append(path)
        log.info(
            "[history] %s %s: %d day(s) archived (%d bytes)",
            city_id, month, len(days), path.stat().st_size,
        )
    return written


def archive_forecasts(
    city_id: str,
    forecasts: list[dict],
    root: Path | None = None,
) -> list[Path]:
    """Build records for each forecast payload and upsert them."""
    records = [build_record(f) for f in forecasts if f and f.get("date")]
    if not records:
        return []
    return upsert_days(city_id, records, root)


def list_months(city_id: str, root: Path | None = None) -> list[str]:
    """Sorted YYYY-MM month ids that have an archive file for this city."""
    city_dir = history_root(root) / city_id
    if not city_dir.is_dir():
        return []
    months = []
    for child in city_dir.iterdir():
        if child.is_file() and child.suffix == ".json" and len(child.stem) == 7:
            months.append(child.stem)
    return sorted(months)
