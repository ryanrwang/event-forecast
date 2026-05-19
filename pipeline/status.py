"""Cron status file — single source of truth for "is the data fresh?".

The pipeline writes ``data/status.json`` after every run. The PHP layer
reads it to expose a per-city freshness chip to the frontend, and the
operator can ``cat`` it on Bluehost to see what each cron last did.

Shape (v1):
    {
      "schema_version": 1,
      "updated_at": "<ISO8601 local to first city>",
      "cities": {
        "<city_id>": {
          "ticketmaster": {
            "last_success_at": "<ISO8601> | null",
            "last_attempt_at": "<ISO8601> | null",
            "last_error":      "<short string> | null",
            "calls_today":     <int>,
            "budget_per_day":  <int>,
            "budget_exhausted": <bool>,
            "stale":           <bool>,
            "max_age_minutes": <int>
          },
          "gtfs": {
            "last_refresh_at":  "<ISO8601> | null",
            "zip_age_minutes":  <number> | null,
            "zip_size_bytes":   <int> | null,
            "stale":            <bool>,
            "max_age_days":     <int>
          },
          "forecast": {
            "last_run_at":     "<ISO8601> | null",
            "days_with_events": <int>,
            "total_events":     <int>,
            "zero_event_run":   <bool>
          }
        }
      }
    }

Designed for partial updates: ``update_city`` reads, merges per-section,
and atomically replaces the file. Different cron jobs (TM cron, GTFS
cron) can stomp without losing each other's fields.

Stale thresholds:
    * Ticketmaster: TM cron should run at most every ~30 min for the
      short window. We mark stale when last_success_at is older than
      TM_MAX_AGE_MINUTES (default: 180 min = three short-cron cycles).
    * GTFS: TTC publishes a fresh static zip about monthly. The pipeline
      cron is weekly. Stale at >GTFS_MAX_AGE_DAYS (default: 14 days =
      two missed weekly runs).

Both thresholds are also persisted in the status payload so the
frontend / PHP layer can render the same numbers without duplicating
constants.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import REPO_ROOT

log = logging.getLogger("pipeline.status")

STATUS_PATH = REPO_ROOT / "data" / "status.json"
SCHEMA_VERSION = 1

# Ticketmaster: every short-cycle (~30min) cron tick should refresh the
# next-24h window. Three missed ticks (~3h) is the staleness threshold.
TM_MAX_AGE_MINUTES = 180

# GTFS: the weekly cron should run once every ~7 days. Two missed cycles
# (~14 days) is the staleness threshold; the operator should investigate
# before the published zip itself goes out of date (TTC ships monthly).
GTFS_MAX_AGE_DAYS = 14


def _now_iso(tz: ZoneInfo | None = None) -> str:
    tz = tz or timezone.utc
    return datetime.now(tz).isoformat(timespec="seconds")


def _empty_city_status() -> dict[str, Any]:
    return {
        "ticketmaster": {
            "last_success_at": None,
            "last_attempt_at": None,
            "last_error":      None,
            "calls_today":     0,
            "budget_per_day":  0,
            "budget_exhausted": False,
            "stale":           True,
            "max_age_minutes": TM_MAX_AGE_MINUTES,
        },
        "gtfs": {
            "last_refresh_at": None,
            "zip_age_minutes": None,
            "zip_size_bytes":  None,
            "stale":           True,
            "max_age_days":    GTFS_MAX_AGE_DAYS,
        },
        "forecast": {
            "last_run_at":     None,
            "days_with_events": 0,
            "total_events":     0,
            "zero_event_run":   False,
        },
    }


def _read_status() -> dict[str, Any]:
    """Read the current status file; return a fresh skeleton if missing."""
    if not STATUS_PATH.exists():
        return {"schema_version": SCHEMA_VERSION, "updated_at": None, "cities": {}}
    try:
        data = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.warning("[status] %s unreadable; rebuilding", STATUS_PATH)
        return {"schema_version": SCHEMA_VERSION, "updated_at": None, "cities": {}}
    if data.get("schema_version") != SCHEMA_VERSION:
        # Future-us has migrated; today there's only v1.
        data["schema_version"] = SCHEMA_VERSION
    data.setdefault("cities", {})
    return data


def _atomic_write(payload: dict[str, Any]) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATUS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    # Windows + Dropbox can briefly lock the target file. The Linux
    # production deploy doesn't see this; the retry is purely for the
    # operator's local-dev experience.
    for attempt in range(3):
        try:
            tmp.replace(STATUS_PATH)
            return
        except PermissionError:
            if attempt == 2:
                raise
            time.sleep(0.1)


def _merge_city(existing: dict[str, Any], section: str, update: dict[str, Any]) -> dict[str, Any]:
    base = existing.setdefault(section, _empty_city_status()[section])
    base.update(update)
    return existing


def update_city(city_id: str, section: str, update: dict[str, Any], tz: ZoneInfo | None = None) -> None:
    """Merge ``update`` into ``cities[<city_id>][<section>]`` and write.

    ``section`` is one of ``ticketmaster``, ``gtfs``, ``forecast``. Other
    sections are stomped through unchanged so different cron jobs don't
    collide.
    """
    if section not in {"ticketmaster", "gtfs", "forecast"}:
        raise ValueError(f"unknown status section: {section}")

    data = _read_status()
    city = data["cities"].setdefault(city_id, _empty_city_status())
    _merge_city(city, section, update)
    data["updated_at"] = _now_iso(tz)
    _atomic_write(data)


def mark_tm_attempt(city_id: str, *, success: bool, error: str | None,
                    calls_today: int, budget_per_day: int,
                    budget_exhausted: bool, tz: ZoneInfo | None = None) -> None:
    """Record one Ticketmaster refresh attempt. On success, advance
    ``last_success_at``; on failure, leave it alone (so a transient outage
    doesn't reset the "we did pull data N min ago" clock)."""
    now = _now_iso(tz)
    upd: dict[str, Any] = {
        "last_attempt_at":  now,
        "calls_today":      calls_today,
        "budget_per_day":   budget_per_day,
        "budget_exhausted": budget_exhausted,
        "max_age_minutes":  TM_MAX_AGE_MINUTES,
        "last_error":       None if success else (error or "fetch failed"),
    }
    if success:
        upd["last_success_at"] = now
        upd["stale"] = False
    else:
        # Compute staleness based on the existing last_success_at.
        data = _read_status()
        prev = ((data["cities"].get(city_id) or {}).get("ticketmaster") or {})
        last_success = prev.get("last_success_at")
        upd["stale"] = _is_age_over_min(last_success, TM_MAX_AGE_MINUTES)
    update_city(city_id, "ticketmaster", upd, tz=tz)


def mark_gtfs_refresh(city_id: str, *, zip_mtime_epoch: float | None,
                      zip_size_bytes: int | None,
                      tz: ZoneInfo | None = None) -> None:
    """Record the GTFS zip's freshness for one city.

    The pipeline calls this after each ``pipeline.gtfs`` run. If the
    download failed and a stale cached zip was used, the older mtime is
    what's recorded — that's exactly the signal the operator needs.
    """
    upd: dict[str, Any] = {
        "max_age_days": GTFS_MAX_AGE_DAYS,
    }
    if zip_mtime_epoch is None:
        upd["last_refresh_at"] = None
        upd["zip_age_minutes"] = None
        upd["zip_size_bytes"]  = None
        upd["stale"]           = True
    else:
        mt = datetime.fromtimestamp(zip_mtime_epoch, tz=tz or timezone.utc)
        upd["last_refresh_at"] = mt.isoformat(timespec="seconds")
        age_min = max(0.0, (time.time() - zip_mtime_epoch) / 60.0)
        upd["zip_age_minutes"] = round(age_min, 1)
        upd["zip_size_bytes"]  = zip_size_bytes
        upd["stale"]           = age_min > GTFS_MAX_AGE_DAYS * 24 * 60
    update_city(city_id, "gtfs", upd, tz=tz)


def mark_forecast_run(city_id: str, *, days_with_events: int,
                      total_events: int, tz: ZoneInfo | None = None) -> None:
    """Record the outcome of one ``pipeline.run`` for this city.

    ``zero_event_run`` is the loud signal: zero impactful events across
    ALL configured days in the window. The PHP/frontend layer surfaces
    this as a banner.
    """
    upd = {
        "last_run_at":     _now_iso(tz),
        "days_with_events": days_with_events,
        "total_events":     total_events,
        "zero_event_run":   total_events == 0,
    }
    update_city(city_id, "forecast", upd, tz=tz)
    if upd["zero_event_run"]:
        log.warning(
            "[status] %s: ZERO impactful events across the window — "
            "whitelist mismatch, upstream outage, or genuinely quiet week",
            city_id,
        )


def _is_age_over_min(iso_ts: str | None, max_min: int) -> bool:
    if not iso_ts:
        return True
    try:
        dt = datetime.fromisoformat(iso_ts)
    except ValueError:
        return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    age_min = (datetime.now(dt.tzinfo) - dt).total_seconds() / 60.0
    return age_min > max_min
