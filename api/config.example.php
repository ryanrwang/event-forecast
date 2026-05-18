<?php
/**
 * Example secrets shape for the PHP serving layer.
 *
 * Copy to api/config.php (gitignored) and fill in. The M1 endpoints do
 * NOT read a Ticketmaster key — they only serve cached JSON written by
 * the Python pipeline. This file documents the convention so future
 * endpoints (e.g. server-side TM proxies in later milestones) have a
 * known place to drop the key.
 *
 * NEVER commit api/config.php. NEVER echo any value from this array.
 */

return [
    'ticketmaster_api_key' => 'YOUR_KEY_HERE',
    // Override paths only if your hosting layout differs from repo defaults.
    // 'data_root'   => __DIR__ . '/../data',
    // 'config_root' => __DIR__ . '/../config',
];
