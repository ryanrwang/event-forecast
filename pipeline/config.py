"""Loads the Ticketmaster API key and per-city config."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SECRETS_ENV_PATH = REPO_ROOT / "secrets" / "ticketmaster.env"
CONFIG_DIR = REPO_ROOT / "config"

ENV_VAR = "TICKETMASTER_API_KEY"


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def load_api_key() -> str:
    """Resolve the Ticketmaster API key from env var or secrets/ticketmaster.env.

    Exits the process with a human-readable message if neither is set, so the
    operator never sees a stack trace for a missing key.
    """
    env_val = os.environ.get(ENV_VAR, "").strip()
    if env_val:
        return env_val

    parsed = _parse_env_file(SECRETS_ENV_PATH)
    file_val = parsed.get(ENV_VAR, "").strip()
    if file_val:
        return file_val

    sys.stderr.write(
        "ERROR: Ticketmaster API key not found.\n"
        f"  Set the {ENV_VAR} environment variable, or put\n"
        f"    {ENV_VAR}=<your_key>\n"
        f"  in {SECRETS_ENV_PATH}\n"
    )
    sys.exit(1)


def load_city_config(city: str) -> dict:
    """Load the merged city config: city.json + venues whitelist."""
    city_dir = CONFIG_DIR / city
    city_json = city_dir / "city.json"
    venues_json = city_dir / "venues.json"

    if not city_json.exists():
        sys.stderr.write(f"ERROR: city config not found at {city_json}\n")
        sys.exit(1)
    if not venues_json.exists():
        sys.stderr.write(f"ERROR: venue whitelist not found at {venues_json}\n")
        sys.exit(1)

    # utf-8-sig tolerates an optional UTF-8 BOM (Windows editors sometimes add one).
    city_cfg = json.loads(city_json.read_text(encoding="utf-8-sig"))
    venues = json.loads(venues_json.read_text(encoding="utf-8-sig"))
    city_cfg["venues"] = venues
    return city_cfg
