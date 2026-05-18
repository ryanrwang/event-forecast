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

define('ATTRIBUTION_TEXT', 'Event discovery powered by Ticketmaster.');
define('ATTRIBUTION_URL',  'https://developer.ticketmaster.com/');

function attribution(): array {
    return [
        'text' => ATTRIBUTION_TEXT,
        'url'  => ATTRIBUTION_URL,
    ];
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
