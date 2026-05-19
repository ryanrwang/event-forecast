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
_LN10 = math.log(10.0)
_DISPERSAL_K_SHARP    = _LN10 / 45.0   # major_concert, performing_arts, comedy
_DISPERSAL_K_GRADUAL  = _LN10 / 75.0   # arena_sports
_DISPERSAL_K_DIFFUSE  = _LN10 / 120.0  # festival
_DISPERSAL_K_DEFAULT  = _DISPERSAL_K_SHARP

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
