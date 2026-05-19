"""Ticketmaster Discovery API client.

- Pages through events for a city in a date window.
- Honors a 250 ms inter-request delay and exponential backoff *with
  jitter* on 429/5xx (M6).
- Respects the ``Retry-After`` header verbatim when present (with jitter
  added so multiple cron entries don't synchronize their retries).
- Tracks per-city per-day calls against a configurable budget (M6); when
  the city's budget is exhausted we serve from cache only and surface
  the state to the operator via ``pipeline.status``.
- Falls back to per-day queries if a single window query exceeds the
  Discovery API's 1000-item deep-paging cap.
- Exports the required attribution string.
"""

from __future__ import annotations

import logging
import random
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Iterable
from zoneinfo import ZoneInfo

import requests

from . import budget, cache

# Free-tier ToS requires this string be rendered wherever events appear.
ATTRIBUTION = "Event discovery powered by Ticketmaster."

BASE_URL = "https://app.ticketmaster.com/discovery/v2/events.json"
PAGE_SIZE = 200
DEEP_PAGING_CAP = 1000  # Discovery API hard cap on items per query
INTER_REQUEST_SLEEP = 0.25  # seconds
MAX_RETRIES = 5

# Jitter is multiplicative — the actual sleep is the planned sleep
# scaled by a value drawn from [1 - JITTER_FRAC, 1 + JITTER_FRAC]. This
# prevents synchronized backoff across the TM short-cycle cron + 7-day
# cron if both happen to launch in the same second.
JITTER_FRAC = 0.30

log = logging.getLogger("pipeline.ticketmaster")


class BudgetExhausted(RuntimeError):
    """Raised when the per-city daily call budget has been hit. The caller
    should fall back to whatever's in the on-disk cache and surface the
    state to the operator via ``pipeline.status``.

    This is intentionally a separate exception class so ``pipeline.run``
    can distinguish "we ran out of headroom, last data is still fine" from
    "the API itself is broken"."""


def _iso_utc(dt: datetime) -> str:
    """Ticketmaster wants 'YYYY-MM-DDTHH:MM:SSZ' (no offset, literal Z)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _window_for(city_tz: ZoneInfo, days: int) -> tuple[datetime, datetime, list[date]]:
    """Return (start_local, end_local, list_of_local_calendar_days).

    Rounded to start-of-day in the city's timezone so the cache key is stable
    across runs within a calendar day. Slightly extends the window to cover
    earlier events on "today" — desirable for the forecast.
    """
    now_local = datetime.now(city_tz)
    today = now_local.date()
    start_local = datetime.combine(today, dtime.min, tzinfo=city_tz)
    end_local = start_local + timedelta(days=days)
    day_keys = [today + timedelta(days=i) for i in range(days)]
    return start_local, end_local, day_keys


def _jittered(sleep_s: float) -> float:
    """Apply ±JITTER_FRAC random scaling so cron entries don't synchronize."""
    if sleep_s <= 0:
        return 0.0
    scale = 1.0 + random.uniform(-JITTER_FRAC, JITTER_FRAC)
    return max(0.05, sleep_s * scale)


def _request_with_backoff(params: dict) -> dict:
    """GET BASE_URL with exponential backoff + jitter on 429/5xx.

    Returns parsed JSON. Raises requests.HTTPError on a non-retryable
    response (4xx other than 429) or ``RuntimeError`` after exhausting
    retries.
    """
    for attempt in range(MAX_RETRIES):
        resp = requests.get(BASE_URL, params=params, timeout=30)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429 or resp.status_code >= 500:
            retry_after = resp.headers.get("Retry-After")
            if retry_after:
                try:
                    planned = float(retry_after)
                except ValueError:
                    planned = min(2 ** attempt, 30)
            else:
                planned = min(2 ** attempt, 30)
            sleep_s = _jittered(planned)
            log.warning(
                "[rate-limit] HTTP %s, sleeping %.2fs (planned %.1fs, retry %d/%d)",
                resp.status_code,
                sleep_s,
                planned,
                attempt + 1,
                MAX_RETRIES,
            )
            time.sleep(sleep_s)
            continue
        # 4xx (other than 429): unrecoverable
        log.error(
            "[api-error] HTTP %s: %s", resp.status_code, resp.text[:500]
        )
        resp.raise_for_status()
    raise RuntimeError(f"Ticketmaster API exhausted retries ({MAX_RETRIES})")


def _fetch_paged(base_params: dict, force_refresh: bool, city_id: str,
                 city_tz: ZoneInfo, daily_budget: int) -> tuple[list[dict], int]:
    """Fetch all pages for one query. Returns (events, total_elements_reported).

    Each network call is reserved against the per-city per-day budget. A
    cache hit is free. If the budget is exhausted mid-query, ``BudgetExhausted``
    propagates up — the caller decides whether to keep partial results
    or fall back entirely.
    """
    events: list[dict] = []
    total_elements = 0
    page = 0
    total_pages = 1  # placeholder until first response

    while page < total_pages:
        params = {**base_params, "page": page, "size": PAGE_SIZE}
        cached, key = cache.get(BASE_URL, params)
        if cached is not None and not force_refresh:
            age = cache.age_minutes(BASE_URL, params) or 0
            log.info("[cache hit] %s page=%d age=%.0fm", key[:8], page, age)
            body = cached
        else:
            if not budget.reserve(city_id, city_tz, daily_budget):
                log.error(
                    "[budget] %s exhausted daily Ticketmaster budget — "
                    "serving cached forecast only",
                    city_id,
                )
                raise BudgetExhausted(city_id)
            log.info("[cache miss] %s page=%d fetching...", key[:8], page)
            time.sleep(INTER_REQUEST_SLEEP)
            body = _request_with_backoff(params)
            cache.set_(BASE_URL, params, body)

        page_info = body.get("page", {}) or {}
        total_elements = page_info.get("totalElements", 0)
        total_pages = page_info.get("totalPages", 0)
        embedded = body.get("_embedded") or {}
        page_events = embedded.get("events") or []
        events.extend(page_events)
        log.info(
            "  page %d/%d: +%d events (running total %d, totalElements=%d)",
            page,
            max(total_pages, 1),
            len(page_events),
            len(events),
            total_elements,
        )
        page += 1

        # Discovery API hard cap: page*size must stay under DEEP_PAGING_CAP.
        if page * PAGE_SIZE >= DEEP_PAGING_CAP:
            break

    return events, total_elements


def fetch_events(city_cfg: dict, api_key: str, window_days: int,
                 force_refresh: bool, daily_budget: int | None = None) -> tuple[list[dict], dict]:
    """Fetch all events for the configured city in a rolling window.

    Returns ``(events, meta)`` where meta describes the window for
    downstream output writers. The list is deduped by event.id.

    Raises ``BudgetExhausted`` if the per-city daily Ticketmaster budget
    is hit. The caller is expected to fall back to the previous
    forecast file and surface staleness to the operator.
    """
    city_id = city_cfg["id"]
    city_tz = ZoneInfo(city_cfg["timezone"])
    daily_budget = int(
        daily_budget
        if daily_budget is not None
        else (city_cfg.get("ticketmaster") or {}).get("daily_budget", budget.DEFAULT_DAILY_BUDGET)
    )
    start_local, end_local, day_keys = _window_for(city_tz, window_days)

    base_params = {
        "apikey": api_key,
        "city": city_cfg["ticketmaster"]["city_query"],
        "stateCode": city_cfg["state_code"],
        "countryCode": city_cfg["country_code"],
        "startDateTime": _iso_utc(start_local),
        "endDateTime": _iso_utc(end_local),
        "locale": "*",
        "sort": "date,asc",
    }
    log.info(
        "[fetch] city=%s window=%s..%s (%s) budget=%d/day calls_today=%d",
        city_id,
        start_local.date().isoformat(),
        end_local.date().isoformat(),
        city_cfg["timezone"],
        daily_budget,
        budget.get_state(city_id, city_tz, daily_budget)["calls"],
    )

    events, total_elements = _fetch_paged(
        base_params, force_refresh, city_id, city_tz, daily_budget,
    )

    if total_elements > DEEP_PAGING_CAP:
        log.warning(
            "[deep-paging] totalElements=%d exceeds %d cap; narrowing to per-day queries",
            total_elements,
            DEEP_PAGING_CAP,
        )
        events = []
        for day in day_keys:
            day_start = datetime.combine(day, dtime.min, tzinfo=city_tz)
            day_end = datetime.combine(day, dtime.max, tzinfo=city_tz)
            day_params = {
                **base_params,
                "startDateTime": _iso_utc(day_start),
                "endDateTime": _iso_utc(day_end),
            }
            day_events, _ = _fetch_paged(
                day_params, force_refresh, city_id, city_tz, daily_budget,
            )
            events.extend(day_events)

    deduped = _dedupe_by_id(events)
    state = budget.get_state(city_id, city_tz, daily_budget)
    meta = {
        "window_start": start_local.date().isoformat(),
        "window_end": end_local.date().isoformat(),
        "timezone": city_cfg["timezone"],
        "day_keys": [d.isoformat() for d in day_keys],
        "fetched_at": datetime.now(city_tz).isoformat(timespec="seconds"),
        "budget": state,
    }
    log.info(
        "[fetch] complete: %d events returned (%d after dedupe); calls_today=%d/%d",
        len(events), len(deduped), state["calls"], state["limit"],
    )
    return deduped, meta


def _dedupe_by_id(events: Iterable[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for ev in events:
        eid = ev.get("id")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        out.append(ev)
    return out
