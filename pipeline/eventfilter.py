"""Exclusion filter for non-crowd event listings at whitelisted venues.

The venue whitelist answers "does this venue matter?"; this module
answers "is this listing actually a crowd event?". Ticketmaster attaches
non-event inventory to major venues — facility tours, parking passes,
hotel/VIP packages — and because scoring uses venue capacity as the
attendance proxy, a daily stadium tour would otherwise be weighted like
a sold-out game (the observed failure: "Rogers Centre Ballpark Tours"
was the highest-impact "event" of the week, every day).

Rules live in ``config/event_filters.json`` — one global file, because
the rules are TM-taxonomy based rather than city-specific; every
configured city gets the same hygiene. Two rule kinds:

* ``exclude_classifications``: a list of {field: value} objects matched
  (case-insensitively) against the event's primary TM classification.
  An event is excluded when EVERY field in a rule matches. Fields:
  segment, genre, subGenre, type, subType.
* ``exclude_name_patterns``: case-insensitive substrings matched against
  the event name.

A missing or malformed config file disables filtering (fail-open: an
extra tour listing is a smaller error than an empty forecast). Every
exclusion is logged with its rule so the operator can audit what the
filter ate after any run.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

from .config import CONFIG_DIR

log = logging.getLogger("pipeline.eventfilter")

FILTERS_PATH = CONFIG_DIR / "event_filters.json"

_CLASSIFICATION_FIELDS = ("segment", "genre", "subGenre", "type", "subType")


def load_filters() -> dict[str, Any]:
    """Load config/event_filters.json. Returns an empty ruleset if missing."""
    empty = {"exclude_classifications": [], "exclude_name_patterns": []}
    if not FILTERS_PATH.exists():
        return empty
    try:
        data = json.loads(FILTERS_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        log.error("[filter] %s unreadable (%s); filtering disabled", FILTERS_PATH, exc)
        return empty
    if not isinstance(data, dict):
        log.error("[filter] %s is not a JSON object; filtering disabled", FILTERS_PATH)
        return empty
    return {
        "exclude_classifications": [
            r for r in (data.get("exclude_classifications") or [])
            if isinstance(r, dict)
        ],
        "exclude_name_patterns": [
            p.strip().lower() for p in (data.get("exclude_name_patterns") or [])
            if isinstance(p, str) and p.strip()
        ],
    }


def _classification_values(event: dict) -> dict[str, str]:
    """Flatten the event's primary TM classification to lowercase values."""
    cl = (event.get("classifications") or [{}])[0]
    if not isinstance(cl, dict):
        return {}
    out: dict[str, str] = {}
    for field in _CLASSIFICATION_FIELDS:
        name = ((cl.get(field) or {}).get("name") or "").strip().lower()
        if name:
            out[field] = name
    return out


def _matches_rule(values: dict[str, str], rule: dict) -> bool:
    """True when every non-underscore field in the rule matches the event."""
    checked = False
    for field, want in rule.items():
        if field.startswith("_"):
            continue  # _reason and friends are documentation, not criteria
        if not isinstance(want, str):
            return False
        checked = True
        if values.get(field, "") != want.strip().lower():
            return False
    return checked


def exclusion_reason(event: dict, filters: dict[str, Any]) -> str | None:
    """Return a short human-readable reason if the event is excluded, else None."""
    name = (event.get("name") or "").lower()
    for pattern in filters["exclude_name_patterns"]:
        if pattern in name:
            return f"name contains {pattern!r}"
    values = _classification_values(event)
    for rule in filters["exclude_classifications"]:
        if _matches_rule(values, rule):
            crit = {k: v for k, v in rule.items() if not k.startswith("_")}
            return f"classification matches {crit}"
    return None


def apply(events: list[dict]) -> list[dict]:
    """Return the events that survive the exclusion filter, logging the rest."""
    filters = load_filters()
    if not filters["exclude_classifications"] and not filters["exclude_name_patterns"]:
        return events

    kept: list[dict] = []
    excluded: Counter[str] = Counter()
    reasons: dict[str, str] = {}
    for ev in events:
        reason = exclusion_reason(ev, filters)
        if reason is None:
            kept.append(ev)
        else:
            ev_name = ev.get("name") or "(unnamed)"
            excluded[ev_name] += 1
            reasons.setdefault(ev_name, reason)

    if excluded:
        for ev_name, count in excluded.most_common():
            log.info(
                "[filter] excluded %r ×%d — %s", ev_name, count, reasons[ev_name],
            )
        log.info(
            "[filter] %d of %d whitelisted listings excluded as non-crowd events",
            sum(excluded.values()), len(events),
        )
    return kept
