<?php
/**
 * GET /api/cities.php
 *
 * Returns the list of configured cities (with display name + tz) so the
 * frontend can decide whether to render a city selector. When the list
 * has a single entry the selector stays hidden by convention.
 *
 * Also returns the required attribution surfaces — Ticketmaster, OSM +
 * CARTO basemap, and the per-city GTFS feed license. The frontend
 * places these in the legend + footer; rendering anywhere events or
 * map tiles or transit data appear is a contractual requirement of
 * the respective free-tier ToS.
 */

require_once __DIR__ . '/_common.php';

$ids = load_cities_list();
$cities = [];
$gtfs_attributions = [];
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
    $g = gtfs_attribution_for($id);
    if ($g !== null) {
        $gtfs_attributions[$id] = $g;
    }
}

send_json([
    'cities'             => $cities,
    'attribution'        => attribution(),
    'map_attribution'    => map_attribution(),
    'basemap'            => ['key' => basemap_key()],
    'gtfs_attributions'  => $gtfs_attributions,
]);
