<?php
/**
 * GET /api/forecast.php?city=<city_id>&date=<YYYY-MM-DD>
 *
 * Streams the per-day forecast JSON written by the Python pipeline at
 * data/<city_id>/<date>/forecast.json. Validates both params against
 * an allowlist (city) and a regex (date) so the resolved path cannot
 * escape the data root.
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

send_json($decoded);
