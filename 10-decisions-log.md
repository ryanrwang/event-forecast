# Decisions Log

Chronological log of consequential decisions that aren't otherwise obvious from the code. Each entry records WHY the decision was made so future revisions can be judged against the original intent.

## 2026-05-18 — M1

### Verdict thresholds (placeholder)

`pipeline/scoring.py` sets `T1=5.0`, `T2=15.0`, `T3=30.0`, mapping `peak_proxy` to **Quiet / Moderate / Busy / Severe**.

These are **placeholders pending calibration** against a representative Toronto week. The rationale for the starting values:
- A single 20k-seat arena event scores `capacity_factor 20 × ~1.0 weights ≈ 20`, so a one-major-event day lands solidly in Busy.
- An empty or background-only day lands at Quiet.
- Stacked major-venue days (multiple Rogers Centre / Scotiabank Arena / Rogers Stadium events) land at Severe.

**Initial real-data observation (May 18–24, 2026):** with the M1 whitelist + thresholds, six of seven days came back Severe (peak_proxy 34–206). That's plausibly correct for a Friday-of-Memorial-Day-weekend-equivalent stretch with multiple Rogers Centre concerts and Mirvish runs, but the resolution is clearly compressed — we lose differentiation between "stadium concert" and "stadium concert + festival + arena event". Calibration in a later pass should:
1. Sample a known-quiet week and a known-busy week from the real Toronto calendar.
2. Compute peak_proxy distributions and pick thresholds that target roughly 30% Quiet, 35% Moderate, 25% Busy, 10% Severe across an average year.
3. Consider whether `peak_proxy` itself needs a different aggregator (e.g. max over time-of-day buckets rather than sum) once M3's timeline produces a real peak.

### Time-of-day concentration weights (placeholder)

`pipeline/scoring.py` `_TOD_BANDS`: morning 0.6, afternoon 0.8, evening 1.0, late 0.9.

These tilt the M1 verdict proxy toward prime-time impact. Will be retired when M3's 15-minute busyness timeline replaces `peak_proxy` with a real per-day peak.

### Whitelist threshold deviation — sub-5k venues included

The modeling spec says "roughly 5,000 seats and above plus all pro sports stadiums/arenas plus major amphitheatres". Six venues in the M1 whitelist fall below 5k and are not pro-sports or amphitheatres:

- Meridian Hall (3,191), Massey Hall (2,752), Roy Thomson Hall (2,630), Ed Mirvish Theatre (2,278), Princess of Wales Theatre (2,000), History (2,500).

**Why included:** Without them the whitelist drops to six venues, well below the spec's "~10–20 venues" target. These are the major touring-Broadway / concert-hall / mid-size-concert tier downtown — they regularly drive headline-act crowds even though the venue itself is sub-5k. Excluding them would make Toronto's downtown theatre district invisible to the model, which is worse than the small-venue-clustering false positive that the spec is trying to avoid.

**How to revisit:** if real-world calibration shows these venues meaningfully overstate crowd impact at sub-5k capacity, demote their category multiplier (e.g. `performing_arts` from 0.45 → 0.35) before removing the venue outright.

### Font choices

Loaded via Google Fonts `<link>` in `index.html`:
- **Display:** Instrument Serif (italic available) — characterful editorial serif, used for the brand mark and the verdict labels. Provides the "not generic AI dashboard" feel the visual brief asks for.
- **Body / sans:** Space Grotesk — clean geometric sans, technical without being default-y. Used for event names and body copy.
- **Mono:** JetBrains Mono — used for timestamps, the disclaimer, and the city-selector label, where the data-product feel is desired.

These are deliberately not Inter / Roboto / Arial / system defaults, per `CLAUDE.md`.

### Data deploy strategy

`data/` is not committed and not in the SFTP deploy workflow. It's a build artifact, like `cache/`.

- **Local dev:** the Python pipeline writes `data/<city>/<date>/forecast.json` locally, and the PHP layer + frontend read those files via `php -S`.
- **Production:** the same pipeline runs on Bluehost via cPanel cron (configured in M6). PHP reads the cron-written files in place.
- **M1 transition:** for a one-time manual deploy verification before M6, the operator can SFTP `data/` once. Not required for any acceptance criterion in M1.

This is consistent with the existing `.gitignore` (`data/` is ignored) and `.github/workflows/deploy.yml` (`data/**` is excluded from deploy).

### City iterator pattern

The pipeline reads `config/cities.json` (a JSON array of city ids) and iterates. The PHP layer reads the same file. Adding a second city is two new files (`config/<id>/city.json`, `config/<id>/venues.json`) and one line in `cities.json` — no code change in any layer.

`--city <id>` is preserved as an override on `pipeline.run` for one-off runs.
