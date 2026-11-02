// Runs Console UI's real pages (home, keyboard, control center) on the
// website: it stands in for the desktop app behind them with sample data.
// The page around them sends the controller's events with postMessage
// ({ cui: "pad", payload }) and gets back what the app would do (typing,
// switching windows, preference changes) the same way.
(() => {
  const page = location.pathname.split("/").pop().replace(".html", "") || "home";
  const MEDIA = new URL("../demo/media/", location.href).href;
  const ASSET = "demo:";
  window.__ASSET = ASSET;

  // ---------- sample data ----------

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const ART = ["hero", "capsule", "header", "logo"];
  const games = [
    { id: "steam:367520", name: "Hollow Knight", source: "steam", last_played: now - 3600, art: ART },
    { id: "steam:1030300", name: "Hollow Knight: Silksong", source: "steam", last_played: now - DAY, art: ART },
    { id: "steam:1091500", name: "Cyberpunk 2077", source: "steam", last_played: now - DAY * 4, art: ART },
    { id: "steam:774171", name: "Muse Dash", source: "steam", last_played: now - DAY * 9, art: ART },
    { id: "steam:860510", name: "Little Nightmares II", source: "steam", last_played: now - DAY * 30, art: ART },
  ];
  const apps = [
    { id: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", name: "Spotify" },
    { id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: { es: "Calculadora", en: "Calculator" } },
    { id: "Microsoft.Windows.Explorer", name: { es: "Explorador de archivos", en: "File Explorer" } },
    { id: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", name: { es: "Configuración", en: "Settings" } },
    { id: "Microsoft.Windows.Photos_8wekyb3d8bbwe!App", name: { es: "Fotos", en: "Photos" } },
    { id: "Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo", name: { es: "Películas y TV", en: "Movies & TV" } },
  ];
  const pinned = apps.slice(1).map((a) => a.id);
  const songs = [
    { title: "Luces de madrugada", artist: "Costa Media", duration_ms: 214000, cover: "cover-1" },
    { title: "Kilómetros", artist: "Los Faros", duration_ms: 187000, cover: "cover-2" },
    { title: "Verano en pausa", artist: "Nube Baja", duration_ms: 231000, cover: "cover-3" },
  ];
  // Original lines written for this demo, timed to the first song.
  const LYRICS = [
    [0, ""], [6000, "Se encienden las luces de la avenida"], [12000, "y el control se queda en mi mano"],
    [18000, "no hace falta levantarse del sillón"], [24000, "todo está a un botón de distancia"],
    [31000, ""], [36000, "Luces de madrugada"], [41000, "la pantalla grande nos espera"],
    [47000, "una canción, un juego, una película"], [53000, "y la noche sigue entera"],
    [60000, ""], [66000, "Se encienden las luces de la avenida"], [72000, "y el control se queda en mi mano"],
  ];
  const windows = [
    { id: "w1", title: "Hollow Knight", game: true, minimized: false },
    { id: "w2", title: "Spotify", game: false, minimized: false },
    { id: "w3", title: { es: "Recetas para el fin de semana - Microsoft Edge", en: "Weekend recipes - Microsoft Edge" }, game: false, minimized: false },
    { id: "w4", title: { es: "Explorador de archivos", en: "File Explorer" }, game: false, minimized: true },
  ];

  const WINDOW_ICONS = {
    w1: `${MEDIA}steam/367520-capsule.jpg`,
    w2: `${MEDIA}icons/spotifyab-spotifymusic-zpdnekdrzrea0-spotify.png`,
    w3: `${MEDIA}icons/microsoftedge.png`,
    w4: `${MEDIA}icons/microsoft-windows-explorer.png`,
  };

  const prefs = {
    accent: "blue", text_size: 100, thick_focus: false, high_contrast: false, game_art: true,
    keyboard_layout: "grid", suggestions: true, learn: true, languages: ["es"], available_languages: ["es", "en"],
    auto_game: true, rumble: true, start_with_windows: true, settings_view: "list", library_view: "banners",
    trailer_sound: false, music_online: true, music_lyrics: false, wall_dim: 0, game_order: "recent",
    cursor_speed: 100, deadzone: 12, slowdown: 55, scroll_speed: 100, invert_scroll: false, swap_sticks: false,
    swap_ab: false, hold_time: 600, pad_theme: "grafito", hand: "both", button_map: {},
    // The website's language (it sends changes as they happen).
    language: (() => { try { return parent.document.documentElement.dataset.lang || "es"; } catch { return "es"; } })(),
  };
  const BUTTONS = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "l3", "r3", "up", "down", "left", "right"];
  const HANDS = {
    left: { lb: "a", lt: "x", l3: "b", up: "scroll_up", down: "scroll_down", left: "lb", right: "rb" },
    right: { rb: "a", rt: "x", r3: "b", y: "scroll_up", a: "scroll_down", x: "lb", b: "rb" },
  };
  let custom = {};
  function buttonMap() {
    return Object.fromEntries(BUTTONS.map((b) => [b, custom[b] ?? HANDS[prefs.hand]?.[b] ?? b]));
  }
  prefs.button_map = buttonMap();
  const DEFAULTS = structuredClone(prefs);

  let song = 0;
  let coverRev = 1;
  const media = { title: "", artist: "", playing: true, source: "Spotify.exe", cover: 1, position_ms: 0, duration_ms: 0, sampled_ms: 0 };
  function setSong(i, position = 0) {
    song = (i + songs.length) % songs.length;
    coverRev++;
    Object.assign(media, { title: songs[song].title, artist: songs[song].artist, cover: coverRev, position_ms: position, duration_ms: songs[song].duration_ms, sampled_ms: Date.now() });
  }
  setSong(0, 9000);
  const volume = { level: 0.6, muted: false };
  const wall = "builtin:diagonal";
  const walls = [
    ["diagonal", "Ola diagonal"], ["waves", "Ondas"], ["rain", "Lluvia"], ["breath", "Respiración"], ["lines", "Ondas lineales"],
  ].map(([id, title]) => ({ id: `builtin:${id}`, title, kind: "animated", origin: "Console UI" }));
  const tv = {
    on: false, pending: false, display: "tv", audio: "tv-audio",
    displays: [{ id: "main", name: "Monitor principal" }, { id: "tv", name: "TV de la sala" }],
    outputs: [{ id: "speakers", name: "Altavoces" }, { id: "tv-audio", name: "TV de la sala (HDMI)" }],
  };

  // Sample names in the website's language (a text, or { es, en }).
  const say = (v) => (typeof v === "string" ? v : v[prefs.language] ?? v.es);

  // ---------- assets: the app's own URLs become files on the website ----------

  function asset(url) {
    if (typeof url !== "string" || !url.startsWith(ASSET)) return url;
    const path = decodeURIComponent(url.slice(ASSET.length + 1));
    const [kind, ...rest] = path.split("/");
    const name = (s) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    // Games: the official art Steam gives every launcher (steam/<appid>-<kind>).
    if (kind === "art") return `${MEDIA}steam/${rest[0].split(":")[1]}-${rest[1]}.${rest[1] === "logo" ? "png" : "jpg"}`;
    if (kind === "icon") return `${MEDIA}icons/${name(rest[0])}.png`;
    if (kind.startsWith("cover")) return `${MEDIA}covers/${songs[song].cover}.svg`;
    if (kind === "window-icon") return WINDOW_ICONS[rest[0]] ?? "";
    if (kind === "window-shot") return rest[0] === "w1" ? `${MEDIA}steam/367520-hero.jpg` : `${MEDIA}windows/${rest[0]}-shot.svg`;
    return "";
  }
  for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
    const d = Object.getOwnPropertyDescriptor(proto, "src");
    Object.defineProperty(proto, "src", { get: d.get, set(v) { d.set.call(this, asset(v)); }, configurable: true });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    return setAttribute.call(this, n, n === "src" ? asset(v) : v);
  };

  // Inside the website, bringing a tile into view must only scroll the
  // page's own rows, never the website around it ("nearest" in both axes,
  // which is all the pages ask for).
  Element.prototype.scrollIntoView = function () {
    for (let box = this.parentElement; box && box !== document.documentElement; box = box.parentElement) {
      const s = getComputedStyle(box);
      const x = /auto|scroll|hidden/.test(s.overflowX) && box.scrollWidth > box.clientWidth;
      const y = /auto|scroll|hidden/.test(s.overflowY) && box.scrollHeight > box.clientHeight;
      if (!x && !y) continue;
      const r = this.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (x) box.scrollLeft += r.left < b.left ? r.left - b.left : r.right > b.right ? Math.min(r.right - b.right, r.left - b.left) : 0;
      if (y) box.scrollTop += r.top < b.top ? r.top - b.top : r.bottom > b.bottom ? Math.min(r.bottom - b.bottom, r.top - b.top) : 0;
    }
  };

  // ---------- events ----------

  const handlers = {};
  function listen(name, f) {
    (handlers[name] ??= []).push(f);
    return Promise.resolve(() => (handlers[name] = handlers[name].filter((g) => g !== f)));
  }
  function emit(name, payload) {
    (handlers[name] ?? []).forEach((f) => f({ payload }));
  }
  const up = (msg) => parent !== window && parent.postMessage({ cui: page, ...msg }, "*");

  addEventListener("message", ({ data }) => {
    if (!data || typeof data !== "object") return;
    if (data.cui === "pad") emit("pad", data.payload);
    else if (data.cui === "mode") {
      emit("mode", data.mode);
      // The control center draws its windows each time it opens.
      if (page === "guide" && data.mode === "guide") emit("windows", null);
    }
    else if (data.cui === "prefs") {
      const relabel = "language" in data.prefs && data.prefs.language !== prefs.language;
      Object.assign(prefs, data.prefs);
      emit("preferences", { ...prefs });
      // The sample names change language too.
      if (relabel && page === "home") emit("library", null);
      if (relabel && page === "guide") emit("windows", null);
    } else if (data.cui === "windows") emit("windows", null);
    else if (data.cui === "song") {
      setSong(song + data.step);
      emit("media", { ...media });
    }
  });

  function setPref(name, value) {
    if (name === "button_map") custom = value ?? {};
    else if (name.startsWith("button:")) custom[name.slice(7)] = value;
    else prefs[name] = value;
    prefs.button_map = buttonMap();
    const p = { ...prefs };
    setTimeout(() => {
      emit("preferences", p);
      up({ type: "prefs", prefs: p });
    }, 0);
    return p;
  }

  // ---------- commands ----------

  const commands = {
    preferences: () => ({ ...prefs }),
    set_preference: ({ name, value }) => setPref(name, value),
    reset_preferences: () => {
      custom = {};
      Object.assign(prefs, structuredClone(DEFAULTS));
      return setPref("hand", "both");
    },
    current_mode: () => page,
    media_now: () => ({ ...media }),
    media_control: ({ action }) => {
      if (action === "toggle") {
        const at = media.position_ms + (media.playing ? Date.now() - media.sampled_ms : 0);
        Object.assign(media, { playing: !media.playing, position_ms: at, sampled_ms: Date.now() });
      } else setSong(song + (action === "prev" ? -1 : 1));
      setTimeout(() => emit("media", { ...media }), 60);
      up({ type: "media", media: { ...media } });
    },
    volume_get: () => ({ ...volume }),
    volume_step: ({ delta }) => {
      volume.level = Math.min(1, Math.max(0, Math.round((volume.level + delta) * 100) / 100));
      volume.muted = false;
      return { ...volume };
    },
    volume_mute: () => {
      volume.muted = !volume.muted;
      return { ...volume };
    },
    home_data: () => ({ games, apps: apps.map((a) => ({ ...a, name: say(a.name) })), pinned, wallpaper: walls[0], game_art: prefs.game_art, media: ["SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "web:youtube", "web:netflix", "web:twitch"], last_game: games[0].id, running: [games[0].id] }),
    open_games: () => [games[0].id],
    wallpapers: () => ({ items: walls, current: wall, engine: false, folders: [] }),
    lyrics: () => (song === 0 ? { title: songs[0].title, artist: songs[0].artist, lines: LYRICS.map(([ms, text]) => ({ ms, text })), plain: [] } : null),
    game_trailer: () => false,
    tv_state: () => structuredClone(tv),
    tv_set: ({ on }) => {
      tv.on = on;
      return true;
    },
    launch: ({ id }) => {
      up({ type: "launch", id });
      return id.startsWith("steam:") || id.startsWith("epic:");
    },
    keyboard_config: () => ({ languages: prefs.languages, available: prefs.available_languages, layout: prefs.keyboard_layout, suggest: prefs.suggestions, learn: false, learned: { words: {}, pairs: {} } }),
    focus_is_password: () => false,
    type_text: ({ text }) => up({ type: "type", text }),
    press_key: ({ key }) => up({ type: "key", key }),
    replace_word: (a) => up({ type: "replace", ...a }),
    guide_windows: () => windows.map((w) => ({ ...w, title: say(w.title) })),
    pad_battery: () => ({ wired: false, level: 2 }),
    guide_switch: ({ id }) => up({ type: "switch", id }),
    guide_home: () => up({ type: "home" }),
    guide_back: () => up({ type: "back" }),
    guide_close_window: ({ id }) => {
      const at = windows.findIndex((w) => w.id === id);
      if (at >= 0) windows.splice(at, 1);
      setTimeout(() => emit("windows", null), 120);
    },
    guide_power: () => up({ type: "power" }),
  };

  // ---------- the mouse, as if it were the controller ----------
  // Hovering something the page can focus moves the focus there with the
  // same d-pad steps the controller would send; a click is A. The page never
  // learns about the mouse: it only gets controller events.
  const ITEMS = {
    home: ".tile, .search-key, .cat, .setting, .pad-label, .pad-action",
    keyboard: ".key, .menu-item",
    guide: ".window, .power .row",
  }[page];
  // Pages may draw their items again on every step, so an item is known by
  // its place in the list, not by its element.
  // A panel open over the page (Customize) is the only thing that takes the focus.
  const layer = () => document.querySelector("#quick:not([hidden])") ?? document;
  const items = () => [...layer().querySelectorAll(ITEMS)];
  const focusedAt = () => items().findIndex((e) => e.classList.contains("on"));
  const pad = (payload) => emit("pad", payload);
  const step = (dir) => pad({ kind: "nav", source: "dpad", dir });
  // Each step gives the page a moment to draw it.
  const frame = () => new Promise((r) => setTimeout(r, 20));
  let reaching = -1;
  async function reach(want) {
    for (let i = 0, stuck = 0; i < 40 && stuck < 2; i++) {
      const at = focusedAt();
      if (at < 0 || at === want) return at === want;
      const list = items();
      const a = list[at].getBoundingClientRect();
      const b = list[want].getBoundingClientRect();
      const dx = b.left + b.width / 2 - (a.left + a.width / 2);
      const dy = b.top + b.height / 2 - (a.top + a.height / 2);
      // Along a row first: up and down mean the volume in some of the pages.
      const across = Math.abs(dx) > Math.max(a.width, b.width) / 2 || Math.abs(dy) < Math.min(a.height, b.height) / 2;
      const dirs = across ? [dx > 0 ? "right" : "left", dy > 0 ? "down" : "up"] : [dy > 0 ? "down" : "up", dx > 0 ? "right" : "left"];
      step(dirs[stuck ? 1 : 0]);
      await frame();
      if (reaching !== want) return false; // the mouse moved on
      stuck = focusedAt() === at ? stuck + 1 : 0;
    }
    return focusedAt() === want;
  }
  // The value under the pointer, or the nearest one when it falls between two.
  function optionAt(ev) {
    const hit = ev.target.closest?.(".choice > span, .swatch");
    if (hit) return hit;
    const group = ev.target.closest?.(".choice, .swatches");
    if (!group) return null;
    const mid = (e) => e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2;
    return [...group.children].sort((a, b) => Math.abs(mid(a) - ev.clientX) - Math.abs(mid(b) - ev.clientX))[0] ?? null;
  }
  async function pick(row, option, x) {
    // The option is known by its place in its group (the row is drawn again on every step).
    const group = option?.parentElement.className;
    const index = option ? [...option.parentElement.children].indexOf(option) : -1;
    for (let i = 0; i < 40; i++) {
      const el = items()[row];
      let dir;
      if (option) {
        const at = [...el.querySelector(`.${group}`).children].findIndex((o) => o.classList.contains("sel"));
        if (at === index) return;
        dir = index > at ? "right" : "left";
      } else {
        const knob = el.querySelector(".knob").getBoundingClientRect();
        const centre = knob.left + knob.width / 2;
        if (Math.abs(centre - x) < knob.width / 2) return;
        dir = x > centre ? "right" : "left";
      }
      const before = el.innerHTML;
      step(dir);
      // Spaced like separate presses: held steps rest on a slider's usual levels.
      await new Promise((r) => setTimeout(r, 180));
      if (items()[row]?.innerHTML === before) return; // at an end
    }
  }
  const target = (ev) => {
    const el = ITEMS && ev.target.closest?.(ITEMS);
    return el ? items().indexOf(el) : -1;
  };
  // Hovering and clicking share one walk to an item, so two never step at once.
  let walk = null;
  function go(want) {
    if (want !== reaching || !walk) {
      reaching = want;
      walk = reach(want).finally(() => {
        if (reaching === want) walk = null;
      });
    }
    return walk;
  }
  addEventListener("pointerover", (ev) => {
    const want = target(ev);
    if (want >= 0 && want !== focusedAt()) go(want);
  });
  // On press, not on click: the page redraws what was pressed as the focus
  // arrives, and a click would land on whatever is there by the release.
  addEventListener("pointerdown", async (ev) => {
    if (ev.button !== 0) return;
    // The home screen's tabs: LB / RB until that one shows.
    const tab = ev.target.closest?.(".tab");
    if (tab) {
      const tabs = [...document.querySelectorAll(".tab")];
      const from = tabs.findIndex((t) => t.classList.contains("active"));
      const to = tabs.indexOf(tab);
      for (let i = 0; i < Math.abs(to - from); i++) pad({ kind: "press", button: to > from ? "rb" : "lb" });
      return;
    }
    const want = target(ev);
    if (want < 0 || !(await go(want))) return;
    // One of a row's values (a colour, a shape, a point on a slider): left /
    // right until it is the chosen one.
    const option = optionAt(ev);
    const track = ev.target.closest?.(".range");
    if (option || track) return pick(want, option, track && ev.clientX);
    pad({ kind: "press", button: "a" });
    pad({ kind: "release", button: "a" });
  });

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        const run = commands[cmd];
        return run ? run(args) : true;
      },
    },
    event: { listen, emit: async () => {} },
    webviewWindow: { getCurrentWebviewWindow: () => ({ listen, label: page }) },
  };
  // The page is ready once its scripts ran: say so, and start in its mode.
  addEventListener("load", () => {
    emit("mode", page);
    if (page === "guide") emit("windows", null);
    up({ type: "ready" });
  });
})();
