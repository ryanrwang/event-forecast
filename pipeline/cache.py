"""File-based cache for Ticketmaster Discovery API responses.

Keyed by SHA1(url + sorted-query-params), with `apikey` stripped from the
key so a key rotation does not invalidate the cache.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

from .config import REPO_ROOT

CACHE_DIR = REPO_ROOT / "data" / "cache" / "ticketmaster"
DEFAULT_TTL_SECONDS = 6 * 60 * 60  # 6 hours


def _normalized_key(url: str, params: dict) -> str:
    scrubbed = {k: v for k, v in params.items() if k != "apikey"}
    qs = urlencode(sorted(scrubbed.items()))
    raw = f"{url}?{qs}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _path_for(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def get(url: str, params: dict, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> tuple[Optional[dict], str]:
    """Return (body, key) on hit, (None, key) on miss / expired."""
    key = _normalized_key(url, params)
    path = _path_for(key)
    if not path.exists():
        return None, key
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, key
    age = time.time() - envelope.get("fetched_at_epoch", 0)
    if age > ttl_seconds:
        return None, key
    return envelope.get("body"), key


def set_(url: str, params: dict, body: dict) -> str:
    """Write the response body to the cache. Returns the cache key."""
    key = _normalized_key(url, params)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    envelope = {
        "fetched_at_epoch": time.time(),
        "url": url,
        "key": key,
        "body": body,
    }
    _path_for(key).write_text(json.dumps(envelope), encoding="utf-8")
    return key


def age_minutes(url: str, params: dict) -> Optional[float]:
    """Best-effort age of a cached entry, in minutes. None if not cached."""
    key = _normalized_key(url, params)
    path = _path_for(key)
    if not path.exists():
        return None
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return (time.time() - envelope.get("fetched_at_epoch", 0)) / 60.0
