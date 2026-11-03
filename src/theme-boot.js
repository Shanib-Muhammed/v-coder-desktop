// Applies the saved theme before first paint so there is no flash of the wrong scheme.
;(function () {
  try {
    var raw = localStorage.getItem('vcoder.ui');
    var ui = raw ? JSON.parse(raw) : {};
    var scheme = ui.theme || 'system';
    var dark = scheme === 'dark' || (scheme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.accent = ui.accent || 'blue';
    if (ui.motion === 'reduce') root.dataset.motion = 'reduce';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
