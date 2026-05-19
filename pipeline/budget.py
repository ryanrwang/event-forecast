"""Per-city per-day Ticketmaster call counter.

Defends against burning through the free-tier 5000 calls/day budget when
a misconfigured cron, an aggressive ``--refresh``, or a future M5 city
list multiplies request volume. The counter is a plain JSON file under
``data/cache/ticketmaster/budget.json`` so it is durable across cron
process restarts.

Shape:
    {
      "<YYYY-MM-DD>": {
        "<city_id>": {"calls": <int>, "limit": <int>}
      }
    }

The date key is the city's local calendar day (so the reset is intuitive
for the operator looking at the file in their own time zone). Old date
rows are pruned every write — we only keep yesterday + today, which
keeps the file at <500 bytes even on an MVP-grade laptop.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import REPO_ROOT

log = logging.getLogger("pipeline.budget")

BUDGET_PATH = REPO_ROOT / "data" / "cache" / "ticketmaster" / "budget.json"

# Default daily call budget per configured city. The Ticketmaster
# free-tier headline number is ~5000 calls/day across all keys; with one
# key shared across all cities we partition headroom rather than racing.
# 2000/city × 3 cities (post-M5) leaves a 40% safety margin for retries.
DEFAULT_DAILY_BUDGET = 2000


def _read() -> dict[str, Any]:
    if not BUDGET_PATH.exists():
        return {}
    try:
        return json.loads(BUDGET_PATH.read_text(encoding="utf-8")) or {}
    except (OSError, json.JSONDecodeError):
        log.warning("[budget] %s unreadable; resetting", BUDGET_PATH)
        return {}


def _write(payload: dict[str, Any]) -> None:
    BUDGET_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = BUDGET_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # On Linux (Bluehost) this is one syscall. On Windows during local
    # dev a Dropbox/AV scanner can briefly lock the target — retry once
    # with a tiny sleep so the test cron doesn't flake.
    import time as _time
    for attempt in range(3):
        try:
            tmp.replace(BUDGET_PATH)
            return
        except PermissionError:
            if attempt == 2:
                raise
            _time.sleep(0.1)


def _today_key(tz: ZoneInfo) -> str:
    return datetime.now(tz).date().isoformat()


def _prune(payload: dict[str, Any], today_key: str) -> dict[str, Any]:
    keep = {today_key}
    try:
        yesterday = (datetime.fromisoformat(today_key) - timedelta(days=1)).date().isoformat()
        keep.add(yesterday)
    except ValueError:
        pass
    return {k: v for k, v in payload.items() if k in keep}


def get_state(city_id: str, tz: ZoneInfo, daily_budget: int = DEFAULT_DAILY_BUDGET) -> dict[str, Any]:
    """Return {calls, limit, remaining, exhausted} for the city's TODAY."""
    payload = _read()
    today = _today_key(tz)
    city_row = (payload.get(today) or {}).get(city_id) or {"calls": 0, "limit": daily_budget}
    limit = int(city_row.get("limit") or daily_budget)
    calls = int(city_row.get("calls") or 0)
    return {
        "calls": calls,
        "limit": limit,
        "remaining": max(0, limit - calls),
        "exhausted": calls >= limit,
    }


def reserve(city_id: str, tz: ZoneInfo, daily_budget: int = DEFAULT_DAILY_BUDGET) -> bool:
    """Reserve one call against the city's daily budget. Returns False if
    the budget is exhausted (caller should NOT make the request)."""
    payload = _read()
    today = _today_key(tz)
    payload = _prune(payload, today)
    day = payload.setdefault(today, {})
    city_row = day.setdefault(city_id, {"calls": 0, "limit": daily_budget})
    if city_row.get("limit") is None:
        city_row["limit"] = daily_budget
    if int(city_row["calls"]) >= int(city_row["limit"]):
        _write(payload)
        return False
    city_row["calls"] = int(city_row["calls"]) + 1
    _write(payload)
    return True


def set_limit(city_id: str, tz: ZoneInfo, limit: int) -> None:
    """Override today's daily budget for one city (CLI / config wiring)."""
    payload = _read()
    today = _today_key(tz)
    payload = _prune(payload, today)
    day = payload.setdefault(today, {})
    city_row = day.setdefault(city_id, {"calls": 0, "limit": limit})
    city_row["limit"] = int(limit)
    _write(payload)
