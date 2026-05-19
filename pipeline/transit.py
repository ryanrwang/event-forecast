"""Per-day transit flagging.

Joins:
  * the reduced station set written by pipeline.gtfs
    (config/<city_id>/stations_reduced.json), AND
  * the per-day forecast events plus their avoid_windows (built by
    pipeline.timecurves.build_avoid_windows),

into a `transit_flags` section that the frontend can use to answer:

  "At bucket B, which stations are flagged, and which events caused it?"

The persisted shape pairs with `avoid_windows[]` to keep computation off
the client. Each entry in `transit_flags.events[]` lists the stations
near that event's venue and the lines that serve them. The frontend
walks avoid_windows[] for the current bucket, looks up each
event_id-keyed entry, and unions the stations.

Modeled, not measured: station "load" is inferred from venue proximity
and dispersal timing — this module never reads or computes a live
crowd/transit signal. All UI labels carry the modeled framing.

City-config driven: this module is called per city from pipeline.run.
Adding a city is a config-add; no code changes here.
"""

from __future__ import annotations

import logging

from .gtfs import STATION_RADIUS_M, haversine_m

log = logging.getLogger("pipeline.transit")


def _venue_index(venues: list[dict]) -> dict[str, dict]:
    return {v["id"]: v for v in venues if isinstance(v, dict) and v.get("id")}


def _stations_near_venue(
    venue_id: str,
    stations: list[dict],
) -> list[dict]:
    """Reverse-lookup from `venue_ids` baked into each reduced station."""
    out = []
    for s in stations:
        if venue_id in (s.get("venue_ids") or []):
            out.append(s)
    return out


def build_transit_flags(
    forecast_events: list[dict],
    venues: list[dict],
    stations: list[dict],
) -> dict:
    """Build the `transit_flags` payload for one day, one city.

    Each event entry carries:
      event_id, venue_id, stations: [{station_id, station_name, lat,
      lon, lines, distance_m}]

    Returns {"events": [...], "radius_m": <int>} so the client knows the
    proximity radius the flags were computed under (used in legend copy).
    Events with zero nearby stations are omitted to keep the payload tight.

    The kind of window (arrival vs dispersal) and the bucket interval
    are NOT duplicated here — they live in forecast.avoid_windows[]
    keyed by event_id, the single source of truth shared with the
    timeline bands. The frontend joins by event_id when scrubbing.
    """
    if not stations:
        return {"events": [], "radius_m": int(STATION_RADIUS_M)}

    venue_idx = _venue_index(venues)
    out_events = []

    for ev in forecast_events:
        venue_id = ev.get("venue_id")
        if not venue_id:
            continue
        venue = venue_idx.get(venue_id)
        if not venue:
            continue
        try:
            v_lat = float(venue["lat"])
            v_lon = float(venue["lon"])
        except (KeyError, TypeError, ValueError):
            continue

        nearby = _stations_near_venue(venue_id, stations)
        if not nearby:
            continue

        station_entries = []
        for s in nearby:
            distance_m = haversine_m(v_lat, v_lon, s["lat"], s["lon"])
            station_entries.append({
                "station_id": s["station_id"],
                "station_name": s["station_name"],
                "lat": s["lat"],
                "lon": s["lon"],
                "lines": list(s.get("lines") or []),
                "distance_m": round(distance_m, 1),
            })
        # Closest first — drives marker stacking + the rail's listing order.
        station_entries.sort(key=lambda e: e["distance_m"])

        out_events.append({
            "event_id": ev.get("id") or "",
            "venue_id": venue_id,
            "stations": station_entries,
        })

    log.info(
        "[transit] flagged %d/%d events with nearby stations (radius=%dm)",
        len(out_events), len(forecast_events), int(STATION_RADIUS_M),
    )
    return {"events": out_events, "radius_m": int(STATION_RADIUS_M)}
