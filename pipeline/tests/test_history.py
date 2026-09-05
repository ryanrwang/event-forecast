"""Tests for the compact per-day archive (pipeline.history).

The archive is the only pipeline output that cannot be regenerated —
Ticketmaster only serves upcoming events — so the invariants that matter
here are: a record keeps what the calendar and past-day view render, an
upsert never loses a day already on disk, and nothing about an archive
write can raise into the cron.
"""

from __future__ import annotations

import json

import pytest

from pipeline import history


def _forecast(date="2026-09-04", **overrides):
    """A minimal but realistic forecast payload."""
    payload = {
        "date": date,
        "city_id": "toronto",
        "timezone": "America/Toronto",
        "generated_at": f"{date}T06:02:11-04:00",
        "verdict": "Busy",
        "peak_proxy": 71.2481,
        "peak_bucket": 74,
        "peak_value": 27.8413,
        "bucket_minutes": 15,
        "buckets": 104,
        "span_hours": 26,
        "timeline": [0.0] * 70 + [1.234567, 12.5, 27.8413, 9.1] + [0.0] * 30,
        "thresholds": {"T1": 5.0, "T2": 30.0, "T3": 65.0},
        "avoid_windows": [
            {"event_id": "E1", "kind": "arrival",
             "from_minute": 1027.0, "to_minute": 1102.0,
             "from_bucket": 68.4667, "to_bucket": 73.4667},
        ],
        "transit_flags": {
            "radius_m": 600,
            "service_profile": "friday",
            "events": [{
                "event_id": "E1",
                "venue_id": "scotiabank-arena",
                "stations": [
                    {"station_id": "st:union", "station_name": "Union",
                     "kind": "subway", "lines": ["1"], "lat": 43.6453,
                     "lon": -79.3806, "distance_m": 412.7, "load_share": 0.3111,
                     "seats_per_hour": [1000] * 24},
                ] + [
                    {"station_id": f"sc{i}", "station_name": f"Stop {i}",
                     "kind": "streetcar", "lines": ["504"], "lat": 43.64,
                     "lon": -79.39, "distance_m": 100.0 + i, "load_share": 0.01,
                     "seats_per_hour": [500] * 24}
                    for i in range(15)
                ],
            }],
        },
        "attribution": "Event discovery powered by Ticketmaster.",
        "event_count": 1,
        "events": [{
            "id": "E1",
            "name": "Raptors vs. Celtics",
            "venue_id": "scotiabank-arena",
            "venue_name": "Scotiabank Arena",
            "category": "arena_sports",
            "segment": "Sports",
            "start_local": f"{date}T19:30:00-04:00",
            "end_local": f"{date}T22:00:00-04:00",
            "expected_attendance": 19800,
            "impact": 19.8004,
            "ticketmaster_url": "https://www.ticketmaster.ca/x",
            "time_curve": [0.0] * 70 + [1.2, 12.5, 27.8, 9.1] + [0.0] * 30,
            "flux_curve": [0.5] * 104,
            "spot_weights": [0.1] * 13,
            "sigma_m": 1200.0,
            "peak_intensity": 27.8,
            "street_weight": 9.1611,
            "during_from_bucket": 73.4667,
            "during_to_bucket": 86.4667,
            "transit_people": 8910,
        }],
    }
    payload.update(overrides)
    return payload


# ─────────── build_record ───────────

def test_record_keeps_what_the_calendar_and_day_view_render():
    rec = history.build_record(_forecast())

    assert rec["date"] == "2026-09-04"
    assert rec["verdict"] == "Busy"
    assert rec["score"] == 71.25
    assert rec["peak_bucket"] == 74
    assert rec["thresholds"] == {"T1": 5.0, "T2": 30.0, "T3": 65.0}
    assert len(rec["timeline"]) == 104
    win = rec["avoid_windows"][0]
    assert win["kind"] == "arrival"
    # Both pairs survive: buckets drive the timeline bands, minutes the
    # station lanes.
    assert win["from_minute"] == 1027.0 and win["to_minute"] == 1102.0
    assert win["from_bucket"] == 68.47

    ev = rec["events"][0]
    assert ev["name"] == "Raptors vs. Celtics"
    assert ev["start_local"].endswith("19:30:00-04:00")
    assert ev["during_from_bucket"] == 73.47
    assert ev["sigma_m"] == 1200.0
    assert ev["stations"][0]["station_name"] == "Union"


def test_record_drops_the_model_intermediates():
    ev = history.build_record(_forecast())["events"][0]
    assert "flux_curve" not in ev
    assert "spot_weights" not in ev
    assert "seats_per_hour" not in ev["stations"][0]


def test_curve_is_stored_as_its_non_zero_span_only():
    ev = history.build_record(_forecast())["events"][0]
    curve = ev["curve"]
    assert curve["o"] == 70
    assert curve["v"] == [1.2, 12.5, 27.8, 9.1]


def test_curve_rebuilds_to_the_original_length_and_shape():
    forecast = _forecast()
    original = forecast["events"][0]["time_curve"]
    curve = history.build_record(forecast)["events"][0]["curve"]

    rebuilt = [0.0] * len(original)
    for i, v in enumerate(curve["v"]):
        rebuilt[curve["o"] + i] = v

    assert len(rebuilt) == len(original)
    for a, b in zip(rebuilt, original):
        assert abs(a - b) < 0.01


def test_all_zero_curve_is_omitted_rather_than_stored():
    forecast = _forecast()
    forecast["events"][0]["time_curve"] = [0.0] * 104
    assert "curve" not in history.build_record(forecast)["events"][0]


def test_streetcar_stops_are_capped_but_curated_rows_survive():
    stations = history.build_record(_forecast())["events"][0]["stations"]
    kinds = [s["kind"] for s in stations]
    assert kinds.count("subway") == 1
    assert kinds.count("streetcar") == history._STREETCAR_MAX_PER_EVENT


def test_unclassified_stations_hit_the_absolute_backstop():
    forecast = _forecast()
    for s in forecast["transit_flags"]["events"][0]["stations"]:
        s.pop("kind", None)
    stations = history.build_record(forecast)["events"][0]["stations"]
    assert len(stations) == history._STATIONS_MAX_PER_EVENT


def test_day_with_no_events_still_produces_a_record():
    rec = history.build_record(_forecast(
        verdict="Quiet", event_count=0, events=[], avoid_windows=[],
        transit_flags={"events": []},
    ))
    assert rec["verdict"] == "Quiet"
    assert rec["events"] == []
    assert rec["event_count"] == 0


# ─────────── month files ───────────

def test_upsert_creates_the_month_file(tmp_path):
    history.archive_forecasts("toronto", [_forecast("2026-09-04")], root=tmp_path)
    path = history.month_path("toronto", "2026-09", tmp_path)
    payload = json.loads(path.read_text(encoding="utf-8"))

    assert payload["city_id"] == "toronto"
    assert payload["month"] == "2026-09"
    assert payload["schema_version"] == history.SCHEMA_VERSION
    assert [d["date"] for d in payload["days"]] == ["2026-09-04"]


def test_upsert_adds_a_day_without_losing_the_others(tmp_path):
    history.archive_forecasts("toronto", [_forecast("2026-09-04")], root=tmp_path)
    history.archive_forecasts("toronto", [_forecast("2026-09-05")], root=tmp_path)

    payload = json.loads(
        history.month_path("toronto", "2026-09", tmp_path).read_text(encoding="utf-8"))
    assert [d["date"] for d in payload["days"]] == ["2026-09-04", "2026-09-05"]
    assert payload["day_count"] == 2


def test_rewriting_the_same_day_replaces_it_in_place(tmp_path):
    history.archive_forecasts("toronto", [_forecast("2026-09-04")], root=tmp_path)
    history.archive_forecasts(
        "toronto", [_forecast("2026-09-04", verdict="Severe")], root=tmp_path)

    payload = json.loads(
        history.month_path("toronto", "2026-09", tmp_path).read_text(encoding="utf-8"))
    assert len(payload["days"]) == 1
    assert payload["days"][0]["verdict"] == "Severe"


def test_days_are_stored_in_date_order_regardless_of_write_order(tmp_path):
    history.archive_forecasts(
        "toronto",
        [_forecast("2026-09-09"), _forecast("2026-09-02"), _forecast("2026-09-05")],
        root=tmp_path,
    )
    payload = json.loads(
        history.month_path("toronto", "2026-09", tmp_path).read_text(encoding="utf-8"))
    assert [d["date"] for d in payload["days"]] == [
        "2026-09-02", "2026-09-05", "2026-09-09"]


def test_a_window_spanning_a_month_boundary_writes_both_files(tmp_path):
    paths = history.archive_forecasts(
        "toronto", [_forecast("2026-09-30"), _forecast("2026-10-01")], root=tmp_path)
    assert sorted(p.name for p in paths) == ["2026-09.json", "2026-10.json"]


def test_a_corrupt_month_file_is_rebuilt_rather_than_raising(tmp_path):
    path = history.month_path("toronto", "2026-09", tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ this is not json", encoding="utf-8")

    history.archive_forecasts("toronto", [_forecast("2026-09-04")], root=tmp_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert [d["date"] for d in payload["days"]] == ["2026-09-04"]


def test_archiving_nothing_writes_nothing(tmp_path):
    assert history.archive_forecasts("toronto", [], root=tmp_path) == []
    assert not history.history_root(tmp_path).exists()


def test_records_without_a_usable_date_are_skipped(tmp_path):
    assert history.upsert_days("toronto", [{"verdict": "Busy"}], root=tmp_path) == []


def test_list_months_reports_what_is_on_disk(tmp_path):
    assert history.list_months("toronto", tmp_path) == []
    history.archive_forecasts(
        "toronto", [_forecast("2026-08-31"), _forecast("2026-09-01")], root=tmp_path)
    assert history.list_months("toronto", tmp_path) == ["2026-08", "2026-09"]


def test_month_files_are_written_compactly(tmp_path):
    history.archive_forecasts("toronto", [_forecast("2026-09-04")], root=tmp_path)
    raw = history.month_path("toronto", "2026-09", tmp_path).read_text(encoding="utf-8")
    # Indented JSON would roughly double these files; they are committed.
    assert "\n" not in raw
    assert ", " not in raw


@pytest.mark.parametrize("value,expected", [
    (1.234567, 1.23),
    (0, 0),
    (None, None),
    ("Busy", "Busy"),
    (True, True),
])
def test_rounding_leaves_non_numbers_alone(value, expected):
    assert history._r(value) == expected
