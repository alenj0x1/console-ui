// Preferences every window applies at once: the interface language, the
// accent colour (and a text colour that reads on it), the text size and the
// focus ring. They come from
// the app on load and again whenever the settings change one.

const Prefs = (() => {
  // Accents that read on the graphite background; ids match prefs.rs.
  const ACCENTS = {
    blue: "#4c8dff",
    violet: "#9b87f5",
    green: "#3fb68b",
    amber: "#f0a83a",
    pink: "#e8709f",
    ivory: "#ece8df",
  };
  const HIGH_CONTRAST_ACCENT = "#ffd60a";
  const listeners = [];
  let current = null;

  // Dark text on light accents, white on the others.
  function onAccent(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#1e1f22" : "#ffffff";
  }

  function apply(p) {
    current = p;
    I18n.use(p.language);
    const root = document.documentElement;
    // High contrast: a yellow focus and accent, whatever colour was chosen.
    const accent = p.high_contrast ? HIGH_CONTRAST_ACCENT : ACCENTS[p.accent] ?? ACCENTS.blue;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--on-accent", onAccent(accent));
    root.style.setProperty("--text-scale", String((p.text_size || 100) / 100));
    root.classList.toggle("thick-focus", !!p.thick_focus);
    root.classList.toggle("high-contrast", !!p.high_contrast);
    if (typeof Backgrounds !== "undefined") Backgrounds.refresh();
    listeners.forEach((f) => f(p));
  }

  const tauri = window.__TAURI__;
  tauri.core.invoke("preferences").then(apply).catch(console.error);
  tauri.webviewWindow.getCurrentWebviewWindow().listen("preferences", ({ payload }) => apply(payload));

  return {
    ACCENTS,
    get: () => current,
    // Runs `f` now (if loaded) and on every change.
    watch(f) {
      listeners.push(f);
      if (current) f(current);
    },
  };
})();
