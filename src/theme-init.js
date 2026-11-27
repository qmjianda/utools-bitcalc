(function () {
  'use strict';
  var theme = 'light';
  try {
    var stored = window.localStorage.getItem('bitcalc.theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  } catch (error) {
    // Storage can be unavailable; light is the safe default.
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
