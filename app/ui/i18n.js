// Interface languages. Every page loads this file before its scripts: it
// loads the catalogues in i18n/ (one file per language, Spanish the
// reference) and gives t(key, vars). The language is a preference (prefs.js
// switches it); until it arrives, the last one used, or Windows' own.
//
// To add a language: copy i18n/es.js to i18n/<code>.js, translate it, and
// add the code to LANGUAGES here and to CATALOGUES in app/src/i18n.rs.

const I18n = (() => {
  const LANGUAGES = ["es", "en"];
  const REFERENCE = "es";
  const catalogues = {};
  const listeners = [];
  // Loaded in order, before the page's next script runs; next to this file,
  // wherever the page is.
  const base = document.currentScript.src.replace(/[^/]*$/, "");
  for (const code of LANGUAGES) document.write(`<script src="${base}i18n/${code}.js"><\/script>`);

  const pick = (code) => (LANGUAGES.includes(code) ? code : null);
  let saved = null;
  try {
    saved = localStorage.getItem("language");
  } catch {}
  let lang = pick(saved) ?? pick(navigator.language.slice(0, 2).toLowerCase()) ?? REFERENCE;

  // Every [data-i18n] element shows its text in the language.
  function translate(root = document) {
    root.documentElement?.setAttribute("lang", lang);
    root.querySelectorAll("[data-i18n]").forEach((e) => (e.textContent = t(e.dataset.i18n)));
  }

  return {
    add(code, name, strings) {
      catalogues[code] = { name, strings };
    },
    lang: () => lang,
    // Every language, written in its own name.
    languages: () => LANGUAGES.filter((c) => catalogues[c]).map((code) => ({ code, name: catalogues[code].name })),
    // The language changes: the pages re-render (prefs.js calls it before
    // its own listeners, so they render in the new one). No code keeps it.
    use(code) {
      if (!code) return;
      code = pick(code) ?? REFERENCE;
      try {
        localStorage.setItem("language", code);
      } catch {}
      if (code === lang) return;
      lang = code;
      translate();
      listeners.forEach((f) => f(lang));
    },
    // Runs `f` on every change (not now: the page renders on load anyway).
    watch(f) {
      listeners.push(f);
    },
    text(key) {
      const s = catalogues[lang]?.strings[key] ?? catalogues[REFERENCE]?.strings[key];
      if (s == null) console.warn(`i18n: no text for ${key}`);
      return s ?? key;
    },
    translate,
  };
})();

// The text for `key` in the interface language; `{name}` in it becomes
// vars.name. Button tokens ({A}, {View}, {↕}) stay for withButtons.
function t(key, vars) {
  let s = I18n.text(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

document.addEventListener("DOMContentLoaded", () => I18n.translate());
