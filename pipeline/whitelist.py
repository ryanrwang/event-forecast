"""Apply a venue whitelist to Ticketmaster events.

Matching is case- and punctuation-insensitive against `venues[*].name` on
each event. Unmatched venue names are returned to the caller so the
operator can see candidates for the M1 whitelist sanity pass.
"""

from __future__ import annotations

import logging
import re
from collections import Counter

log = logging.getLogger("pipeline.whitelist")

_NORMALIZE_RE = re.compile(r"[^a-z0-9]")


def normalize(name: str) -> str:
    return _NORMALIZE_RE.sub("", (name or "").lower())


def _event_venue_name(event: dict) -> str | None:
    embedded = event.get("_embedded") or {}
    venues = embedded.get("venues") or []
    if not venues:
        return None
    return venues[0].get("name")


def apply(events: list[dict], whitelist: list[dict]) -> tuple[list[dict], Counter]:
    """Filter events whose venue matches a whitelist entry by normalized name.

    Returns (matched_events, unmatched_counter[original_venue_name -> count]).
    """
    lookup = {normalize(v["name"]): v for v in whitelist}
    matched: list[dict] = []
    unmatched: Counter = Counter()
    missing_venue = 0

    for event in events:
        vname = _event_venue_name(event)
        if not vname:
            missing_venue += 1
            continue
        key = normalize(vname)
        if key in lookup:
            matched.append(event)
        else:
            unmatched[vname] += 1

    if missing_venue:
        log.warning("[whitelist] %d events had no venue name; skipped", missing_venue)
    return matched, unmatched
