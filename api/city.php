<?php
/**
 * GET /api/city.php?id=<city_id>
 *
 * Returns the per-city config (id, name, timezone, bbox, etc.) plus
 * the list of available forecast days under data/<city_id>/.
 * The venue whitelist is NOT echoed — it's server-side detail.
 *
 * Also returns the per-city freshness summary (Ticketmaster + GTFS
 * staleness + zero-event-run sanity flag) so the frontend can render
 * the stale-data banner without a second roundtrip.
 */

require_once __DIR__ . '/_common.php';

$id = (string) ($_GET['id'] ?? '');
if ($id === '') {
    bad_request('missing required query parameter: id');
}
if (!valid_city_id($id)) {
    not_found('unknown city: ' . $id);
}

$cfg = load_city_config($id);

$city_payload = [
    'id'               => $cfg['id']               ?? $id,
    'name'             => $cfg['name']             ?? $id,
    'timezone'         => $cfg['timezone']         ?? null,
    'country_code'     => $cfg['country_code']     ?? null,
    'bbox'             => $cfg['bbox']             ?? null,
    'map_default_view' => $cfg['map_default_view'] ?? null,
    // Agency line colours (brand data, not design tokens) for the line
    // pills. Cast to object so an empty map serialises as {} not [].
    'line_colors'      => (object) ($cfg['transit']['line_colors'] ?? []),
];

send_json([
    'city'              => $city_payload,
    'days'              => list_forecast_days($id),
    'attribution'       => attribution(),
    'map_attribution'   => map_attribution(),
    'basemap'           => ['key' => basemap_key()],
    'gtfs_attribution'  => gtfs_attribution_for($id),
    'freshness'         => city_freshness($id),
]);
