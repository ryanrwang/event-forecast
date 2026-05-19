"""Static GTFS ingest — reduce each city's stop set to stations near its
whitelisted venues, with their line associations.

City-config driven from the top:
  * For each configured city, read `gtfs_static_source` from city.json
    (URL pointing at the agency's static GTFS zip, or a local zip path).
  * Download (with on-disk cache; 24h TTL) or open the local zip.
  * Reduce to stops within ~600m of any whitelist venue.
  * Aggregate routes (lines) that serve each surviving stop.
  * Write config/<city_id>/stations_reduced.json.

The output shape is intentionally minimal + agency-agnostic:
  [
    {
      "station_id": "...",
      "station_name": "...",
      "lat": 43.65,
      "lon": -79.38,
      "lines": ["1", "504"],         # route_short_name, deduped + sorted
      "venue_ids": ["scotiabank-arena", ...]
    },
    ...
  ]

This file is the SINGLE SOURCE OF TRUTH for the per-city reduced station
set. The per-day forecast JSON references stations by station_id; the
PHP layer joins lat/lon back in if needed, but the frontend reads coords
from the per-event transit_flags shipped inline.

Adding a second city is config-only: append its id to config/cities.json
and create config/<id>/city.json with a gtfs_static_source. This module
iterates the same cities list pipeline/run.py uses; no code changes.

Usage:
    python -m pipeline.gtfs                # all configured cities
    python -m pipeline.gtfs --city toronto
    python -m pipeline.gtfs --refresh      # bypass GTFS zip cache (re-download)

No realtime GTFS in this module or any other — overview §3 / M4 spec.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import math
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import requests

from .config import CONFIG_DIR, REPO_ROOT, load_cities_list, load_city_config

log = logging.getLogger("pipeline.gtfs")

# Station-to-venue proximity radius. 600m ≈ 7-8 min walk; covers downtown
# Toronto blocks where venues like Scotiabank Arena / Rogers Centre sit on
# top of multiple subway stations. Tuned in the modeling spec; do not
# change here without updating 01-modeling-spec.md.
STATION_RADIUS_M = 600.0

# Cached GTFS zip lifetime. Agencies refresh their static feeds on the
# order of weeks; 24h is comfortable for a daily cron and avoids hitting
# the agency mirror on every refresh.
GTFS_CACHE_TTL_SECONDS = 24 * 60 * 60

GTFS_CACHE_DIR = REPO_ROOT / "data" / "cache" / "gtfs"
# Mean Earth radius — converts haversine angular distance to meters.
EARTH_RADIUS_M = 6_371_000.0

# Same-station clustering. Many agencies (TTC included) ship one stop
# row per direction / platform / curb-side. Without clustering, a single
# subway station shows up as 3-5 nearly-overlapping markers. Stops are
# merged into a single station entry when:
#   * their normalized name matches (directional + side suffixes stripped), AND
#   * they sit within CLUSTER_RADIUS_M of the cluster's running centroid.
# The proximity guard prevents over-merging two genuinely-different stops
# that happen to share a name (e.g. unrelated "Main St" stops citywide).
CLUSTER_RADIUS_M = 250.0

# Name-normalization patterns. Order matters — strip the most-specific
# suffix first, then the simpler side qualifier. TTC strings look like:
#   "King Station - Southbound Platform"
#   "Union Station - Northbound Platform Towards Vaughan Metropolitan Centre"
#   "Bay St at Front St West South Side - Union Station"  (the trailing
#       station name is the parent we want to keep — so we DON'T strip
#       trailing " - X Station" here; only directional / side suffixes go)
_DIR_SUFFIX_RE = re.compile(
    r"\s*[-–]\s*(?:Northbound|Southbound|Eastbound|Westbound)"
    r"(?:\s+Platform)?(?:\s+Towards.*)?$",
    re.IGNORECASE,
)
_SIDE_SUFFIX_RE = re.compile(
    r"\s+(?:North|South|East|West)\s+Side\b",
    re.IGNORECASE,
)


def _clean_station_name(name: str) -> str:
    name = _DIR_SUFFIX_RE.sub("", name or "").strip()
    name = _SIDE_SUFFIX_RE.sub("", name).strip()
    return name

# Stop filtering. GTFS stops.txt can contain station entrances (children
# of a parent_station), platforms, and standalone bus stops. We promote
# children to their parent for stop_id grouping so a single subway
# station emits one entry, not five entrances.
LOCATION_TYPE_STOP    = "0"
LOCATION_TYPE_STATION = "1"


# ─────────── HTTP / cache ───────────

def _cache_path_for(city_id: str) -> Path:
    return GTFS_CACHE_DIR / f"{city_id}.zip"


def _is_cache_fresh(path: Path, ttl_seconds: int) -> bool:
    if not path.exists():
        return False
    age = time.time() - path.stat().st_mtime
    return age < ttl_seconds


def _download_zip(url: str, dest: Path) -> None:
    log.info("[gtfs] downloading %s", url)
    GTFS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if chunk:
                    fh.write(chunk)
    tmp.replace(dest)
    log.info("[gtfs] cached %.1f MB at %s", dest.stat().st_size / (1024 * 1024), dest)


def resolve_gtfs_zip(city_id: str, source: str, force_refresh: bool) -> Path:
    """Return a local Path to the GTFS zip for one city.

    `source` may be a URL or a local path. URLs are cached under
    data/cache/gtfs/<city_id>.zip with GTFS_CACHE_TTL_SECONDS TTL.
    """
    parsed = urlparse(source)
    if parsed.scheme in ("http", "https"):
        cache_path = _cache_path_for(city_id)
        if force_refresh or not _is_cache_fresh(cache_path, GTFS_CACHE_TTL_SECONDS):
            _download_zip(source, cache_path)
        else:
            age_min = (time.time() - cache_path.stat().st_mtime) / 60.0
            log.info("[gtfs] using cached zip (%.0fmin old): %s", age_min, cache_path)
        return cache_path

    # Local path. Resolve relative to repo root if not absolute.
    p = Path(source)
    if not p.is_absolute():
        p = (REPO_ROOT / p).resolve()
    if not p.exists():
        raise FileNotFoundError(f"GTFS source not found: {p}")
    return p


# ─────────── Geometry ───────────

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


# ─────────── GTFS parsing ───────────

def _open_gtfs_text(zf: zipfile.ZipFile, name: str) -> io.TextIOWrapper:
    """Open a GTFS file as text, tolerant of UTF-8 BOMs."""
    raw = zf.read(name)
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return io.StringIO(raw.decode("utf-8", errors="replace"))


def parse_stops(zf: zipfile.ZipFile) -> dict[str, dict]:
    """Return {stop_id -> {stop_name, lat, lon, location_type, parent_station}}.

    Stops without usable lat/lon are dropped. Bus stops have empty
    location_type; subway stations are "1", subway entrances "2", etc.
    """
    out: dict[str, dict] = {}
    with _open_gtfs_text(zf, "stops.txt") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            stop_id = (row.get("stop_id") or "").strip()
            if not stop_id:
                continue
            try:
                lat = float(row.get("stop_lat") or "")
                lon = float(row.get("stop_lon") or "")
            except ValueError:
                continue
            out[stop_id] = {
                "stop_name": (row.get("stop_name") or "").strip(),
                "lat": lat,
                "lon": lon,
                "location_type": (row.get("location_type") or "").strip(),
                "parent_station": (row.get("parent_station") or "").strip(),
            }
    log.info("[gtfs] parsed %d stops", len(out))
    return out


def parse_routes(zf: zipfile.ZipFile) -> dict[str, str]:
    """Return {route_id -> route_short_name (fallback long_name)}."""
    out: dict[str, str] = {}
    with _open_gtfs_text(zf, "routes.txt") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            rid = (row.get("route_id") or "").strip()
            if not rid:
                continue
            short = (row.get("route_short_name") or "").strip()
            long_ = (row.get("route_long_name") or "").strip()
            out[rid] = short or long_ or rid
    log.info("[gtfs] parsed %d routes", len(out))
    return out


def parse_trips_route_map(zf: zipfile.ZipFile) -> dict[str, str]:
    """Return {trip_id -> route_id}."""
    out: dict[str, str] = {}
    with _open_gtfs_text(zf, "trips.txt") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            tid = (row.get("trip_id") or "").strip()
            rid = (row.get("route_id") or "").strip()
            if tid and rid:
                out[tid] = rid
    log.info("[gtfs] parsed %d trips", len(out))
    return out


def collect_stop_routes(
    zf: zipfile.ZipFile,
    candidate_stop_ids: set[str],
    trip_to_route: dict[str, str],
) -> dict[str, set[str]]:
    """Stream stop_times.txt and accumulate {stop_id -> set(route_id)}.

    stop_times.txt is the largest GTFS file by far (TTC's runs into
    hundreds of MB). We DictReader-stream it once, ignoring rows for
    stops outside the candidate set so we never materialize the full
    table in memory.
    """
    out: dict[str, set[str]] = {sid: set() for sid in candidate_stop_ids}
    seen_rows = 0
    matched = 0
    with _open_gtfs_text(zf, "stop_times.txt") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            seen_rows += 1
            sid = (row.get("stop_id") or "").strip()
            if sid not in out:
                continue
            tid = (row.get("trip_id") or "").strip()
            rid = trip_to_route.get(tid)
            if rid:
                out[sid].add(rid)
                matched += 1
    log.info(
        "[gtfs] streamed %d stop_time rows; %d matched candidate stops",
        seen_rows, matched,
    )
    return out


# ─────────── Reduction ───────────

def build_candidate_stops(
    stops: dict[str, dict],
    venues: list[dict],
    radius_m: float,
) -> dict[str, list[str]]:
    """Return {stop_id -> [venue_id, ...]} for stops within radius of any venue.

    Each surviving stop carries the list of nearby venue ids. Stops that
    are "child" entries (location_type empty or "0" and parent_station
    set) are kept at the LEAF level so route attribution from stop_times
    works — we promote to the parent later, during the output build.
    """
    venue_pts = [
        (v["id"], float(v["lat"]), float(v["lon"]))
        for v in venues
        if isinstance(v.get("lat"), (int, float)) and isinstance(v.get("lon"), (int, float))
    ]
    out: dict[str, list[str]] = {}
    for stop_id, s in stops.items():
        near: list[str] = []
        for vid, vlat, vlon in venue_pts:
            if haversine_m(s["lat"], s["lon"], vlat, vlon) <= radius_m:
                near.append(vid)
        if near:
            out[stop_id] = near
    log.info("[gtfs] %d candidate stops within %.0fm of any venue", len(out), radius_m)
    return out


def group_to_parents(
    candidate_to_venues: dict[str, list[str]],
    stops: dict[str, dict],
    stop_routes: dict[str, set[str]],
) -> dict[str, dict]:
    """Collapse candidate stops to their parent station entry where one exists.

    Subway agencies model "station" as a parent (location_type=1) with
    multiple entrance/platform children. We want one output entry per
    station with routes aggregated from all its children. Standalone
    stops (no parent_station) pass through as-is.

    Returns {output_id -> {station_id, station_name, lat, lon,
    venue_ids, route_ids}}. route_ids is a set of route_ids ready for the
    name-lookup pass.
    """
    out: dict[str, dict] = {}

    def ensure(output_id: str, name: str, lat: float, lon: float) -> dict:
        if output_id not in out:
            out[output_id] = {
                "station_id": output_id,
                "station_name": name,
                "lat": lat,
                "lon": lon,
                "venue_ids": set(),
                "route_ids": set(),
            }
        return out[output_id]

    for stop_id, venue_ids in candidate_to_venues.items():
        s = stops.get(stop_id)
        if not s:
            continue
        parent_id = s.get("parent_station") or ""
        if parent_id and parent_id in stops:
            ps = stops[parent_id]
            entry = ensure(parent_id, ps["stop_name"], ps["lat"], ps["lon"])
        else:
            entry = ensure(stop_id, s["stop_name"], s["lat"], s["lon"])
        entry["venue_ids"].update(venue_ids)
        entry["route_ids"].update(stop_routes.get(stop_id, set()))

    # Some parent stations have route attribution only via their children;
    # if a parent itself appeared in the candidate set (rare — would be
    # an agency that places location_type=1 entries inside the radius),
    # pull in its routes too.
    for output_id, entry in out.items():
        entry["route_ids"].update(stop_routes.get(output_id, set()))

    return out


def cluster_stations(grouped: dict[str, dict]) -> list[dict]:
    """Merge same-name nearby stops into a single station entry.

    Greedy single-pass clustering keyed on the directional-stripped name.
    A stop joins an existing cluster when its cleaned name matches AND it
    sits within CLUSTER_RADIUS_M of that cluster's running centroid.
    Otherwise it seeds a new cluster.

    Output entries carry the union of `venue_ids` + `route_ids` across
    constituent stops, plus the centroid lat/lon and the cleanest name
    (longest non-directional name from the cluster — captures e.g.
    "Union Station" over "Union Station" but lets a "1 Front St West -
    Union Station" be subsumed into the canonical station).
    """
    clusters_by_name: dict[str, list[dict]] = {}
    for entry in grouped.values():
        clean = _clean_station_name(entry["station_name"]) or entry["station_name"]
        candidates = clusters_by_name.setdefault(clean, [])
        joined = False
        for c in candidates:
            if haversine_m(entry["lat"], entry["lon"], c["lat"], c["lon"]) <= CLUSTER_RADIUS_M:
                # Online centroid update keeps adds cheap.
                n = c["_count"]
                c["lat"] = (c["lat"] * n + entry["lat"]) / (n + 1)
                c["lon"] = (c["lon"] * n + entry["lon"]) / (n + 1)
                c["_count"] = n + 1
                c["venue_ids"].update(entry["venue_ids"])
                c["route_ids"].update(entry["route_ids"])
                # Keep the cleanest name we've seen — prefer one ending
                # in "Station" over a generic intersection label.
                if "station" in entry["station_name"].lower() and "station" not in c["display_name"].lower():
                    c["display_name"] = clean
                c["member_ids"].append(entry["station_id"])
                joined = True
                break
        if not joined:
            candidates.append({
                "station_id": entry["station_id"],   # seed id; final id is reassigned below
                "display_name": clean,
                "lat": entry["lat"],
                "lon": entry["lon"],
                "_count": 1,
                "venue_ids": set(entry["venue_ids"]),
                "route_ids": set(entry["route_ids"]),
                "member_ids": [entry["station_id"]],
            })

    out = []
    for clusters in clusters_by_name.values():
        out.extend(clusters)
    return out


def finalize_stations(
    grouped: dict[str, dict],
    route_names: dict[str, str],
) -> list[dict]:
    """Cluster, then sort + dedup line names, sort station list deterministically."""
    clustered = cluster_stations(grouped)
    out: list[dict] = []
    for c in clustered:
        lines = sorted(
            {route_names.get(rid, rid) for rid in c["route_ids"] if rid},
            key=_route_sort_key,
        )
        venue_ids = sorted(c["venue_ids"])
        # Stable station id = the smallest member stop_id, so the value
        # is deterministic across reruns and a frontend reference to it
        # survives a feed refresh (as long as the member stop persists).
        station_id = min(c["member_ids"])
        out.append({
            "station_id": station_id,
            "station_name": c["display_name"],
            "lat": round(c["lat"], 6),
            "lon": round(c["lon"], 6),
            "lines": lines,
            "venue_ids": venue_ids,
        })
    out.sort(key=lambda s: (s["station_name"], s["station_id"]))
    return out


def _route_sort_key(name: str):
    """Sort routes: numeric first (ascending), then alphabetic. Keeps the
    TTC subway lines 1/2/3/4 ahead of streetcar/bus route numbers and
    those ahead of named/letter routes."""
    try:
        return (0, int(name), name)
    except (TypeError, ValueError):
        return (1, 0, name)


# ─────────── Per-city driver ───────────

def refresh_city(city_id: str, force_refresh: bool) -> int:
    """Refresh stations_reduced.json for one configured city. Returns 0 ok, 1 fail.

    Skips quietly (returns 0) when the city has no gtfs_static_source —
    so a partly-configured city in the iterator doesn't fail the whole run.
    """
    log.info("[gtfs] === processing city: %s ===", city_id)
    try:
        city_cfg = load_city_config(city_id)
    except SystemExit:
        return 1

    source = (city_cfg.get("gtfs_static_source") or "").strip()
    if not source:
        log.warning("[gtfs] %s has no gtfs_static_source; skipping", city_id)
        return 0

    try:
        zip_path = resolve_gtfs_zip(city_id, source, force_refresh)
    except Exception as exc:
        log.error("[gtfs] failed to resolve GTFS zip for %s: %s", city_id, exc)
        return 1

    venues = city_cfg.get("venues") or []
    if not venues:
        log.warning("[gtfs] %s has no venues; writing empty station set", city_id)
        _write_stations(city_id, [])
        return 0

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = set(zf.namelist())
            for required in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
                if required not in names:
                    log.error("[gtfs] %s zip missing %s", city_id, required)
                    return 1

            stops = parse_stops(zf)
            routes = parse_routes(zf)
            trip_to_route = parse_trips_route_map(zf)

            candidate_to_venues = build_candidate_stops(stops, venues, STATION_RADIUS_M)
            if not candidate_to_venues:
                log.warning("[gtfs] %s: no stops within %dm of any venue", city_id, STATION_RADIUS_M)
                _write_stations(city_id, [])
                return 0

            stop_routes = collect_stop_routes(zf, set(candidate_to_venues.keys()), trip_to_route)
    except zipfile.BadZipFile as exc:
        log.error("[gtfs] %s: invalid GTFS zip at %s: %s", city_id, zip_path, exc)
        return 1

    grouped = group_to_parents(candidate_to_venues, stops, stop_routes)
    stations = finalize_stations(grouped, routes)
    _write_stations(city_id, stations)
    log.info(
        "[gtfs] %s: wrote %d reduced stations (radius=%dm)",
        city_id, len(stations), int(STATION_RADIUS_M),
    )
    return 0


def _write_stations(city_id: str, stations: list[dict]) -> None:
    """Write config/<city_id>/stations_reduced.json (atomic via tmp + replace)."""
    out_path = CONFIG_DIR / city_id / "stations_reduced.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(stations, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(out_path)


def load_reduced_stations(city_id: str) -> list[dict]:
    """Load config/<city_id>/stations_reduced.json. Returns [] if missing.

    pipeline.run uses this every refresh to compute per-day transit flags.
    Missing file is non-fatal: the city's forecast JSON simply ships no
    transit_flags, the frontend skips the layer, and the operator gets a
    clear "run python -m pipeline.gtfs" log line.
    """
    path = CONFIG_DIR / city_id / "stations_reduced.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        log.error("[gtfs] %s stations file is malformed: %s", city_id, path)
        return []
    return data if isinstance(data, list) else []


# ─────────── CLI ───────────

def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    parser = argparse.ArgumentParser(prog="pipeline.gtfs")
    parser.add_argument(
        "--city",
        default=None,
        help="refresh a single city by id (defaults to every city in config/cities.json)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="bypass the cached GTFS zip (force re-download)",
    )
    args = parser.parse_args(argv)

    if args.city:
        cities = [args.city]
    else:
        cities = load_cities_list()
    log.info("[gtfs] processing %d city/cities: %s", len(cities), cities)

    failures = 0
    for city_id in cities:
        rc = refresh_city(city_id, force_refresh=args.refresh)
        if rc != 0:
            failures += 1

    if failures:
        log.error("[gtfs] %d/%d cities failed", failures, len(cities))
        return failures
    return 0


if __name__ == "__main__":
    sys.exit(main())
