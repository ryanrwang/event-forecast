<?php
/**
 * GET /api/history.php?city=<city_id>&month=<YYYY-MM>
 * GET /api/history.php?city=<city_id>&months=<YYYY-MM,YYYY-MM,...>
 *
 * Serves the compact per-day archive written by pipeline/history.py at
 * history/<city_id>/<YYYY-MM>.json — one record per past day, holding
 * the verdict, the busyness timeline, avoid windows, per-event curves and
 * the flagged stations. Roughly a thirteenth the size of a full
 * forecast.json, which is what makes keeping every day affordable.
 *
 * Why this is separate from forecast.php: the two answer different
 * questions. forecast.php serves ONE upcoming day at full model fidelity;
 * this serves a MONTH of days at calendar fidelity. Folding them together
 * would mean either shipping a month of full files or degrading the live
 * day, and neither is wanted.
 *
 * A month with no file is not an error — the archive starts empty and
 * fills in from the first pipeline run onward. Missing months come back
 * as an empty days array so the calendar renders "no history yet" rather
 * than an error state.
 *
 * Venue coordinates are joined from venues.json on the way out, the same
 * way forecast.php does it, so the map can plot an archived day.
 */

require_once __DIR__ . '/_common.php';

// Cap how many months one request may ask for. The calendar only ever
// needs the visible month plus its neighbours for prefetch; a wide range
// would mean reading and re-encoding megabytes per request on shared
// hosting.
const HISTORY_MAX_MONTHS = 6;

$city = (string) ($_GET['city'] ?? '');
if ($city === '') {
    bad_request('missing required query parameter: city');
}
if (!valid_city_id($city)) {
    not_found('unknown city: ' . $city);
}

$requested = [];
if (isset($_GET['months']) && $_GET['months'] !== '') {
    $requested = array_filter(array_map('trim', explode(',', (string) $_GET['months'])));
} elseif (isset($_GET['month']) && $_GET['month'] !== '') {
    $requested = [(string) $_GET['month']];
} else {
    bad_request('missing required query parameter: month (or months)');
}

$requested = array_values(array_unique($requested));
foreach ($requested as $month) {
    if (!valid_month($month)) {
        bad_request('month must be YYYY-MM: ' . $month);
    }
}
if (count($requested) > HISTORY_MAX_MONTHS) {
    bad_request('at most ' . HISTORY_MAX_MONTHS . ' months per request');
}
sort($requested);

$months = [];
$days = [];
foreach ($requested as $month) {
    $payload = load_history_month($city, $month);
    $months[$month] = $payload !== null;
    if ($payload === null) {
        continue;
    }
    foreach ($payload['days'] as $day) {
        if (is_array($day) && isset($day['date'])) {
            $days[] = $day;
        }
    }
}

// One flat, date-ordered array across every requested month. The calendar
// indexes it by date, so the month boundaries carry no meaning past this
// point and a nested shape would only make the client re-flatten it.
usort($days, static function (array $a, array $b): int {
    return strcmp((string) $a['date'], (string) $b['date']);
});

join_history_venues($days, $city);

send_json([
    'city_id'          => $city,
    'requested_months' => $requested,
    // Per month: did a file exist? Lets the calendar distinguish "this
    // month predates the archive" from "this month was genuinely quiet".
    'months'           => (object) $months,
    'available_months' => list_history_months($city),
    'day_count'        => count($days),
    'days'             => $days,
    'attribution'      => attribution(),
]);
