"""Per-day transit flagging.

Joins three inputs into a `transit_flags` section the frontend can use
to answer "which stations are likely packed, and when":

  * the curated venue → station map in
    ``config/<city_id>/venue_stations.json`` (subway + GO stations,
    hand-picked per venue — the source of truth for the station list),
  * the reduced GTFS station set written by ``pipeline.gtfs``
    (``config/<city_id>/stations_reduced.json``), used only for
    streetcar stops near a venue (bus stops are dropped), and
  * the per-day forecast events plus their avoid_windows (built by
    ``pipeline.timecurves.build_avoid_windows``).

Every station carries a ``kind`` — "subway", "go", "streetcar" or "bus"
— so the frontend can show subway by default and put streetcar and GO
behind toggles. Bus stops never ship.

Why a curated map instead of a radius: with roughly a dozen venues per
city, a hand list is both shorter and more honest. Several Toronto
venues (Rogers Centre, BMO Field, Rogers Stadium) have no subway station
inside a 600 m circle yet still funnel crowds into specific stations,
sometimes via a streetcar ("via" on the entry). A radius either misses
those or drags in forty bus stops.

The persisted shape pairs with `avoid_windows[]`: each entry in
`transit_flags.events[]` lists the stations for that event; the
frontend walks avoid_windows[] for the current bucket, looks up each
event_id-keyed entry, and unions the stations.

Modeled, not measured: station "load" is inferred from venue proximity
and dispersal timing — this module never reads or computes a live
crowd/transit signal. All UI labels carry the modeled framing.

City-config driven: this module is called per city from pipeline.run.
Adding a city is a config-add; no code changes here.
"""

from __future__ import annotations

import json
import logging
import re

from .config import CONFIG_DIR
from .gtfs import STATION_RADIUS_M, haversine_m

log = logging.getLogger("pipeline.transit")

STATION_KINDS = ("subway", "go", "streetcar", "bus")
_KIND_ORDER = {"subway": 0, "go": 1, "streetcar": 2, "bus": 3}
_DEFAULT_KEEP_KINDS = ("subway", "streetcar")
_CURATED_ID_PREFIX = "st:"
# Streetcar stops are dense (a theatre block can have 15 within 600 m).
# Ship only the nearest few per event — enough to name the lines and
# the loop, not enough to bury the subway rows behind the toggle.
STREETCAR_MAX_PER_EVENT = 4


# ─────────── Config loaders ───────────

def load_venue_stations(city_id: str) -> dict:
    """Load config/<city_id>/venue_stations.json.

    Returns ``{"stations": {id: station}, "venues": {venue_id: [ref]}}``;
    both maps are empty when the file is missing or malformed, in which
    case the GTFS-derived subway stations act as a fallback.
    """
    empty = {"stations": {}, "venues": {}}
    path = CONFIG_DIR / city_id / "venue_stations.json"
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        log.error("[transit] %s unreadable (%s); ignoring", path, exc)
        return empty
    if not isinstance(data, dict):
        return empty
    stations: dict[str, dict] = {}
    for s in data.get("stations") or []:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        try:
            lat = float(s["lat"])
            lon = float(s["lon"])
        except (KeyError, TypeError, ValueError):
            log.warning("[transit] station %s has no lat/lon; skipped", s.get("id"))
            continue
        kind = (s.get("kind") or "subway").lower()
        if kind not in STATION_KINDS:
            kind = "subway"
        stations[str(s["id"])] = {
            "id": str(s["id"]),
            "name": s.get("name") or str(s["id"]),
            "kind": kind,
            "lines": [str(l) for l in (s.get("lines") or [])],
            "lat": lat,
            "lon": lon,
        }
    venues_map: dict[str, list[dict]] = {}
    for venue_id, refs in (data.get("venues") or {}).items():
        if not isinstance(refs, list):
            continue
        clean = []
        for r in refs:
            if isinstance(r, str):
                r = {"station": r}
            if not isinstance(r, dict) or not r.get("station"):
                continue
            if str(r["station"]) not in stations:
                log.warning("[transit] venue %s references unknown station %s", venue_id, r["station"])
                continue
            clean.append({
                "station": str(r["station"]),
                "walk_min": r.get("walk_min"),
                "via": r.get("via") or "",
            })
        venues_map[str(venue_id)] = clean
    return {"stations": stations, "venues": venues_map}


def _transit_cfg(city_cfg: dict | None) -> dict:
    raw = (city_cfg or {}).get("transit") or {}
    keep = raw.get("keep_kinds") or list(_DEFAULT_KEEP_KINDS)
    try:
        pattern = re.compile(raw.get("streetcar_route_pattern") or r"^5\d\d$")
    except re.error:
        pattern = re.compile(r"^5\d\d$")
    try:
        radius = float(raw.get("streetcar_radius_m") or STATION_RADIUS_M)
    except (TypeError, ValueError):
        radius = STATION_RADIUS_M
    return {
        "subway_lines": {str(l) for l in (raw.get("subway_lines") or [])},
        "streetcar_pattern": pattern,
        "keep_kinds": [k for k in keep if k in STATION_KINDS],
        "streetcar_radius_m": radius,
    }


def classify_station_kind(station: dict, transit_cfg: dict) -> str:
    """Kind for a GTFS-derived station.

    Prefers the ``kind`` the GTFS reducer wrote from route_type. Station
    files generated before that field existed are classified from their
    line names using the city config's subway line list and streetcar
    route pattern, so the fallback is still config-driven.
    """
    kind = (station.get("kind") or "").lower()
    if kind in STATION_KINDS:
        return kind
    lines = [str(l) for l in (station.get("lines") or [])]
    if any(l in transit_cfg["subway_lines"] for l in lines):
        return "subway"
    if any(transit_cfg["streetcar_pattern"].match(l) for l in lines):
        return "streetcar"
    return "bus"


# ─────────── Helpers ───────────

def _venue_index(venues: list[dict]) -> dict[str, dict]:
    return {v["id"]: v for v in venues if isinstance(v, dict) and v.get("id")}


def _stations_near_venue(venue_id: str, stations: list[dict]) -> list[dict]:
    """Reverse-lookup from `venue_ids` baked into each reduced station."""
    return [s for s in stations if venue_id in (s.get("venue_ids") or [])]


def _stations_near_point(lat: float, lon: float, stations: list[dict], radius_m: float) -> list[dict]:
    out = []
    for s in stations:
        try:
            if haversine_m(lat, lon, float(s["lat"]), float(s["lon"])) <= radius_m:
                out.append(s)
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _event_point(ev: dict, venue_idx: dict[str, dict]) -> tuple[float, float] | None:
    """Heat/transit anchor for an event: inline lat/lon (manual events)
    or the whitelisted venue's coordinates."""
    try:
        if ev.get("lat") is not None and ev.get("lon") is not None:
            return float(ev["lat"]), float(ev["lon"])
    except (TypeError, ValueError):
        pass
    venue = venue_idx.get(ev.get("venue_id") or "")
    if not venue:
        return None
    try:
        return float(venue["lat"]), float(venue["lon"])
    except (KeyError, TypeError, ValueError):
        return None


def _curated_entry(station: dict, ref: dict, origin: tuple[float, float]) -> dict:
    entry = {
        "station_id": _CURATED_ID_PREFIX + station["id"],
        "station_name": station["name"],
        "kind": station["kind"],
        "lines": list(station["lines"]),
        "lat": station["lat"],
        "lon": station["lon"],
        "distance_m": round(haversine_m(origin[0], origin[1], station["lat"], station["lon"]), 1),
    }
    if ref.get("walk_min") is not None:
        entry["walk_min"] = ref["walk_min"]
    if ref.get("via"):
        entry["via"] = ref["via"]
    return entry


def _gtfs_entry(station: dict, kind: str, origin: tuple[float, float], transit_cfg: dict) -> dict:
    lines = [str(l) for l in (station.get("lines") or [])]
    if kind == "streetcar":
        # A streetcar stop also lists the night buses that share the
        # pole; show only the streetcar routes so the pill row says what
        # the row is about.
        only = [l for l in lines if transit_cfg["streetcar_pattern"].match(l)]
        lines = only or lines
    return {
        "station_id": station["station_id"],
        "station_name": station["station_name"],
        "kind": kind,
        "lines": lines,
        "lat": station["lat"],
        "lon": station["lon"],
        "distance_m": round(haversine_m(origin[0], origin[1], station["lat"], station["lon"]), 1),
    }


# ─────────── Builder ───────────

def build_transit_flags(
    forecast_events: list[dict],
    venues: list[dict],
    stations: list[dict],
    city_cfg: dict | None = None,
    venue_stations: dict | None = None,
) -> dict:
    """Build the `transit_flags` payload for one day, one city.

    Each event entry carries:
      event_id, venue_id, stations: [{station_id, station_name, kind,
      lines, lat, lon, distance_m, walk_min?, via?}]

    Station sources, in order:
      1. Curated subway / GO stations for the venue (or, for a manual
         event, the station ids it names).
      2. GTFS-derived streetcar stops within the venue's radius, when
         "streetcar" is in the city's keep_kinds.
      3. GTFS-derived subway stations as a fallback ONLY when the venue
         has no curated entries — so a venue the operator forgot still
         gets something.
    Bus stops never ship. Stations sort subway → GO → streetcar, then by
    distance.

    Returns {"events": [...], "radius_m": <int>, "kinds": [...]} so the
    client knows which kinds can appear (drives the toggles) and the
    proximity radius the streetcar stops were computed under.
    """
    cfg = _transit_cfg(city_cfg)
    curated = venue_stations or {"stations": {}, "venues": {}}
    catalogue = curated.get("stations") or {}
    by_venue = curated.get("venues") or {}
    venue_idx = _venue_index(venues)
    keep = set(cfg["keep_kinds"]) | {"go"} if catalogue else set(cfg["keep_kinds"])

    out_events = []
    kinds_seen: set[str] = set()

    for ev in forecast_events:
        venue_id = ev.get("venue_id") or ""
        origin = _event_point(ev, venue_idx)
        if origin is None:
            continue

        entries: list[dict] = []
        seen_ids: set[str] = set()

        # 1. Curated stations.
        if ev.get("source") == "manual":
            refs = [{"station": sid} for sid in (ev.get("stations") or []) if sid in catalogue]
        else:
            refs = by_venue.get(venue_id, [])
        for ref in refs:
            st = catalogue.get(ref["station"])
            if not st:
                continue
            e = _curated_entry(st, ref, origin)
            if e["station_id"] in seen_ids:
                continue
            seen_ids.add(e["station_id"])
            entries.append(e)
        has_curated = bool(entries)

        # 2 + 3. GTFS-derived stops.
        if stations:
            if ev.get("source") == "manual":
                nearby = _stations_near_point(origin[0], origin[1], stations, cfg["streetcar_radius_m"])
            else:
                nearby = _stations_near_venue(venue_id, stations)
            for s in nearby:
                kind = classify_station_kind(s, cfg)
                if kind == "bus":
                    continue
                if kind == "subway" and has_curated:
                    continue  # curated list already covers subway for this venue
                if kind not in keep:
                    continue
                e = _gtfs_entry(s, kind, origin, cfg)
                if e["station_id"] in seen_ids:
                    continue
                seen_ids.add(e["station_id"])
                entries.append(e)

        if not entries:
            continue
        entries.sort(key=lambda e: (_KIND_ORDER.get(e["kind"], 9), e["distance_m"]))
        streetcar_kept = 0
        trimmed = []
        for e in entries:
            if e["kind"] == "streetcar":
                streetcar_kept += 1
                if streetcar_kept > STREETCAR_MAX_PER_EVENT:
                    continue
            trimmed.append(e)
        entries = trimmed
        kinds_seen.update(e["kind"] for e in entries)
        out_events.append({
            "event_id": ev.get("id") or "",
            "venue_id": venue_id,
            "stations": entries,
        })

    log.info(
        "[transit] flagged %d/%d events with stations (kinds=%s)",
        len(out_events), len(forecast_events),
        ",".join(sorted(kinds_seen)) or "none",
    )
    return {
        "events": out_events,
        "radius_m": int(cfg["streetcar_radius_m"]),
        "kinds": sorted(kinds_seen, key=lambda k: _KIND_ORDER.get(k, 9)),
    }
