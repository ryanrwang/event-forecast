/*
 * Event Forecast — App entry point
 *
 * M0: replace the placeholder rendering with the data-spine wiring
 * (fetch /api/cities/<city>/<day>.json, hand off to forecast-strip and
 * detail renderers). Until then, this script only sets the theme and
 * draws a "Forecast loading…" placeholder so a deploy is verifiable
 * end-to-end without any API calls.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'eventforecast.theme';
  var DEFAULT_THEME = 'dark';

  function applyTheme() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    var theme = saved === 'light' ? 'light' : DEFAULT_THEME;
    document.documentElement.setAttribute('data-theme', theme);
  }

  function renderPlaceholder() {
    var strip = document.getElementById('forecast-strip');
    var detail = document.getElementById('forecast-detail');
    if (strip) {
      strip.innerHTML =
        '<div class="placeholder">' +
          '<span class="placeholder__dot" aria-hidden="true"></span>' +
          'Forecast loading…' +
        '</div>';
    }
    if (detail) {
      detail.innerHTML =
        '<div class="placeholder">' +
          'Select a day to see where and when the crunch lands.' +
        '</div>';
    }
  }

  function init() {
    applyTheme();
    renderPlaceholder();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
