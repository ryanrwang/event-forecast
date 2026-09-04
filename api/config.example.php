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
 * NEVER commit api/config.php. NEVER echo any value from this array,
 * with the single documented exception of carto_basemap_key below.
 */

return [
    'ticketmaster_api_key' => 'YOUR_KEY_HERE',

    // CARTO basemap key -- free within CARTO's fair-use limit, requested
    // at https://carto.com/basemaps/apikey
    //
    // This one IS served to the browser (api/city.php -> app.js -> map.js)
    // because the browser fetches map tiles from CARTO directly, so it is
    // public by construction. It lives here rather than in map.js only to
    // keep it out of the public git repo. Leave empty and the map falls
    // back to keyless tiles, which render with an "API KEY REQUIRED"
    // watermark.
    'carto_basemap_key' => '',
    // Override paths only if your hosting layout differs from repo defaults.
    // 'data_root'   => __DIR__ . '/../data',
    // 'config_root' => __DIR__ . '/../config',
];
