/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press / SLR Studio — Theme controller

   Three states, cycled by the toggle:
     auto  → no data-theme attribute, follows OS (prefers-color-scheme)
     light → data-theme="light", overrides OS
     dark  → data-theme="dark", overrides OS

   Persisted in localStorage key "gp-theme" with values "light" | "dark".
   "auto" is represented by the absence of the key.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  const KEY = 'gp-theme';
  const LEGACY_KEY = 'gp_theme';   // pre-2026-04-30 app.html system
  const root = document.documentElement;

  // One-time migration from the old 2-state app.html toggle
  try {
    if (!localStorage.getItem(KEY) && localStorage.getItem(LEGACY_KEY) === 'light') {
      localStorage.setItem(KEY, 'light');
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {}

  function apply(mode) {
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  function current() {
    return localStorage.getItem(KEY) || 'auto';
  }

  function set(mode) {
    if (mode === 'auto') {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, mode);
    }
    apply(mode);
    refreshControls();
  }

  function next(mode) {
    return { auto: 'light', light: 'dark', dark: 'auto' }[mode] || 'auto';
  }

  function refreshControls() {
    const mode = current();
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.dataset.mode = mode;
      const label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[mode];
      const icon  = { auto: '◐', light: '☀', dark: '☾' }[mode];
      btn.setAttribute('title', `Theme: ${label} (click to cycle)`);
      btn.setAttribute('aria-label', `Theme: ${label}. Click to cycle.`);
      const iconEl  = btn.querySelector('[data-theme-icon]');
      const labelEl = btn.querySelector('[data-theme-label]');
      if (iconEl)  iconEl.textContent  = icon;
      if (labelEl) labelEl.textContent = label;
    });
  }

  // Apply stored mode immediately (before render) to avoid flash
  apply(current());

  // Wire up toggles when DOM is ready
  function init() {
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      if (btn.dataset.themeWired) return;
      btn.dataset.themeWired = '1';
      btn.addEventListener('click', () => set(next(current())));
    });
    refreshControls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose minimal API for non-toggle callers
  window.gpTheme = { current, set };
})();
