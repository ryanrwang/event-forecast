<?php
/**
 * Shared helpers for the api/ endpoints.
 *
 * Hosted on Bluehost shared PHP. Keep dependency-free, no framework.
 * No Ticketmaster API key is ever read or echoed by this layer; the M1
 * endpoints only serve cached JSON written by the Python pipeline.
 *
 * The one secret-shaped value this layer DOES hand to the browser is the
 * CARTO basemap key -- see basemap_key() for why that is safe, and why it
 * still belongs in server config rather than inline in map.js.
 */

define('REPO_ROOT', dirname(__DIR__));
define('CONFIG_ROOT', REPO_ROOT . '/config');
define('DATA_ROOT',   REPO_ROOT . '/data');
define('STATUS_PATH', DATA_ROOT . '/status.json');
// The compact per-day archive. Deliberately a sibling of data/ rather
// than a child: data/ is regenerated and mirrored-with-deletions on every
// refresh, history/ accumulates and is committed. See pipeline/history.py.
define('HISTORY_ROOT', REPO_ROOT . '/history');

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
 * Server-side config, loaded from api/config.php (gitignored, created per
 * environment -- see config.example.php for the shape). A missing file is
 * NOT an error: every consumer must degrade gracefully without it, so
 * local checkouts and fresh deploys still serve.
 */
function server_config(): array {
    static $cfg = null;
    if ($cfg === null) {
        $path = __DIR__ . '/config.php';
        $cfg = is_readable($path) ? (array) require $path : [];
    }
    return $cfg;
}

/**
 * CARTO basemap key, for the frontend's tile URL.
 *
 * Unlike ticketmaster_api_key this value IS sent to the browser -- it has
 * to be, because the browser fetches tiles from basemaps.cartocdn.com
 * directly. It is therefore NOT a secret from anyone who loads the map.
 * CARTO asks which domain you'll use it on when issuing the key, but
 * documents no enforced domain/referrer restriction, so we cannot rely on
 * that as a control.
 *
 * Keeping it in config.php rather than inline in map.js buys one specific
 * thing: it stays out of the public git repo, and so out of reach of the
 * automated scrapers that crawl public repositories for keys. Treat a
 * leaked key as rotatable, not as a breach.
 *
 * Empty string when unset -- map.js then falls back to the keyless tile
 * URL, which still renders (watermarked) rather than breaking.
 */
function basemap_key(): string {
    $key = server_config()['carto_basemap_key'] ?? '';
    return is_string($key) ? trim($key) : '';
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

/**
 * Resolve the city's IANA timezone from config/<city>/city.json.
 *
 * Falls back to UTC when the config or the timezone field is missing or
 * invalid — for a serving-layer date filter a wrong-but-working clock
 * beats a fatal error. Deliberately does NOT reuse load_city_config(),
 * which exits with a JSON error response on a missing file.
 */
function city_timezone(string $city_id): DateTimeZone {
    $path = CONFIG_ROOT . '/' . $city_id . '/city.json';
    if (is_file($path)) {
        $cfg = json_decode((string) file_get_contents($path), true);
        $tz = is_array($cfg) ? ($cfg['timezone'] ?? null) : null;
        if (is_string($tz) && $tz !== '') {
            try {
                return new DateTimeZone($tz);
            } catch (Exception $e) {
                // fall through to UTC
            }
        }
    }
    return new DateTimeZone('UTC');
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

function valid_month(string $month): bool {
    return (bool) preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month);
}

/**
 * Sorted YYYY-MM month ids that have an archive file for this city.
 *
 * Drives the calendar's month navigation: the frontend will not offer a
 * month that has no file behind it. An empty list is the normal state on
 * a fresh install — history accumulates from the first pipeline run
 * onward and is never backfilled.
 */
function list_history_months(string $city_id): array {
    $dir = HISTORY_ROOT . '/' . $city_id;
    if (!is_dir($dir)) {
        return [];
    }
    $months = [];
    foreach (scandir($dir) ?: [] as $entry) {
        if (substr($entry, -5) !== '.json') continue;
        $month = substr($entry, 0, -5);
        if (valid_month($month)) {
            $months[] = $month;
        }
    }
    sort($months);
    return $months;
}

/**
 * Load one month's archive file. Returns null when absent or malformed.
 *
 * Callers must treat null as "no history for that month" rather than an
 * error: a month the calendar can page to may legitimately predate the
 * archive.
 */
function load_history_month(string $city_id, string $month): ?array {
    $path = HISTORY_ROOT . '/' . $city_id . '/' . $month . '.json';
    if (!is_file($path)) {
        return null;
    }
    $decoded = json_decode((string) file_get_contents($path), true);
    if (!is_array($decoded) || !isset($decoded['days']) || !is_array($decoded['days'])) {
        return null;
    }
    return $decoded;
}

/**
 * Join venue coordinates and capacity onto each event of each archived
 * day, in place.
 *
 * The archive is otherwise self-contained by design, but venue lat/lon
 * is the one field it deliberately does NOT store: venues.json is the
 * single source of truth for coordinates, exactly as in forecast.php, and
 * a venue never moves in a way that should be frozen per-day.
 */
function join_history_venues(array &$days, string $city_id): void {
    $venues = load_venues_index($city_id);
    if (!$venues) {
        return;
    }
    foreach ($days as &$day) {
        if (!is_array($day) || !isset($day['events']) || !is_array($day['events'])) {
            continue;
        }
        foreach ($day['events'] as &$ev) {
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
    unset($day);
}

/**
 * Return the sorted list of YYYY-MM-DD subdirectories under
 * data/<city_id>/ that contain a forecast.json file — restricted to the
 * current window: today (in the city's own timezone) onward, capped at
 * 7 days. Old date folders lingering on disk are never listed, so the
 * site can't get stuck showing a past week even if pruning misses them.
 */
function list_forecast_days(string $city_id): array {
    $city_dir = DATA_ROOT . '/' . $city_id;
    if (!is_dir($city_dir)) {
        return [];
    }
    $today = (new DateTime('now', city_timezone($city_id)))->format('Y-m-d');
    $days = [];
    foreach (scandir($city_dir) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $entry)) continue;
        if (strcmp($entry, $today) < 0) continue;
        if (is_file($city_dir . '/' . $entry . '/forecast.json')) {
            $days[] = $entry;
        }
    }
    sort($days);
    return array_slice($days, 0, 7);
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
 * Age of an ISO-8601 timestamp in minutes, or null when the timestamp is
 * missing or unparseable. The pipeline writes offset-carrying timestamps
 * (e.g. 2026-07-03T06:12:00-04:00), so comparing epoch seconds against a
 * UTC "now" is timezone-correct regardless of the city.
 */
function iso_age_minutes(?string $iso): ?float {
    if (!is_string($iso) || $iso === '') {
        return null;
    }
    try {
        $then = new DateTime($iso);
    } catch (Exception $e) {
        return null;
    }
    $now = new DateTime('now', new DateTimeZone('UTC'));
    return ($now->getTimestamp() - $then->getTimestamp()) / 60.0;
}

/**
 * Compute a presentation-ready freshness summary for one city. Combines
 * the raw status timestamps with the operator-facing booleans the UI
 * actually cares about (is_fresh / is_stale / zero_event_run).
 *
 * Staleness is recomputed against the clock on EVERY request rather than
 * trusting the write-time 'stale' boolean baked into status.json. A
 * stalled pipeline never rewrites the file, so the stored flag would
 * stay false forever — exactly the silent failure this guards against.
 * Missing or unparseable timestamps read as stale.
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
    if (is_array($tm)) {
        $age = iso_age_minutes($tm['last_success_at'] ?? null);
        $max_min = (int) ($tm['max_age_minutes'] ?? 720);
        $tm['stale'] = ($age === null) || ($age > $max_min);
    }
    if (is_array($gtfs)) {
        $age = iso_age_minutes($gtfs['last_refresh_at'] ?? null);
        $max_days = (int) ($gtfs['max_age_days'] ?? 14);
        $gtfs['stale'] = ($age === null) || ($age > $max_days * 24 * 60);
    }
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
