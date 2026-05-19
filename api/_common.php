<?php
/**
 * Shared helpers for the api/ endpoints.
 *
 * Hosted on Bluehost shared PHP. Keep dependency-free, no framework.
 * No Ticketmaster API key is ever read or echoed by this layer; the M1
 * endpoints only serve cached JSON written by the Python pipeline.
 */

define('REPO_ROOT', dirname(__DIR__));
define('CONFIG_ROOT', REPO_ROOT . '/config');
define('DATA_ROOT',   REPO_ROOT . '/data');
define('STATUS_PATH', DATA_ROOT . '/status.json');

// Required attribution strings. The PHP layer carries every attribution
// the rendered UI is required to display. The frontend reads them off
// /api/cities.php and places them in legend + footer. Pulling them from
// one place keeps the M5 expansion (MTA, CTA) a tiny config-add.
define('ATTRIBUTION_TEXT', 'Event discovery powered by Ticketmaster.');
define('ATTRIBUTION_URL',  'https://developer.ticketmaster.com/');

function attribution(): array {
    return [
        'text' => ATTRIBUTION_TEXT,
        'url'  => ATTRIBUTION_URL,
    ];
}

/**
 * Map attribution — OSM tiles via CARTO basemaps. Single source of truth
 * for the basemap credit text; the frontend renders this on every map
 * view AND we hand the string to Leaflet's attribution control.
 */
function map_attribution(): array {
    return [
        'text' => 'OpenStreetMap contributors · CARTO basemaps',
        'osm_url' => 'https://www.openstreetmap.org/copyright',
        'carto_url' => 'https://carto.com/attributions',
    ];
}

/**
 * Per-city GTFS feed attribution. MVP only has Toronto, but the lookup
 * is keyed by city_id so the M5 NYC + Chicago expansion plugs in by
 * dropping rows into this map — no controller changes required.
 *
 * Toronto: TTC routes & schedules from the City of Toronto Open Data
 * Portal, licensed under the City's Open Data Licence v1.0. The string
 * is rendered in the map legend AND the footer per the licence terms.
 */
function gtfs_attribution_for(string $city_id): ?array {
    static $by_city = [
        'toronto' => [
            'agency'  => 'TTC',
            'text'    => 'TTC GTFS via City of Toronto Open Data (Open Data Licence v1.0)',
            'url'     => 'https://open.toronto.ca/dataset/ttc-routes-and-schedules/',
            'license' => 'City of Toronto Open Data Licence v1.0',
            'license_url' => 'https://open.toronto.ca/open-data-license/',
        ],
        // M5 placeholders, intentionally documented here so the future
        // expansion is a config-add. Uncomment when their city configs
        // land in config/cities.json.
        // 'nyc' => [...],
        // 'chicago' => [...],
    ];
    return $by_city[$city_id] ?? null;
}

function send_json($payload, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function bad_request(string $msg): void {
    send_json(['error' => 'bad_request', 'message' => $msg], 400);
}

function not_found(string $msg): void {
    send_json(['error' => 'not_found', 'message' => $msg], 404);
}

function server_error(string $msg): void {
    send_json(['error' => 'server_error', 'message' => $msg], 500);
}

/**
 * Return the configured-cities list from config/cities.json.
 *
 * The pipeline and the PHP serving layer share this index. To add a
 * city later, append its id here AND create config/<id>/city.json plus
 * config/<id>/venues.json — no code change needed in either layer.
 */
function load_cities_list(): array {
    $path = CONFIG_ROOT . '/cities.json';
    if (!is_file($path)) {
        server_error('cities index missing on server');
    }
    $raw = file_get_contents($path);
    $list = json_decode($raw, true);
    if (!is_array($list)) {
        server_error('cities index is not a JSON array');
    }
    return array_values(array_filter($list, 'is_string'));
}

function load_city_config(string $city_id): array {
    $path = CONFIG_ROOT . '/' . $city_id . '/city.json';
    if (!is_file($path)) {
        not_found('city config missing: ' . $city_id);
    }
    $cfg = json_decode(file_get_contents($path), true);
    if (!is_array($cfg)) {
        server_error('city config malformed: ' . $city_id);
    }
    return $cfg;
}

/**
 * Load the venue whitelist for a city, indexed by venue id.
 *
 * The venues file is the single source of truth for venue lat/lon and
 * capacity. forecast.php joins per-event venue_id against this index so
 * that the per-day forecast.json files never carry denormalized
 * coordinates — editing a venue's lat/lon stays a one-file change in
 * config/<city>/venues.json with no regeneration required.
 */
function load_venues_index(string $city_id): array {
    $path = CONFIG_ROOT . '/' . $city_id . '/venues.json';
    if (!is_file($path)) {
        return [];
    }
    $rows = json_decode(file_get_contents($path), true);
    if (!is_array($rows)) {
        return [];
    }
    $out = [];
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        $id = $row['id'] ?? null;
        if (!is_string($id) || $id === '') continue;
        $out[$id] = $row;
    }
    return $out;
}

function valid_city_id(string $id): bool {
    if (!preg_match('/^[a-z0-9_-]{1,32}$/', $id)) {
        return false;
    }
    return in_array($id, load_cities_list(), true);
}

function valid_date(string $date): bool {
    return (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $date);
}

/**
 * Return the sorted list of YYYY-MM-DD subdirectories under
 * data/<city_id>/ that contain a forecast.json file.
 */
function list_forecast_days(string $city_id): array {
    $city_dir = DATA_ROOT . '/' . $city_id;
    if (!is_dir($city_dir)) {
        return [];
    }
    $days = [];
    foreach (scandir($city_dir) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $entry)) continue;
        if (is_file($city_dir . '/' . $entry . '/forecast.json')) {
            $days[] = $entry;
        }
    }
    sort($days);
    return $days;
}

/**
 * Load the pipeline status file (data/status.json). Missing or malformed
 * file returns an empty skeleton — the frontend then renders a "status
 * unavailable" eyebrow rather than crashing.
 */
function load_status(): array {
    if (!is_file(STATUS_PATH)) {
        return ['schema_version' => 1, 'updated_at' => null, 'cities' => []];
    }
    $raw = file_get_contents(STATUS_PATH);
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return ['schema_version' => 1, 'updated_at' => null, 'cities' => []];
    }
    if (!isset($decoded['cities']) || !is_array($decoded['cities'])) {
        $decoded['cities'] = [];
    }
    return $decoded;
}

/**
 * Compute a presentation-ready freshness summary for one city. Combines
 * the raw status timestamps with the operator-facing booleans the UI
 * actually cares about (is_fresh / is_stale / zero_event_run).
 */
function city_freshness(string $city_id): array {
    $st = load_status();
    $city = $st['cities'][$city_id] ?? null;
    if (!is_array($city)) {
        return [
            'present'         => false,
            'tm'              => null,
            'gtfs'            => null,
            'zero_event_run'  => false,
            'overall_stale'   => true,
        ];
    }
    $tm   = $city['ticketmaster'] ?? null;
    $gtfs = $city['gtfs']         ?? null;
    $fc   = $city['forecast']     ?? null;
    $tm_stale   = is_array($tm)   ? !empty($tm['stale'])   : true;
    $gtfs_stale = is_array($gtfs) ? !empty($gtfs['stale']) : false;
    return [
        'present'        => true,
        'tm'             => $tm,
        'gtfs'           => $gtfs,
        'forecast'       => $fc,
        'zero_event_run' => is_array($fc) ? !empty($fc['zero_event_run']) : false,
        'overall_stale'  => $tm_stale || $gtfs_stale,
    ];
}
