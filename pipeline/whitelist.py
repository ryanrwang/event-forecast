"""Apply a venue whitelist to Ticketmaster events.

Matching uses, in order:
  1. exact Ticketmaster venue id (when the whitelist entry sets
     `ticketmaster_venue_id` — this beats name drift cold)
  2. normalized name match against `venues[*].name`
  3. normalized alias match against `venues[*].name` (alias spellings)

Unmatched venue names are returned to the caller so the operator can
see candidates for the whitelist sanity pass.
"""

from __future__ import annotations

import logging
import re
from collections import Counter

log = logging.getLogger("pipeline.whitelist")

_NORMALIZE_RE = re.compile(r"[^a-z0-9]")


def normalize(name: str) -> str:
    return _NORMALIZE_RE.sub("", (name or "").lower())


def _event_venue(event: dict) -> dict | None:
    embedded = event.get("_embedded") or {}
    venues = embedded.get("venues") or []
    if not venues:
        return None
    return venues[0]


def _build_indexes(whitelist: list[dict]) -> tuple[dict, dict]:
    """Return (by_name_normalized, by_tm_venue_id).

    by_name_normalized maps every name AND alias (normalized) to the venue.
    Whitelist authors can supply duplicate normalized names across entries
    only at their own risk — last write wins, but the warning fires.
    """
    by_name: dict[str, dict] = {}
    by_tm_id: dict[str, dict] = {}

    for v in whitelist:
        name_key = normalize(v.get("name", ""))
        if name_key:
            if name_key in by_name and by_name[name_key].get("id") != v.get("id"):
                log.warning(
                    "[whitelist] duplicate normalized name %r collides between %s and %s",
                    name_key,
                    by_name[name_key].get("id"),
                    v.get("id"),
                )
            by_name[name_key] = v
        for alias in v.get("aliases") or []:
            alias_key = normalize(alias)
            if alias_key and alias_key not in by_name:
                by_name[alias_key] = v

        tm_id = v.get("ticketmaster_venue_id")
        if tm_id:
            by_tm_id[tm_id] = v

    return by_name, by_tm_id


def apply(events: list[dict], whitelist: list[dict]) -> tuple[list[dict], Counter]:
    """Filter events whose venue matches a whitelist entry.

    Returns (matched_events, unmatched_counter[original_venue_name -> count]).
    Matched events are unchanged; the caller decides whether to annotate
    them with the matched venue (see pipeline.run).
    """
    by_name, by_tm_id = _build_indexes(whitelist)
    matched: list[dict] = []
    unmatched: Counter = Counter()
    missing_venue = 0

    for event in events:
        venue = _event_venue(event)
        if not venue:
            missing_venue += 1
            continue

        # 1. Exact Ticketmaster venue id override.
        tm_id = venue.get("id")
        if tm_id and tm_id in by_tm_id:
            matched.append(event)
            continue

        # 2 + 3. Normalized name OR alias.
        vname = venue.get("name")
        if not vname:
            missing_venue += 1
            continue
        if normalize(vname) in by_name:
            matched.append(event)
        else:
            unmatched[vname] += 1

    if missing_venue:
        log.warning("[whitelist] %d events had no venue name; skipped", missing_venue)
    return matched, unmatched


def find_match(venue: dict, whitelist: list[dict]) -> dict | None:
    """Return the whitelist entry matching this TM venue dict, or None.

    Used by scoring to look up capacity/category for a matched event.
    """
    by_name, by_tm_id = _build_indexes(whitelist)
    tm_id = venue.get("id")
    if tm_id and tm_id in by_tm_id:
        return by_tm_id[tm_id]
    name_key = normalize(venue.get("name") or "")
    return by_name.get(name_key)
