// Console UI website: language and mode, the live app pages (home, keyboard,
// control center) driven by the visitor's controller, keyboard or the drawn
// buttons, the settings' option previews and the controller map.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lang = () => root.dataset.lang;
  // One piece failing (a live page, a preview) never takes the rest of the page with it.
  const safe = (f) => {
    try {
      f();
    } catch (e) {
      console.error(e);
    }
  };

  // ---------- icons: the app's set plus a few for the page ----------
  Object.assign(ICONS, {
    book: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6l0 13"/><path d="M12 6l0 13"/><path d="M21 6l0 13"/>',
    github: '<path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"/>',
    sun: '<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>',
    "arrow-up": '<path d="M12 5l0 14"/><path d="M18 11l-6 -6"/><path d="M6 11l6 -6"/>',
    "chevron-down": '<path d="M6 9l6 6l6 -6"/>',
    hand: '<path d="M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5"/><path d="M14 5.5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47"/>',
    school: '<path d="M22 9l-10 -4l-10 4l10 4l10 -4v6"/><path d="M6 10.6v5.4a6 3 0 0 0 12 0v-5.4"/>',
    lock: '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>',
    "cloud-off": '<path d="M9.58 5.548c.24 -.11 .492 -.207 .752 -.286c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 .957 -.383 1.824 -1.003 2.454m-2.997 1.033h-11.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.13 -.582 .37 -1.128 .7 -1.62"/><path d="M3 3l18 18"/>',
    shield: '<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"/>',
    "eye-off": '<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/>',
    "pointer-fill": '<path fill="currentColor" d="M5 3l14 8l-6 1.6l-3 6.4z"/>',
  });
  function paintIcons(scope = document) {
    $$("i[data-ic]", scope).forEach((i) => {
      const name = i.dataset.ic === "mode" ? (root.dataset.mode === "dark" ? "sun" : "moon") : i.dataset.ic;
      if (i.dataset.drawn === name) return;
      i.dataset.drawn = name;
      i.innerHTML = ICONS[name] ? icon(name, "") : "";
    });
  }

  // Text with {A}, {View}… shows the buttons drawn as in the app.
  $$("[data-b]").forEach((el) => {
    $$(":scope > [data-l]", el).forEach((s) => s.replaceChildren(...withButtons(s.textContent)));
  });

  // ---------- language and mode ----------
  function setLang(l) {
    root.dataset.lang = l;
    root.lang = l;
    document.title = root.dataset[l === "en" ? "titleEn" : "titleEs"];
    $$("[data-set-lang]").forEach((b) => b.classList.toggle("on", b.dataset.setLang === l));
    store("cui-lang", l);
    // The app's own pieces speak the page's language: its texts here (previews)
    // and in every live page.
    if (typeof I18n !== "undefined") I18n.use(l);
    Object.values(frames).forEach((f) => post(f, { cui: "prefs", prefs: { language: l } }));
    // The docs in the same language (Spanish lives under docs/es/).
    $$('a[href^="docs/"]').forEach((a) => {
      a.dataset.href ??= a.getAttribute("href");
      a.setAttribute("href", l === "es" ? a.dataset.href.replace(/^docs\//, "docs/es/") : a.dataset.href);
    });
    safe(showPreview);
    safe(drawPadMap);
  }
  $$("[data-set-lang]").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.setLang)));
  $("[data-toggle-mode]").addEventListener("click", () => {
    root.dataset.mode = root.dataset.mode === "dark" ? "light" : "dark";
    store("cui-mode", root.dataset.mode);
    paintIcons();
    // The previews read their colours again when the root's style changes.
    root.style.setProperty("--mode", root.dataset.mode);
  });

  // ---------- the app's pages ----------
  const frames = Object.fromEntries($$("iframe[data-frame]").map((f) => [f.dataset.frame, f]));
  const post = (frame, msg) => frame.contentWindow?.postMessage(msg, "*");

  // Each page is drawn at its real size (a 1080p TV, the 800 × 390 keyboard)
  // and scaled to its box.
  const SIZE = { home: 1920, guide: 1920, keyboard: 800 };
  const fit = new ResizeObserver((entries) => {
    for (const e of entries) {
      const f = e.target.querySelector("iframe");
      f.style.setProperty("--k", String(e.contentRect.width / SIZE[f.dataset.frame]));
    }
  });
  Object.values(frames).forEach((f) => fit.observe(f.parentElement));

  // A page that is off screen goes quiet (no animated background, no video).
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const f = e.target;
      f.dataset.visible = e.isIntersecting ? "1" : "";
      post(f, { cui: "mode", mode: e.isIntersecting ? f.dataset.frame : "off" });
    }
  }, { threshold: 0.15 });
  Object.values(frames).forEach((f) => f.addEventListener("load", () => seen.observe(f)));

  // ---------- input: the demo being driven ----------
  const demos = $$("[data-demo]");
  let driving = null;
  function drive(demo) {
    if (driving === demo) return;
    demos.forEach((d) => d.classList.toggle("driving", d === demo));
    driving = demo;
  }
  // Without a choice, the demo most on screen.
  function target() {
    if (driving && onScreen(driving) > 0.2) return driving;
    return demos.map((d) => [d, onScreen(d)]).sort((a, b) => b[1] - a[1])[0]?.[1] > 0.2 ? demos.map((d) => [d, onScreen(d)]).sort((a, b) => b[1] - a[1])[0][0] : null;
  }
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / Math.max(1, r.height);
  }
  const frameOf = (demo) => demo && $("iframe", demo);

  function send(demo, payload) {
    const f = frameOf(demo);
    if (!f) return;
    post(f, { cui: "pad", payload });
    if (payload.kind !== "release") light(demo, payload.button ?? payload.dir);
  }
  function light(demo, key) {
    const b = $(`[data-press="${key}"], [data-nav="${key}"]`, demo);
    if (!b) return;
    b.classList.add("lit");
    clearTimeout(b._lit);
    b._lit = setTimeout(() => b.classList.remove("lit"), 160);
  }
  const press = (demo, button) => {
    send(demo, { kind: "press", button });
    send(demo, { kind: "release", button });
  };
  const nav = (demo, dir) => send(demo, { kind: "nav", source: "dpad", dir });

  // The drawn buttons under each demo.
  demos.forEach((demo) => {
    demo.addEventListener("pointerdown", () => drive(demo));
    $$("[data-press]", demo).forEach((b) => b.addEventListener("click", () => press(demo, b.dataset.press)));
    $$("[data-nav]", demo).forEach((b) => b.addEventListener("click", () => nav(demo, b.dataset.nav)));
  });

  // The keyboard: only while a demo is being driven (clicked or focused), so
  // the arrows still scroll the page otherwise.
  const KEYS = { Enter: "a", " ": "a", Escape: "b", Backspace: "b", x: "x", y: "y", q: "lb", e: "rb", z: "lt", c: "rt", m: "menu", v: "view", r: "r3" };
  const ARROWS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  function onKey(ev) {
    if (!driving || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const dir = ARROWS[ev.key];
    const button = KEYS[ev.key.length === 1 ? ev.key.toLowerCase() : ev.key];
    if (!dir && !button) return;
    ev.preventDefault();
    if (dir) nav(driving, dir);
    else press(driving, button);
  }
  addEventListener("keydown", onKey);
  // A click inside a page moves the focus into it: listen there too.
  Object.values(frames).forEach((f) => f.addEventListener("load", () => {
    f.contentWindow.addEventListener("keydown", onKey);
    f.contentWindow.addEventListener("pointerdown", () => drive(f.closest("[data-demo]")));
  }));
  addEventListener("pointerdown", (ev) => {
    if (!ev.target.closest("[data-demo]")) drive(null);
  });

  // A real controller, through the browser's Gamepad API (standard mapping).
  const PAD_BUTTONS = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "l3", "r3"];
  const PAD_DIRS = { 12: "up", 13: "down", 14: "left", 15: "right" };
  const FIRST_REPEAT = 260, REPEAT = 90;
  let held = {}, repeat = { dir: null, next: 0 }, polling = false;
  function stickDir(gp) {
    const [x, y] = gp.axes;
    if (Math.hypot(x, y) < 0.55) return null;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? "right" : "left") : y > 0 ? "down" : "up";
  }
  function poll(now) {
    const gp = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
    if (!gp) {
      polling = false;
      return;
    }
    const demo = target();
    PAD_BUTTONS.forEach((name, i) => {
      const down = gp.buttons[i]?.pressed ?? false;
      if (down && !held[name] && demo) send(demo, { kind: "press", button: name });
      if (!down && held[name] && demo) send(demo, { kind: "release", button: name });
      held[name] = down;
    });
    const dir = Object.entries(PAD_DIRS).find(([i]) => gp.buttons[i]?.pressed)?.[1] ?? stickDir(gp);
    if (dir !== repeat.dir) {
      repeat = { dir, next: now + FIRST_REPEAT };
      if (dir && demo) nav(demo, dir);
    } else if (dir && now >= repeat.next) {
      repeat.next = now + REPEAT;
      if (demo) nav(demo, dir);
    }
    requestAnimationFrame(poll);
  }
  function padStatus(connected) {
    $$("[data-pad-status] [data-when]").forEach((s) => (s.hidden = s.dataset.when !== (connected ? "pad" : "none")));
  }
  addEventListener("gamepadconnected", () => {
    padStatus(true);
    if (!polling) {
      polling = true;
      requestAnimationFrame(poll);
    }
  });
  addEventListener("gamepaddisconnected", () => padStatus([...(navigator.getGamepads?.() ?? [])].some(Boolean)));

  // ---------- what the pages tell us back ----------
  const typed = $("[data-typed]");
  let text = "";
  const SAMPLE = { es: "recetas fáciles", en: "easy recipes" };
  addEventListener("message", ({ data, source }) => {
    if (!data || typeof data !== "object" || !data.cui) return;
    if (data.type === "type") text += data.text;
    else if (data.type === "replace") text = [...text].slice(0, -data.delete || undefined).join("") + data.text;
    else if (data.type === "key" && data.key === "backspace") text = [...text].slice(0, -1).join("");
    else if (data.type === "key" && data.key === "enter") text = "";
    else if (data.type === "prefs") {
      // A change made in the home screen's settings reaches every page.
      for (const f of Object.values(frames)) if (f.contentWindow !== source) post(f, { cui: "prefs", prefs: data.prefs });
      syncControls(data.prefs);
      return;
    } else if (data.cui === "guide" && ["back", "switch", "home"].includes(data.type)) {
      // The control center closes: open it again a moment later, as if
      // View + Menu were held once more.
      post(frames.guide, { cui: "mode", mode: "off" });
      setTimeout(() => post(frames.guide, { cui: "mode", mode: "guide" }), 1200);
      return;
    } else return;
    if (typed) typed.textContent = text;
  });
  if (typed) typed.textContent = "";

  // ---------- settings to try, shared by every page ----------
  const prefs = { accent: "blue", text_size: 100, high_contrast: false, thick_focus: false };
  const ACCENTS = { blue: "#4c8dff", violet: "#9b87f5", green: "#3fb68b", amber: "#f0a83a", pink: "#e8709f", ivory: "#ece8df" };
  const accents = $("[data-accents]");
  Object.entries(ACCENTS).forEach(([id, hex]) => {
    const b = Object.assign(document.createElement("button"), { type: "button", title: id });
    b.dataset.value = id;
    b.style.background = hex;
    b.addEventListener("click", () => setPref("accent", id));
    accents.append(b);
  });
  function setPref(name, value) {
    prefs[name] = value;
    Object.values(frames).forEach((f) => post(f, { cui: "prefs", prefs: { [name]: value } }));
    syncControls(prefs);
  }
  function syncControls(p) {
    Object.assign(prefs, p);
    $$("[data-accents] button").forEach((b) => b.classList.toggle("on", b.dataset.value === prefs.accent));
    $$("[data-pref-seg]").forEach((seg) => $$("button", seg).forEach((b) => b.classList.toggle("on", b.dataset.value === String(prefs[seg.dataset.prefSeg]))));
    $$("[data-pref-switch]").forEach((s) => s.setAttribute("aria-checked", String(!!prefs[s.dataset.prefSwitch])));
  }
  $$("[data-pref-seg]").forEach((seg) => $$("button", seg).forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.value;
    setPref(seg.dataset.prefSeg, /^\d+$/.test(v) ? Number(v) : v);
  })));
  $$("[data-pref-switch]").forEach((s) => s.addEventListener("click", () => setPref(s.dataset.prefSwitch, !prefs[s.dataset.prefSwitch])));
  syncControls(prefs);

  // ---------- the settings' option previews ----------
  const NAMES = {
    slowdown: { es: ["No", "Suave", "Normal", "Fuerte"], en: ["Off", "Soft", "Normal", "Strong"] },
    cursor_speed: { es: ["Lenta", "Normal", "Rápida"], en: ["Slow", "Normal", "Fast"] },
    deadzone: { es: ["Poco", "Normal", "Mucho"], en: ["Little", "Normal", "A lot"] },
  };
  const DEFAULT_VALUE = { slowdown: 55, cursor_speed: 100, deadzone: 12 };
  const stage = $("[data-preview-stage]");
  const pv = { id: "slowdown", value: 55 };
  function showPreview(prev) {
    if (!stage || typeof Previews === "undefined") return;
    const values = Previews.values(pv.id);
    const box = $("[data-preview-values]");
    box.replaceChildren(...values.map((v, i) => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: NAMES[pv.id][lang()][i] });
      b.classList.toggle("on", v === pv.value);
      b.addEventListener("click", () => {
        const before = pv.value;
        pv.value = v;
        showPreview(before);
      });
      return b;
    }));
    $("[data-preview-caption]").textContent = Previews.caption(pv.id, pv.value);
    Previews.show(pv.id, pv.value, prev);
  }
  if (stage && typeof Previews !== "undefined") {
    Previews.mount(stage);
    $$("[data-preview-options] button").forEach((b) => b.addEventListener("click", () => {
      $$("[data-preview-options] button").forEach((x) => x.classList.toggle("on", x === b));
      pv.id = b.dataset.option;
      pv.value = DEFAULT_VALUE[pv.id];
      showPreview();
    }));
    showPreview();
  }

  // ---------- the controller map ----------
  // What each button does where you are; the drawing is the app's own.
  const T = (es, en) => ({ es, en });
  const GAME = T("Del juego", "The game's");
  const MAP = {
    cursor: {
      lt: T("Mantener: puntero lento. Con la cruceta, salta al botón más cercano", "Hold: slow pointer. With the d-pad, jump to the nearest button"),
      lb: T("Atrás", "Back"),
      l3: T("La palanca mueve el puntero. Presionarla, clic central", "The stick moves the pointer. Press it, middle click"),
      up: T("Flechas del teclado", "Arrow keys"),
      view: T("Centro de control. Mantener, menú rápido", "Control center. Hold for the quick menu"),
      rt: T("Toque, Intro. Mantener con la cruceta, volumen y canción", "Tap, Enter. Hold with the d-pad, volume and song"),
      rb: T("Adelante", "Forward"),
      y: T("Abrir el teclado", "Open the keyboard"),
      x: T("Clic derecho", "Right click"),
      b: T("Esc", "Esc"),
      a: T("Clic", "Click"),
      r3: T("La palanca derecha desplaza", "The right stick scrolls"),
      menu: T("Menú Inicio de Windows. Mantener, Inicio", "Windows Start menu. Hold for the home screen"),
    },
    keyboard: {
      lt: T("—", "—"),
      lb: T("Mayúsculas", "Shift"),
      l3: T("Idiomas", "Languages"),
      up: T("Mover entre las teclas", "Move between the keys"),
      view: T("Usar la primera sugerencia", "Take the first suggestion"),
      rt: T("Intro", "Enter"),
      rb: T("Símbolos", "Symbols"),
      y: T("Espacio", "Space"),
      x: T("Borrar", "Backspace"),
      b: T("Cerrar el teclado", "Close the keyboard"),
      a: T("Escribir. Mantener, tildes", "Type. Hold for accents"),
      r3: T("La palanca derecha mueve el cursor de texto", "The right stick moves the text caret"),
      menu: T("Intro", "Enter"),
    },
    home: {
      lt: T("Canción anterior", "Previous song"),
      lb: T("Pestaña anterior", "Previous tab"),
      l3: T("—", "—"),
      up: T("Moverse. Arriba y abajo, volumen", "Move. Up and down, volume"),
      view: T("—", "—"),
      rt: T("Siguiente canción", "Next song"),
      rb: T("Pestaña siguiente", "Next tab"),
      y: T("Buscar juegos o silenciar", "Search games or mute"),
      x: T("Reproducir o pausar", "Play or pause"),
      b: T("Volver o cerrar", "Back or close"),
      a: T("Abrir o Reanudar", "Open or resume"),
      r3: T("Letra o carátula", "Lyrics or cover"),
      menu: T("Personalizar. Mantener, cerrar", "Customize. Hold to close"),
    },
    game: {
      lt: GAME, lb: GAME, l3: GAME, up: GAME, rt: GAME, rb: GAME, y: GAME, x: GAME, b: GAME, a: GAME, r3: GAME,
      view: T("Con Menú, centro de control", "With Menu, control center"),
      menu: T("Con Vista, centro de control", "With View, control center"),
    },
  };
  const LEFT = [["lt", "LT"], ["lb", "LB"], ["l3", "L3"], ["up", "↕"], ["view", "View"]];
  const RIGHT = [["rt", "RT"], ["rb", "RB"], ["y", "Y"], ["x", "X"], ["b", "B"], ["a", "A"], ["r3", "R3"], ["menu", "Menu"]];
  // The drawing's ids for the rows that aren't one of its buttons.
  const DRAWN = { up: ["up", "down", "left", "right"], view: [], menu: [] };
  let padMode = "cursor", padTheme = "grafito", padWin = null;

  function drawPadMap() {
    const art = $("[data-pad-art]");
    if (!art || !padWin?.padSvg) return;
    if (!art.dataset.theme || art.dataset.theme !== padTheme) {
      art.innerHTML = padWin.padSvg(padTheme);
      art.dataset.theme = padTheme;
    }
    for (const [side, rows] of [["left", LEFT], ["right", RIGHT]]) {
      $(`[data-side="${side}"]`).replaceChildren(...rows.map(([id, label]) => {
        const what = MAP[padMode][id][lang()];
        const li = document.createElement("li");
        li.classList.toggle("none", what === "—" || what === GAME[lang()]);
        const glyph = setGlyph(Object.assign(document.createElement("span"), { className: "glyph" }), label, true);
        li.append(glyph, Object.assign(document.createElement("span"), { className: "what", textContent: what === "—" ? "" : what }));
        li.addEventListener("pointerenter", () => mark(id, li));
        li.addEventListener("pointerleave", () => mark(null));
        return li;
      }));
    }
  }
  function mark(id, li) {
    $$("[data-pad-map] li.at").forEach((x) => x.classList.remove("at"));
    li?.classList.add("at");
    $$("[data-pad-art] [data-b]").forEach((g) => g.classList.toggle("on", !!id && (DRAWN[id] ?? [id]).includes(g.dataset.b)));
  }
  $$("[data-pad-modes] button").forEach((b) => b.addEventListener("click", () => {
    $$("[data-pad-modes] button").forEach((x) => x.classList.toggle("on", x === b));
    padMode = b.dataset.mode;
    drawPadMap();
  }));
  // The drawing, its styles and its colours come from the home screen page.
  frames.home?.addEventListener("load", () => {
    padWin = frames.home.contentWindow;
    const css = [];
    for (const sheet of padWin.document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) if (rule.selectorText?.includes(".pad-drawing") && !rule.selectorText.includes("high-contrast")) css.push(rule.cssText);
      } catch {}
    }
    document.head.append(Object.assign(document.createElement("style"), { textContent: css.join("\n") }));
    const themes = padWin.eval("PAD_THEMES");
    const box = $("[data-pad-themes]");
    box.replaceChildren(...themes.map((t) => {
      const b = Object.assign(document.createElement("button"), { type: "button", title: t.name });
      b.style.background = t.body;
      b.classList.toggle("on", t.id === padTheme);
      b.addEventListener("click", () => {
        padTheme = t.id;
        $$("button", box).forEach((x) => x.classList.toggle("on", x === b));
        drawPadMap();
      });
      return b;
    }));
    drawPadMap();
  });

  // ---------- start ----------
  paintIcons();
  safe(() => setLang(lang()));
})();
