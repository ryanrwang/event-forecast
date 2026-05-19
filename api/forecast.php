<?php
/**
 * GET /api/forecast.php?city=<city_id>&date=<YYYY-MM-DD>
 *
 * Streams the per-day forecast JSON written by the Python pipeline at
 * data/<city_id>/<date>/forecast.json, with per-event venue coordinates
 * joined from config/<city_id>/venues.json on the way out.
 *
 * The pipeline intentionally does NOT denormalize lat/lon into the
 * per-day files — venues.json stays the single source of truth so a
 * coordinate edit doesn't require regenerating every forecast file.
 *
 * Validates both params against an allowlist (city) and a regex (date)
 * so the resolved path cannot escape the data root.
 */

require_once __DIR__ . '/_common.php';

$city = (string) ($_GET['city'] ?? '');
$date = (string) ($_GET['date'] ?? '');

if ($city === '' || $date === '') {
    bad_request('missing required query parameters: city, date');
}
if (!valid_city_id($city)) {
    not_found('unknown city: ' . $city);
}
if (!valid_date($date)) {
    bad_request('date must be YYYY-MM-DD');
}

$path = DATA_ROOT . '/' . $city . '/' . $date . '/forecast.json';
if (!is_file($path)) {
    not_found('no forecast for ' . $city . ' on ' . $date);
}

$raw = file_get_contents($path);
$decoded = json_decode($raw, true);
if (!is_array($decoded)) {
    server_error('forecast file is not valid JSON');
}

// Join venue coordinates onto each event from venues.json.
$venues = load_venues_index($city);
if (isset($decoded['events']) && is_array($decoded['events'])) {
    foreach ($decoded['events'] as &$ev) {
        if (!is_array($ev)) continue;
        $vid = $ev['venue_id'] ?? null;
        if (is_string($vid) && isset($venues[$vid])) {
            $v = $venues[$vid];
            if (isset($v['lat'])) $ev['lat'] = $v['lat'];
            if (isset($v['lon'])) $ev['lon'] = $v['lon'];
            if (isset($v['capacity'])) $ev['venue_capacity'] = $v['capacity'];
        }
    }
    unset($ev);
}

send_json($decoded);
