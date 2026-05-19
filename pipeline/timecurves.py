"""Per-event time curves, daily busyness timeline, and peak-bucket
heatmap inputs.

The math here is LOCKED by the M2 modeling spec (overview §4 + the M2
prompt). Do not tune constants in this file — calibration changes go
through 01-modeling-spec.md + 10-decisions-log.md first.

Outputs (all consumed by the frontend via forecast.json):
  * Per-event `time_curve` — 96 floats in [0, 1] representing street
    presence weight per 15-minute bucket, before multiplying by impact.
  * Per-event `sigma_m` — Gaussian sigma in meters for distance decay.
  * Per-event `peak_intensity` — venue intensity at the day's peak
    bucket (= impact * time_curve[peak_bucket]).
  * Day-level `timeline` — 96 floats = sum over events of
    impact * time_curve.
  * Day-level `peak_bucket` — argmax index of `timeline`.

The heatmap is summed on the JavaScript side from per-event venue
intensities and sigmas (see the M2 prompt's implementation latitude).
This keeps forecast.json compact and makes the M3 scrubber trivial:
the client recomputes intensity at any bucket as impact * time_curve[b].
"""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

BUCKETS_PER_DAY = 96
BUCKET_MINUTES = 15

# Arrival ramp window: from start-120m to peak at start-15m.
ARRIVAL_LEAD_MIN = 120
ARRIVAL_PEAK_MIN = 15
ARRIVAL_RAMP_MIN = ARRIVAL_LEAD_MIN - ARRIVAL_PEAK_MIN  # 105m

# During-event background street presence (fraction of arrival peak).
DURING_BACKGROUND = 0.10
# Festival has a mild in/out flow on top of background during the window.
FESTIVAL_DURING = 0.20

# Dispersal tail: chosen so that v(tail_minutes_to_10pct) = 0.10, i.e. the
# 90% mark from the spec. k = -ln(0.10) / tail_minutes_to_10pct.
#
# DISPERSAL_TAIL_MIN is the single source of truth for the per-category
# tail length. It drives BOTH the time-curve decay constants below AND
# the operator-facing avoid window (timeline bands + transit flags). M4
# added the third consumer (transit station flagging) — anything that
# needs "how long does the dispersal effect last by category" reads this
# dict; do not redefine these numbers anywhere else.
DISPERSAL_TAIL_MIN: dict[str, int] = {
    "major_concert":   45,
    "performing_arts": 45,
    "comedy":          45,
    "family_other":    45,
    "arena_sports":    75,
    "festival":        120,
}
_DEFAULT_TAIL_MIN = DISPERSAL_TAIL_MIN["family_other"]

# Operator-facing "avoid arrival" window: tighter than the modeling
# arrival ramp (which starts at start-120). 90→15 is the stretch where
# queues / sidewalks / transit ramps actually saturate. Shared with the
# frontend timeline + the M4 transit flagging.
AVOID_ARRIVAL_LEAD_MIN  = 90
AVOID_ARRIVAL_TRAIL_MIN = 15

_LN10 = math.log(10.0)
_DISPERSAL_K_SHARP    = _LN10 / DISPERSAL_TAIL_MIN["major_concert"]   # 45m
_DISPERSAL_K_GRADUAL  = _LN10 / DISPERSAL_TAIL_MIN["arena_sports"]    # 75m
_DISPERSAL_K_DIFFUSE  = _LN10 / DISPERSAL_TAIL_MIN["festival"]        # 120m
_DISPERSAL_K_DEFAULT  = _DISPERSAL_K_SHARP


def dispersal_tail_min(category: str) -> int:
    """Per-category dispersal tail length in minutes. See DISPERSAL_TAIL_MIN."""
    return DISPERSAL_TAIL_MIN.get(category, _DEFAULT_TAIL_MIN)

# Distance-decay sigma. sigma_m = min(250 + impact*40, 1200).
SIGMA_BASE_M    = 250.0
SIGMA_PER_IMPACT = 40.0
SIGMA_CAP_M     = 1200.0


def _dispersal_k(category: str) -> float:
    if category == "arena_sports":
        return _DISPERSAL_K_GRADUAL
    if category == "festival":
        return _DISPERSAL_K_DIFFUSE
    if category in ("major_concert", "performing_arts", "comedy", "family_other"):
        return _DISPERSAL_K_SHARP
    return _DISPERSAL_K_DEFAULT


def _during_baseline(category: str) -> float:
    return FESTIVAL_DURING if category == "festival" else DURING_BACKGROUND


def sigma_m_for_impact(impact: float) -> float:
    return min(SIGMA_BASE_M + max(impact, 0.0) * SIGMA_PER_IMPACT, SIGMA_CAP_M)


def build_time_curve(
    start_local: datetime,
    end_local: datetime,
    category: str,
    day_local: date,
    tz: ZoneInfo,
) -> list[float]:
    """Return the 96-bucket street presence curve for one event on one day.

    Values are in [0, 1], evaluated at the CENTER of each 15-minute bucket
    in the city-local timezone. The curve is clamped to the day window —
    arrival/dispersal portions that cross midnight contribute only to
    their own day's array.

    Math (per modeling spec):
      arrival(t)   = 0.5 - 0.5*cos(pi * (t - (start-120m)) / 105m)
                       for t in [start-120m, start-15m]
                       (smooth, monotonic 0 -> 1, peak 1 at start-15m)
      during(t)    = 0.10 (or 0.20 for festival)
                       for t in [start-15m, end]
      dispersal(t) = exp(-k_cat * (t - end))
                       for t > end, peak 1 at t = end
      v(t)         = max(arrival, during, dispersal) within their regions
    """
    curve = [0.0] * BUCKETS_PER_DAY

    day_start = datetime.combine(day_local, time(0, 0)).replace(tzinfo=tz)
    arrival_start = start_local - timedelta(minutes=ARRIVAL_LEAD_MIN)
    arrival_peak  = start_local - timedelta(minutes=ARRIVAL_PEAK_MIN)
    during_bg = _during_baseline(category)
    k = _dispersal_k(category)

    for b in range(BUCKETS_PER_DAY):
        bucket_dt = day_start + timedelta(minutes=b * BUCKET_MINUTES + BUCKET_MINUTES / 2.0)

        v = 0.0

        if arrival_start <= bucket_dt < arrival_peak:
            elapsed_min = (bucket_dt - arrival_start).total_seconds() / 60.0
            arr = 0.5 - 0.5 * math.cos(math.pi * elapsed_min / ARRIVAL_RAMP_MIN)
            if arr > v:
                v = arr

        if arrival_peak <= bucket_dt <= end_local:
            if during_bg > v:
                v = during_bg

        if bucket_dt > end_local:
            dt_min = (bucket_dt - end_local).total_seconds() / 60.0
            disp = math.exp(-k * dt_min)
            if disp > v:
                v = disp

        # Drop near-zero noise to keep JSON small after rounding.
        if v < 1e-4:
            v = 0.0
        curve[b] = round(v, 4)

    return curve


def build_event_curves(
    forecast_events: list[dict],
    day_local_iso: str,
    tz: ZoneInfo,
) -> None:
    """Mutate each event in-place to add `time_curve`, `sigma_m`,
    `peak_intensity` (the last is filled in by the caller once the day's
    peak bucket is known).

    Reads `start_local` and `end_local` (ISO strings) and `category` from
    each event entry. Events whose times can't be parsed get a zero curve
    so the day-level sum still works.
    """
    day_local = date.fromisoformat(day_local_iso)
    for ev in forecast_events:
        category = ev.get("category") or "family_other"
        impact = float(ev.get("impact") or 0.0)
        start_iso = ev.get("start_local")
        end_iso = ev.get("end_local")
        try:
            start_local = datetime.fromisoformat(start_iso)
            end_local = datetime.fromisoformat(end_iso)
        except (TypeError, ValueError):
            ev["time_curve"] = [0.0] * BUCKETS_PER_DAY
            ev["sigma_m"] = round(sigma_m_for_impact(impact), 1)
            continue

        if start_local.tzinfo is None:
            start_local = start_local.replace(tzinfo=tz)
        if end_local.tzinfo is None:
            end_local = end_local.replace(tzinfo=tz)

        ev["time_curve"] = build_time_curve(start_local, end_local, category, day_local, tz)
        ev["sigma_m"] = round(sigma_m_for_impact(impact), 1)


def build_daily_timeline(forecast_events: list[dict]) -> list[float]:
    """Sum impact * time_curve across every event into a 96-bucket timeline."""
    timeline = [0.0] * BUCKETS_PER_DAY
    for ev in forecast_events:
        impact = float(ev.get("impact") or 0.0)
        curve = ev.get("time_curve") or []
        if not curve:
            continue
        for b, w in enumerate(curve):
            if w:
                timeline[b] += impact * w
    return [round(v, 3) for v in timeline]


def pick_peak_bucket(timeline: list[float]) -> tuple[int, float]:
    """Return (argmax_index, max_value). All-zero timeline picks bucket 0."""
    peak_idx = 0
    peak_val = 0.0
    for b, v in enumerate(timeline):
        if v > peak_val:
            peak_val = v
            peak_idx = b
    return peak_idx, peak_val


def annotate_peak_intensity(forecast_events: list[dict], peak_bucket: int) -> None:
    """Fill in `peak_intensity` per event = impact * time_curve[peak_bucket]."""
    for ev in forecast_events:
        impact = float(ev.get("impact") or 0.0)
        curve = ev.get("time_curve") or []
        if 0 <= peak_bucket < len(curve):
            ev["peak_intensity"] = round(impact * curve[peak_bucket], 3)
        else:
            ev["peak_intensity"] = 0.0


def _intersect_minute_range_with_day(from_min: float, to_min: float) -> tuple[float, float] | None:
    """Clip [from_min, to_min] to the displayed day [0, 1440]; return None if disjoint."""
    if to_min <= 0 or from_min >= 24 * 60:
        return None
    lo = max(0.0, from_min)
    hi = min(24.0 * 60.0, to_min)
    if hi <= lo:
        return None
    return lo, hi


def build_avoid_windows(
    forecast_events: list[dict],
    day_local_iso: str,
    tz: ZoneInfo,
) -> list[dict]:
    """Return per-event avoid-window entries for the displayed day.

    Each entry: {event_id, kind ("arrival"|"dispersal"), from_bucket,
    to_bucket, from_minute, to_minute}. Buckets are fractional in
    [0, 96]. Windows that don't intersect the displayed day are omitted.

    Single source of truth for the operator-facing "avoid" window across
    three consumers: the timeline band rendering, the M4 transit-station
    flagging, and any future per-event window UI. Centralizing here keeps
    a category-tail change a one-file edit.
    """
    day_local = date.fromisoformat(day_local_iso)
    out: list[dict] = []
    for ev in forecast_events:
        event_id = ev.get("id") or ""
        category = ev.get("category") or "family_other"
        start_iso = ev.get("start_local")
        end_iso = ev.get("end_local")
        try:
            start_local = datetime.fromisoformat(start_iso) if start_iso else None
            end_local = datetime.fromisoformat(end_iso) if end_iso else None
        except (TypeError, ValueError):
            continue
        if start_local is None or end_local is None:
            continue
        if start_local.tzinfo is None:
            start_local = start_local.replace(tzinfo=tz)
        if end_local.tzinfo is None:
            end_local = end_local.replace(tzinfo=tz)

        day_start = datetime.combine(day_local, time(0, 0)).replace(tzinfo=tz)

        # Convert event start/end to minutes-since-day_start.
        start_min = (start_local - day_start).total_seconds() / 60.0
        end_min = (end_local - day_start).total_seconds() / 60.0

        # Arrival window: start-90 .. start-15.
        arr_from = start_min - AVOID_ARRIVAL_LEAD_MIN
        arr_to = start_min - AVOID_ARRIVAL_TRAIL_MIN
        arr = _intersect_minute_range_with_day(arr_from, arr_to)
        if arr is not None:
            lo, hi = arr
            out.append({
                "event_id": event_id,
                "kind": "arrival",
                "from_minute": round(lo, 1),
                "to_minute": round(hi, 1),
                "from_bucket": round(lo / BUCKET_MINUTES, 3),
                "to_bucket": round(hi / BUCKET_MINUTES, 3),
            })

        # Dispersal window: end .. end + tail.
        tail = dispersal_tail_min(category)
        disp_from = end_min
        disp_to = end_min + tail
        disp = _intersect_minute_range_with_day(disp_from, disp_to)
        if disp is not None:
            lo, hi = disp
            out.append({
                "event_id": event_id,
                "kind": "dispersal",
                "from_minute": round(lo, 1),
                "to_minute": round(hi, 1),
                "from_bucket": round(lo / BUCKET_MINUTES, 3),
                "to_bucket": round(hi / BUCKET_MINUTES, 3),
            })
    return out
