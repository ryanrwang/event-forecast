"""Impact scoring and daily verdict.

Constants below are LOCKED by the M1 modeling spec. Do not tune them
here — calibration adjustments go through the modeling spec + decisions
log first, then propagate to this file. Verdict thresholds are
documented placeholders awaiting calibration (see 10-decisions-log.md).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# Per-category multiplier from the modeling spec.
CATEGORY_WEIGHT = {
    "arena_sports":    1.0,
    "major_concert":   1.0,
    "festival":        0.9,
    "performing_arts": 0.45,
    "comedy":          0.4,
    "family_other":    0.5,
}
_DEFAULT_CATEGORY = "family_other"

# Verdict thresholds. PLACEHOLDERS — to be calibrated against a
# representative Toronto week. See 10-decisions-log.md.
T1 = 5.0   # < T1            -> Quiet
T2 = 15.0  # T1..T2          -> Moderate
T3 = 30.0  # T2..T3          -> Busy
           # >= T3           -> Severe

# Time-of-day concentration weights for the M1 verdict proxy. The real
# 15-minute busyness timeline lands in M3; until then, we sum impacts
# tilted toward prime-time. PLACEHOLDER — to be revisited in M3.
_TOD_BANDS = (
    (0,  12, 0.6),   # morning
    (12, 18, 0.8),   # afternoon
    (18, 22, 1.0),   # prime evening
    (22, 27, 0.9),   # late (extends past midnight)
)


def _tod_weight(local_hour: int) -> float:
    h = local_hour if local_hour >= 0 else 0
    for start, end, weight in _TOD_BANDS:
        if start <= h < end:
            return weight
    return 0.7  # fallback for unexpected hours


def _parse_tm_dt(dt_str: str | None) -> datetime | None:
    if not dt_str:
        return None
    try:
        # TM uses ISO 8601 ending in 'Z'; Python 3.11+ handles 'Z' natively.
        return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except ValueError:
        return None


def event_times_local(event: dict, tz: ZoneInfo) -> tuple[datetime | None, datetime | None]:
    """Return (start_local, end_local) for an event, in the city's tz.

    Falls back to start + 3h when Ticketmaster omits the end time.
    """
    dates = (event.get("dates") or {}).get("start") or {}
    start_dt = _parse_tm_dt(dates.get("dateTime"))
    if start_dt is None:
        local_date = dates.get("localDate")
        local_time = dates.get("localTime") or "19:00:00"
        if not local_date:
            return None, None
        try:
            start_dt = datetime.fromisoformat(f"{local_date}T{local_time}").replace(tzinfo=tz)
        except ValueError:
            return None, None
    start_local = start_dt.astimezone(tz)

    end_dt = _parse_tm_dt((event.get("dates") or {}).get("end", {}).get("dateTime") if event.get("dates") else None)
    end_local = end_dt.astimezone(tz) if end_dt else start_local + timedelta(hours=3)
    return start_local, end_local


def score_event(event: dict, venue: dict, tz: ZoneInfo) -> float | None:
    """Compute the impact score for a single matched event.

    Returns None when the event can't be parsed (no usable start time).
    Formula (spec, exact):
        capacity_factor = capacity / 1000
        category_weight per CATEGORY_WEIGHT (unknown -> family_other)
        day_weight   = 1.10 if Fri/Sat local, 1.00 if Sun, else 0.95
        late_weight  = 1.15 if local end >= 22:00, else 1.00
        impact       = capacity_factor * category_weight * day_weight * late_weight
    """
    start_local, end_local = event_times_local(event, tz)
    if start_local is None or end_local is None:
        return None

    capacity = int(venue.get("capacity") or 0)
    capacity_factor = capacity / 1000.0

    category = venue.get("category") or _DEFAULT_CATEGORY
    category_weight = CATEGORY_WEIGHT.get(category, CATEGORY_WEIGHT[_DEFAULT_CATEGORY])

    # Python weekday(): Mon=0 ... Sun=6.
    dow = start_local.weekday()
    if dow in (4, 5):           # Fri, Sat
        day_weight = 1.10
    elif dow == 6:              # Sun
        day_weight = 1.00
    else:                       # Mon-Thu
        day_weight = 0.95

    late_weight = 1.15 if end_local.hour >= 22 or end_local.day != start_local.day else 1.00

    return round(capacity_factor * category_weight * day_weight * late_weight, 3)


def proxy_contribution(impact: float | None, start_local) -> float:
    """One event's share of the daily peak_proxy (impact × TOD weight).

    Shipped per event in forecast.json so the frontend's
    verdict-follows-filter toggle can re-bucket a filtered day against
    THRESHOLDS without duplicating the TOD weighting in JS. Uses the
    same defaults as daily_verdict (missing start → prime time).
    """
    if impact is None:
        return 0.0
    hour = start_local.hour if isinstance(start_local, datetime) else 19
    return round(float(impact) * _tod_weight(hour), 3)


def daily_verdict(day_events: list[dict]) -> tuple[str, float]:
    """Return (verdict_label, peak_proxy) for one day's scored events.

    peak_proxy is the time-of-day-weighted sum of event impacts. M1 uses
    this as a coarse proxy until the M3 timeline produces a true peak.
    Verdict label is bucketed against T1/T2/T3.
    """
    peak = 0.0
    for ev in day_events:
        impact = ev.get("impact")
        if impact is None:
            continue
        start_local = ev.get("_start_local")
        hour = start_local.hour if isinstance(start_local, datetime) else 19  # default prime time
        peak += float(impact) * _tod_weight(hour)

    peak = round(peak, 2)

    if peak < T1:
        label = "Quiet"
    elif peak < T2:
        label = "Moderate"
    elif peak < T3:
        label = "Busy"
    else:
        label = "Severe"
    return label, peak


THRESHOLDS = {"T1": T1, "T2": T2, "T3": T3}
