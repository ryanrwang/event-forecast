<?php
/**
 * GET /api/status.php
 *
 * Returns the cron status surface — for every configured city, when the
 * Ticketmaster and GTFS pipelines last ran successfully, whether the
 * data is stale (per the thresholds the pipeline itself baked in), and
 * whether the most recent run flagged the "zero impactful events" sanity
 * alert.
 *
 * The frontend reads this on load to decide whether to show a stale-
 * data banner and to colour the data-source chip. The operator can also
 * curl this endpoint after a deploy to confirm cron is firing.
 *
 * IMPORTANT: this endpoint MUST NOT echo any API key. ``load_status``
 * reads only ``data/status.json`` which the pipeline writes; that file
 * never contains secrets.
 */

require_once __DIR__ . '/_common.php';

$status = load_status();
$ids = load_cities_list();

// Compose a presentation-friendly payload keyed by city id, in the
// same order as config/cities.json. Cities that haven't been crawled
// yet appear with present=false so the frontend can render a
// distinguishable "never run" state for them.
$cities_out = [];
foreach ($ids as $id) {
    $cities_out[$id] = city_freshness($id);
}

send_json([
    'schema_version' => $status['schema_version'] ?? 1,
    'updated_at'     => $status['updated_at']     ?? null,
    'cities'         => $cities_out,
    'attribution'    => attribution(),
]);
