<?php
/**
 * GET /api/cities.php
 *
 * Returns the list of configured cities (with display name + tz) so the
 * frontend can decide whether to render a city selector. When the list
 * has a single entry the selector stays hidden by convention.
 */

require_once __DIR__ . '/_common.php';

$ids = load_cities_list();
$cities = [];
foreach ($ids as $id) {
    $cfg_path = CONFIG_ROOT . '/' . $id . '/city.json';
    if (!is_file($cfg_path)) continue;
    $cfg = json_decode(file_get_contents($cfg_path), true);
    if (!is_array($cfg)) continue;
    $cities[] = [
        'id'       => $cfg['id']       ?? $id,
        'name'     => $cfg['name']     ?? $id,
        'timezone' => $cfg['timezone'] ?? null,
    ];
}

send_json([
    'cities'      => $cities,
    'attribution' => attribution(),
]);
