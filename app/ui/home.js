// Home screen: games, pinned apps and music, driven by controller events
// from the engine ("pad"). Every tab has the same look: a full background,
// information on the left and a row of tiles at the bottom. The user's
// background (an animation, a video or a picture) is always there and the
// focused game's art fades in over it on the games tab; music fills the
// screen with the cover and its colour. LB / RB switch tabs, A opens, X plays
// or pauses the music, up / down change the volume and Y mutes it, B goes
// back or closes; holding Menu closes too (engine).

const { invoke } = window.__TAURI__.core;
// Only events sent to this window or to every window: the keyboard and the
// home screen each get their own controller events.
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
const listen = here.listen.bind(here);
// Controller events count only while the home screen is the active mode.
let active = false;

const TABS = ["games", "apps", "music"];
// Served by the app (see home.rs); overridable for the dev harness.
const ASSET = window.__ASSET ?? "http://cui.localhost";
const CLOCK_EVERY_MS = 15000;
const EDIT = "__edit";
const WALL = "__wall";
// Background id for the plain colour.
const NO_WALL = "none";
const KINDS = { animated: "Animado", video: "Video", image: "Imagen" };
// Wait before loading the focused background, so moving through the grid
// does not start a video on every step.
const PREVIEW_DELAY_MS = 350;
// How long a game keeps the focus before its trailer starts.
const TRAILER_DELAY_MS = 2000;
const CONTROLS = ["prev", "toggle", "next"];
const SOURCES = { steam: "Steam", epic: "Epic Games" };

const state = {
  tab: "games",
  games: [],
  apps: [],
  pinned: [],
  focus: { games: 0, apps: 0, music: 1, edit: 0, wall: 0, folder: 0 },
  // A grid over the apps tab instead of the row: "edit" (pinned apps),
  // "wall" (background) or "folder" (adding a folder of backgrounds); ""
  // when closed.
  sheet: "",
  // The folder being browsed and the folders already added.
  folder: null,
  folders: [],
  engine: false,
  // The chosen background (null = plain colour) and every one available.
  wallpaper: null,
  walls: [],
  gameArt: true,
  media: { title: "", artist: "", playing: false, source: "", cover: 0, position_ms: 0, duration_ms: 0, sampled_ms: 0 },
  volume: { level: 0, muted: false },
};

// Friendly names for the players Windows reports.
const PLAYERS = { "spotify.exe": "Spotify", spotify: "Spotify", chrome: "Google Chrome", msedge: "Microsoft Edge", firefox: "Firefox", brave: "Brave" };
const VOLUME_STEP = 0.05;
const VOLUME_TOAST_MS = 1500;

const view = document.getElementById("view");
const player = document.getElementById("player");
const stageCover = document.getElementById("stage-cover");
const heroes = [...document.querySelectorAll(".hero")];
const wallVideo = document.querySelector("video.wall");
const wallImage = document.querySelector("img.wall");
const wallCanvas = document.querySelector("canvas.wall");
const trailer = document.querySelector("video.trailer");
// The game whose trailer may play, once it has kept the focus long enough.
let trailerFor = null;
let trailerTimer = null;
const wallLayers = [wallCanvas, wallVideo, wallImage];
const previews = new Map();
let wallId = null;
let wallTimer = null;
let heroShown = 0;
let heroUrl = "";

const art = (game, kind) => `${ASSET}/art/${encodeURIComponent(game.id)}/${kind}`;
const appIcon = (id) => `${ASSET}/icon/${encodeURIComponent(id)}`;
const cover = () => `${ASSET}/cover?r=${state.media.cover}`;
const wallFile = (w) => `${ASSET}/wallpaper/${encodeURIComponent(w.id)}`;
// Animations draw their own still frame; files have one served by the app.
function wallPreview(w) {
  if (w.kind !== "animated") return `${ASSET}/wallpaper-preview/${encodeURIComponent(w.id)}`;
  if (!previews.has(w.id)) previews.set(w.id, Backgrounds.preview(w.id));
  return previews.get(w.id);
}
const appById = (id) => state.apps.find((a) => a.id === id);

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(Boolean));
  return e;
}

// Images fade in only once loaded; a failed one disappears.
function img(src, className) {
  const i = el("img", { alt: "", className, decoding: "async" });
  i.addEventListener("load", () => i.classList.add("loaded"));
  i.addEventListener("error", () => i.remove());
  i.src = src;
  return i;
}

function svg(name, cls = "icon") {
  return el("span", { innerHTML: icon(name, cls), style: "display:contents" });
}

function glyph(text) {
  return el("span", { className: "glyph", textContent: text });
}

// ---------- background ----------

function setHero(url) {
  if (url === heroUrl) return;
  heroUrl = url;
  if (!url) {
    heroes.forEach((h) => h.classList.remove("shown"));
    return syncMotion();
  }
  const next = heroes[1 - heroShown];
  next.onload = () => {
    if (heroUrl !== url) return; // another game was chosen meanwhile
    next.classList.add("shown");
    heroes[heroShown].classList.remove("shown");
    heroShown = 1 - heroShown;
    syncMotion();
  };
  next.src = url;
}

// The user's background: one of the app's animations, a looping silent video
// or a picture, faded in once ready. `delay` waits a moment first (previews
// while moving in the grid).
function setWall(w, delay = 0) {
  const id = w?.id ?? null;
  clearTimeout(wallTimer);
  if (id === wallId) return;
  const show = () => {
    wallId = id;
    const next = w && { animated: wallCanvas, video: wallVideo, image: wallImage }[w.kind];
    const ready = () => {
      if (wallId !== id) return; // another background was chosen meanwhile
      wallLayers.forEach((l) => l.classList.toggle("shown", l === next));
      syncMotion();
    };
    if (!next) return ready();
    if (w.kind === "animated") {
      wallCanvas.dataset.id = id;
      ready();
    } else if (w.kind === "video") {
      next.addEventListener("canplay", ready, { once: true });
      next.src = wallFile(w);
    } else {
      next.onload = ready;
      next.src = wallFile(w);
    }
  };
  if (delay) wallTimer = setTimeout(show, delay);
  else show();
}

// A game's silent trailer fades in over its art after it keeps the focus for
// a moment; it is downloaded once the first time.
function setTrailer(gameId) {
  if (gameId === trailerFor) return;
  trailerFor = gameId;
  clearTimeout(trailerTimer);
  trailer.classList.remove("shown");
  if (!gameId) return syncMotion();
  trailerTimer = setTimeout(async () => {
    if (await invoke("game_trailer", { id: gameId }).catch(() => false)) playTrailer(gameId);
  }, TRAILER_DELAY_MS);
}

function playTrailer(gameId) {
  if (trailerFor !== gameId) return;
  trailer.addEventListener("canplay", () => {
    if (trailerFor !== gameId) return;
    trailer.classList.add("shown");
    syncMotion();
  }, { once: true });
  trailer.src = `${ASSET}/trailer/${encodeURIComponent(gameId)}`;
}

listen("trailer", ({ payload }) => playTrailer(payload));

// Videos and animations run only while they can be seen (not under a game's
// art, the music cover or with the home screen closed).
function syncMotion() {
  const stage = document.body.classList.contains("music-stage");
  if (active && !stage && trailer.classList.contains("shown")) trailer.play().catch(() => {});
  else if (!trailer.paused) trailer.pause();
  const covered = stage || heroes.some((h) => h.classList.contains("shown"));
  const visible = (layer) => active && layer.classList.contains("shown") && !covered;
  if (visible(wallVideo) && wallVideo.paused) wallVideo.play().catch(() => {});
  else if (!visible(wallVideo) && !wallVideo.paused) wallVideo.pause();
  const id = wallCanvas.dataset.id;
  if (visible(wallCanvas) && Backgrounds.running() !== id) Backgrounds.start(id, wallCanvas);
  else if (!visible(wallCanvas)) Backgrounds.stop();
}

// The cover's two main colours (the most colourful one and the next most
// colourful one that is clearly different), darkened for ivory text on top.
function coverTones(image) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, 32, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;
  // Group pixels into coarse colours and score each group.
  const groups = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    const e = groups.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    Object.assign(e, { n: e.n + 1, r: e.r + r, g: e.g + g, b: e.b + b });
    groups.set(key, e);
  }
  const colours = [...groups.values()].map((e) => {
    const rgb = [e.r / e.n, e.g / e.n, e.b / e.n];
    const max = Math.max(...rgb);
    const sat = max ? (max - Math.min(...rgb)) / max : 0;
    return { rgb, n: e.n, vivid: sat * (1 - Math.abs(max - 150) / 150) };
  });
  const first = colours.reduce((a, b) => (b.vivid * Math.sqrt(b.n) > a.vivid * Math.sqrt(a.n) ? b : a), { rgb: [40, 42, 48], n: 0, vivid: -1 });
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const others = colours.filter((x) => distance(x.rgb, first.rgb) > 70);
  const second = others.reduce((a, b) => (b.vivid * Math.sqrt(b.n) > a.vivid * Math.sqrt(a.n) ? b : a), others[0] ?? first);
  const dark = (rgb, level) => {
    const k = level / Math.max(...rgb, 1);
    return `rgb(${rgb.map((v) => Math.round(v * k)).join(",")})`;
  };
  return [dark(first.rgb, 70), dark(second.rgb, 52)];
}

// Music tab with something playing: the cover big on the right over its own colour.
// Some players send the cover as a card: the art on a transparent or plain
// background with the player's logo below it. Only the square art is kept,
// without its soft edge.
function trimCard(image) {
  const [w, h] = [image.naturalWidth, image.naturalHeight];
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const bg = [px[0], px[1], px[2], px[3]];
  const art = (x, y) => {
    const i = (y * w + x) * 4;
    if (px[i + 3] < 20) return false;
    if (bg[3] < 20) return true;
    return Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 48;
  };
  let top = -1;
  for (let y = 0; y < h && top < 0; y++) {
    let n = 0;
    for (let x = 0; x < w; x += 2) n += art(x, y);
    if (n > w * 0.15) top = y;
  }
  if (top < 0) return null;
  const row = Math.min(h - 1, top + Math.round(h / 4));
  let left = 0;
  let right = w - 1;
  while (left < w && !art(left, row)) left++;
  while (right > left && !art(right, row)) right--;
  let size = right - left + 1;
  // Already just the art.
  if (size >= w - 2 && top + size >= h - 2) return null;
  if (size < w * 0.5 || top + size > h) return null;
  // The card's edge is a soft (half transparent) line: leave it out.
  const edge = Math.max(1, Math.round(size / 100));
  const [x0, y0] = [left + edge, top + edge];
  size -= edge * 2;
  const out = Object.assign(document.createElement("canvas"), { width: size, height: size });
  out.getContext("2d").drawImage(c, x0, y0, size, size, 0, 0, size, size);
  return out.toDataURL("image/png");
}

// The current cover, trimmed; "" while it is being prepared.
const coverArt = { rev: -1, url: "" };
function coverUrl() {
  const rev = state.media.cover;
  if (coverArt.rev === rev) return coverArt.url;
  Object.assign(coverArt, { rev, url: "" });
  const raw = new Image();
  raw.crossOrigin = "anonymous";
  raw.onload = () => {
    if (coverArt.rev !== rev) return;
    try {
      coverArt.url = trimCard(raw) ?? raw.src;
    } catch {
      coverArt.url = raw.src;
    }
    render();
  };
  raw.src = cover();
  return "";
}

function setStage(on) {
  document.body.classList.toggle("music-stage", on);
  if (!on) return;
  const src = coverUrl();
  if (!src || stageCover.dataset.src === src) return;
  stageCover.dataset.src = src;
  stageCover.classList.remove("loaded");
  stageCover.crossOrigin = "anonymous";
  stageCover.onload = () => {
    stageCover.classList.add("loaded");
    try {
      const [a, b] = coverTones(stageCover);
      document.body.style.setProperty("--stage", a);
      document.body.style.setProperty("--stage-2", b);
    } catch {
      document.body.style.removeProperty("--stage");
      document.body.style.removeProperty("--stage-2");
    }
  };
  stageCover.src = src;
}

function playedAgo(secs) {
  if (!secs) return "";
  const m = Math.floor((Date.now() / 1000 - secs) / 60);
  if (m < 2) return "Jugado hace un momento";
  if (m < 60) return `Jugado hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Jugado hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return d === 1 ? "Jugado ayer" : `Jugado hace ${d} días`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `Jugado hace ${mo} ${mo === 1 ? "mes" : "meses"}` : "Jugado hace más de un año";
}

// ---------- what each tab shows ----------
// A tab is a list of items; each item draws its tile and the information
// shown on the left while it has the focus.

function gameItems() {
  return state.games.map((g) => ({
    key: g.id,
    tile: () =>
      el("div", { className: "tile" }, g.art.includes("header") ? img(art(g, "header"), "art") : el("span", { className: "name", textContent: g.name })),
    info: () => ({
      lead: g.art.includes("logo") ? el("img", { className: "logo", src: art(g, "logo"), alt: g.name }) : null,
      title: g.name,
      meta: [playedAgo(g.last_played), SOURCES[g.source]].filter(Boolean).join(" · "),
      action: ["Jugar", "A"],
    }),
    select: () => open(g.id),
  }));
}

function appTile(app, extra) {
  return el("div", { className: "tile" }, img(appIcon(app.id), "tile-icon"), el("span", { className: "name", textContent: app.name }), extra);
}

function appItems() {
  const pinned = state.pinned.map(appById).filter(Boolean).map((app) => ({
    key: app.id,
    tile: () => appTile(app),
    info: () => ({ lead: img(appIcon(app.id), "lead-icon"), title: app.name, meta: "", action: ["Abrir", "A"] }),
    select: () => open(app.id),
  }));
  const edit = {
    key: EDIT,
    tile: () => el("div", { className: "tile" }, svg("edit", "icon symbol"), el("span", { className: "name", textContent: "Editar" })),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("edit")), title: "Editar apps", meta: "", action: ["Editar", "A"] }),
    select: () => {
      state.sheet = "edit";
      state.focus.edit = 0;
      render();
    },
  };
  const wall = {
    key: WALL,
    tile: () => el("div", { className: "tile" }, svg("photo", "icon symbol"), el("span", { className: "name", textContent: "Fondo" })),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("photo")), title: "Fondo", meta: state.wallpaper?.title ?? "", action: ["Cambiar", "A"] }),
    select: openWalls,
  };
  return [...pinned, edit, wall];
}

function playerName(source) {
  const key = source.toLowerCase();
  return PLAYERS[key] ?? appById(source)?.name ?? Object.entries(PLAYERS).find(([k]) => key.includes(k))?.[1] ?? "";
}

function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Where the track is now: the player's last report plus the time since.
function position() {
  const m = state.media;
  const p = m.position_ms + (m.playing && m.sampled_ms ? Date.now() - m.sampled_ms : 0);
  return Math.min(p, m.duration_ms || p);
}

function volumeEl() {
  const v = state.volume;
  return el("div", { className: "volume" },
    svg(v.muted ? "mute" : "volume"),
    el("div", { className: "bar" }, el("div", { className: "fill", style: `width:${v.muted ? 0 : Math.round(v.level * 100)}%` })));
}

// The music tab is a player: what plays on the left, like every tab, and one
// bar where the other tabs have their row: transport buttons, progress and
// volume side by side. The cover fills the right side over its own colour.
function renderMusic() {
  const m = state.media;
  if (!m.title) {
    view.replaceChildren(infoEl({ lead: el("div", { className: "lead-symbol" }, svg("music")), title: "Nada sonando", meta: "Pon música en Spotify, el navegador u otra app y se controla desde aquí.", action: ["Abrir Spotify", "A"] }));
    return;
  }
  const key = [m.title, m.artist, m.playing, m.duration_ms > 0, state.focus.music].join("|");
  const current = view.querySelector(".player");
  if (current && current.dataset.key === key) return updateMusic();
  const buttons = CONTROLS.map((c, k) => {
    const name = c === "toggle" ? (m.playing ? "pause" : "play") : c;
    return el("div", { className: "transport-button" + (c === "toggle" ? " main" : "") + (k === state.focus.music ? " on" : ""), innerHTML: icon(name) });
  });
  const progress = m.duration_ms
    ? el("div", { className: "progress" }, el("span", { className: "time now" }), el("div", { className: "bar" }, el("div", { className: "fill" })), el("span", { className: "time", textContent: clock(m.duration_ms) }))
    : null;
  const info = infoEl({ lead: el("p", { className: "source", textContent: playerName(m.source) }), title: m.title, meta: m.artist });
  const bar = el("div", { className: "player-bar" }, el("div", { className: "transport" }, ...buttons), progress ?? el("div", { className: "progress" }), volumeEl());
  const player = el("div", { className: "player" }, info, bar);
  player.dataset.key = key;
  view.replaceChildren(player);
  updateMusic();
}

// Moves the progress bar and refreshes the volume without rebuilding.
function updateMusic() {
  const m = state.media;
  const now = view.querySelector(".player .time.now");
  if (now && m.duration_ms) {
    const p = position();
    now.textContent = clock(p);
    view.querySelector(".progress .fill").style.width = `${(p / m.duration_ms) * 100}%`;
  }
  const vol = view.querySelector(".player .volume");
  if (vol) vol.replaceWith(volumeEl());
}

function editItems() {
  return state.apps.map((app) => ({
    key: app.id + (state.pinned.includes(app.id) ? "+" : ""),
    tile: () => appTile(app, state.pinned.includes(app.id) ? el("span", { className: "badge", innerHTML: icon("check") }) : null),
    select: () => togglePin(app.id),
  }));
}

function badge() {
  return el("span", { className: "badge", innerHTML: icon("check") });
}

function symbolTile(name, label, on) {
  return el("div", { className: "tile" }, svg(name, "icon symbol"), el("span", { className: "name", textContent: label }), on ? badge() : null);
}

// The background grid: game art on or off, ways to add more, no background,
// then every background. Moving over one shows it behind the grid; A keeps it.
function wallItems() {
  const current = state.wallpaper?.id ?? null;
  const addFolder = {
    key: "add-folder",
    tile: () => symbolTile("folder-plus", "Agregar carpeta"),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("folder-plus")), title: "Agregar carpeta", meta: "", action: ["Elegir", "A"] }),
    select: () => openFolder(null),
  };
  const workshop = state.engine && {
    key: "workshop",
    tile: () => symbolTile("download", "Conseguir más"),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("download")), title: "Conseguir más", meta: "Workshop de Wallpaper Engine", action: ["Abrir", "A"] }),
    select: openWorkshop,
  };
  const gameArt = {
    key: "art" + state.gameArt,
    tile: () => symbolTile("gamepad", "Arte de los juegos", state.gameArt),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("gamepad")), title: "Arte de los juegos", meta: "", action: [state.gameArt ? "Ocultar" : "Mostrar", "A"] }),
    select: toggleGameArt,
  };
  const none = {
    key: "none" + (current === null),
    wall: null,
    tile: () => symbolTile("photo-off", "Sin fondo", current === null),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("photo-off")), title: "Sin fondo", meta: "", action: ["Usar", "A", current === null] }),
    select: () => chooseWall(null),
  };
  const walls = state.walls.map((w) => ({
    key: w.id + (w.id === current ? "+" : ""),
    wall: w,
    tile: () => el("div", { className: "tile" }, img(wallPreview(w), "art"), w.id === current ? badge() : null),
    info: () => ({ lead: null, title: w.title, meta: [w.origin, KINDS[w.kind]].join(" · "), action: ["Usar", "A", w.id === current] }),
    select: () => chooseWall(w),
  }));
  return [gameArt, addFolder, workshop, none, ...walls].filter(Boolean);
}

// Choosing a folder with the controller: A opens a folder, B goes up, the
// first tile adds (or removes) the folder being shown.
function folderItems() {
  const f = state.folder;
  if (!f) return [];
  const name = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  const added = f.path && state.folders.some((p) => p.toLowerCase() === f.path.toLowerCase());
  const media = (n) => (n ? `${n} ${n === 1 ? "video o imagen" : "videos e imágenes"}` : "");
  const here = f.path && {
    key: "here" + added,
    tile: () => symbolTile(added ? "folder-minus" : "folder-plus", added ? "Quitar esta carpeta" : "Agregar esta carpeta"),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("folder")), title: name(f.path), meta: media(f.media), action: [added ? "Quitar" : "Agregar", "A"] }),
    select: () => (added ? removeFolder(f.path) : addFolder(f.path)),
  };
  const subs = f.folders.map((d) => ({
    key: d.path,
    tile: () => symbolTile("folder", d.name),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("folder")), title: d.name, meta: media(d.media), action: ["Abrir", "A"] }),
    select: () => openFolder(d.path),
  }));
  return [here, ...subs].filter(Boolean);
}

function items() {
  if (state.sheet === "edit") return editItems();
  if (state.sheet === "wall") return wallItems();
  if (state.sheet === "folder") return folderItems();
  return { games: gameItems, apps: appItems }[state.tab]();
}

function focusKey() {
  return state.sheet || state.tab;
}

// ---------- render ----------

function infoEl(i) {
  // A third value keeps the button's place without showing it, so the grid
  // below does not move while browsing.
  const action = i.action && el("div", { className: "action", style: i.action[2] ? "visibility:hidden" : "" }, el("span", { textContent: i.action[0] }), glyph(i.action[1]));
  return el("section", { className: "info" },
    el("div", { className: "lead" }, i.lead),
    el("h1", { className: "title", textContent: i.title }),
    el("p", { className: "meta", textContent: i.meta }),
    action);
}

function render() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));

  paintBackground();
  setStage(state.tab === "music" && !state.sheet && !!state.media.title && !!state.media.cover);
  syncMotion();

  if (state.tab === "music" && !state.sheet) {
    renderMusic();
    renderPlayer();
    return;
  }
  const list = items();
  const fk = focusKey();
  state.focus[fk] = Math.max(0, Math.min(state.focus[fk], list.length - 1));
  const at = state.focus[fk];

  if (!list.length && state.tab === "games") {
    view.replaceChildren(infoEl({ lead: el("div", { className: "lead-symbol" }, svg("gamepad")), title: "Tus juegos aparecen aquí", meta: "Los juegos instalados con Steam o Epic Games se agregan solos." }));
    renderPlayer();
    return;
  }

  // Only what changed is rebuilt, so tiles never reload while moving.
  const key = `${state.tab}|${state.sheet}|` + list.map((x) => x.key).join("|");
  let strip = view.querySelector(".row, .grid");
  const editing = state.sheet === "edit";
  const headFor = () => {
    const head = editing
      ? infoEl({ lead: el("div", { className: "lead-symbol" }, svg("edit")), title: "Editar apps", meta: "", action: [state.pinned.includes(state.apps[at]?.id) ? "Quitar" : "Fijar", "A"] })
      : infoEl(list[at].info());
    head.dataset.item = editing ? "edit" : list[at].key + "|" + state.media.title + "|" + state.media.artist;
    return head;
  };
  if (!strip || strip.dataset.key !== key) {
    strip = el("div", { className: state.sheet ? "grid" : "row" });
    strip.dataset.key = key;
    list.forEach((item) => strip.append(item.tile()));
    view.replaceChildren(headFor(), strip);
  } else if (editing) {
    const label = view.querySelector(".info .action span");
    if (label) label.textContent = state.pinned.includes(state.apps[at]?.id) ? "Quitar" : "Fijar";
  } else {
    const head = headFor();
    if (view.querySelector(".info").dataset.item !== head.dataset.item) view.querySelector(".info").replaceWith(head);
  }
  [...strip.children].forEach((t, k) => t.classList.toggle("on", k === at));
  strip.children[at]?.scrollIntoView({ inline: "nearest", block: "nearest" });
  renderPlayer();
}

// The user's background is the base and on the games tab the focused game's
// art covers it. With the plain background, the art also stays behind the
// apps. In the background grid, the focused one is shown.
function paintBackground() {
  if (state.sheet === "wall") {
    const item = wallItems()[state.focus.wall];
    setWall(item && "wall" in item ? item.wall : state.wallpaper, PREVIEW_DELAY_MS);
    setHero("");
    setTrailer(null);
    return;
  }
  setWall(state.wallpaper);
  const g = state.games[Math.min(state.focus.games, state.games.length - 1)];
  const onGames = state.tab === "games" || (state.tab === "apps" && !state.wallpaper);
  setHero(state.gameArt && onGames && g && g.art.includes("hero") ? art(g, "hero") : "");
  setTrailer(state.gameArt && state.tab === "games" && !state.sheet && g ? g.id : null);
}

function renderPlayer() {
  const m = state.media;
  player.hidden = !m.title || state.tab === "music";
  if (player.hidden) return;
  const src = m.cover ? coverUrl() : "";
  const art = src ? el("img", { className: "art", src, alt: "" }) : el("span", { className: "art" });
  const text = el("div", { className: "text" }, el("b", { textContent: m.title }), el("span", { textContent: m.artist ? ` · ${m.artist}` : "" }));
  player.replaceChildren(art, text, el("div", { className: "state" }, svg(m.playing ? "pause" : "play")));
}

// ---------- navigation ----------

// Columns of the edit grid as laid out right now.
function columns(grid) {
  const tiles = [...grid.children];
  const top = tiles[0]?.offsetTop;
  const n = tiles.findIndex((t) => t.offsetTop !== top);
  return n === -1 ? Math.max(tiles.length, 1) : n;
}

function onNav(dir) {
  // Up / down outside the app grid change the volume.
  if (!state.sheet && (dir === "up" || dir === "down")) {
    changeVolume(invoke("volume_step", { delta: dir === "up" ? VOLUME_STEP : -VOLUME_STEP }));
    return;
  }
  if (state.tab === "music" && !state.sheet) {
    state.focus.music = Math.max(0, Math.min(CONTROLS.length - 1, state.focus.music + (dir === "left" ? -1 : 1)));
    render();
    return;
  }
  const fk = focusKey();
  const count = items().length;
  let step = { left: -1, right: 1 }[dir] ?? 0;
  if (state.sheet && (dir === "up" || dir === "down")) {
    const cols = columns(view.querySelector(".grid"));
    step = dir === "up" ? -cols : cols;
  }
  const next = state.focus[fk] + step;
  if (step && next >= 0 && next < count) {
    state.focus[fk] = next;
    render();
  }
}

function switchTab(delta) {
  if (state.sheet) return;
  state.tab = TABS[(TABS.indexOf(state.tab) + delta + TABS.length) % TABS.length];
  render();
}

async function open(id) {
  try {
    const isGame = await invoke("launch", { id });
    await invoke("set_mode", { mode: isGame ? "off" : "cursor" });
  } catch (e) {
    console.error(e);
  }
}

async function togglePin(id) {
  state.pinned = state.pinned.includes(id) ? state.pinned.filter((p) => p !== id) : [...state.pinned, id];
  render();
  await invoke("set_pinned", { ids: state.pinned });
}

async function openWalls() {
  try {
    const data = await invoke("wallpapers");
    state.walls = data.items;
    state.wallpaper = data.items.find((w) => w.id === data.current) ?? null;
    state.engine = data.engine;
    state.folders = data.folders;
  } catch (e) {
    return console.error(e);
  }
  state.sheet = "wall";
  // Start on the background in use.
  const at = wallItems().findIndex((x) => "wall" in x && (x.wall?.id ?? null) === (state.wallpaper?.id ?? null));
  state.focus.wall = Math.max(0, at);
  render();
}

async function chooseWall(w) {
  const before = state.wallpaper;
  state.wallpaper = w;
  render();
  try {
    await invoke("set_wallpaper", { id: w?.id ?? NO_WALL });
  } catch (e) {
    console.error(e);
    state.wallpaper = before;
    render();
  }
}

async function toggleGameArt() {
  state.gameArt = !state.gameArt;
  render();
  await invoke("set_game_art", { on: state.gameArt }).catch(console.error);
}

// Spotify's web player in its own window, driven with the cursor.
async function openSpotify() {
  try {
    await invoke("open_spotify");
    await invoke("set_mode", { mode: "cursor" });
  } catch (e) {
    console.error(e);
  }
}

async function openWorkshop() {
  try {
    await invoke("open_workshop");
    await invoke("set_mode", { mode: "cursor" });
  } catch (e) {
    console.error(e);
  }
}

// `path` null = the drives.
async function openFolder(path) {
  try {
    state.folder = await invoke("browse_folders", { path });
  } catch (e) {
    return console.error(e);
  }
  state.sheet = "folder";
  state.focus.folder = 0;
  render();
}

async function addFolder(path) {
  try {
    await invoke("add_wallpaper_folder", { path });
  } catch (e) {
    return console.error(e);
  }
  await openWalls();
}

async function removeFolder(path) {
  try {
    await invoke("remove_wallpaper_folder", { path });
    state.folders = state.folders.filter((p) => p.toLowerCase() !== path.toLowerCase());
  } catch (e) {
    return console.error(e);
  }
  render();
}

function back() {
  if (state.sheet === "folder") {
    // Up one folder; from the drives, back to the backgrounds.
    if (state.folder?.path) openFolder(state.folder.parent ?? null);
    else openWalls();
    return;
  }
  if (state.sheet) {
    state.sheet = "";
    render();
    return;
  }
  invoke("set_mode", { mode: "cursor" });
}

// Shows the new level: in the player on the music tab, as a toast elsewhere.
let toastTimer = null;
async function changeVolume(request) {
  try {
    state.volume = await request;
  } catch (e) {
    return console.error(e);
  }
  if (state.tab === "music" && !state.sheet && state.media.title) return updateMusic();
  const toast = document.getElementById("volume-toast");
  toast.replaceChildren(...volumeEl().childNodes);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), VOLUME_TOAST_MS);
}

function onPress(button) {
  switch (button) {
    case "a":
      if (state.tab === "music" && !state.sheet) {
        if (state.media.title) invoke("media_control", { action: CONTROLS[state.focus.music] });
        else openSpotify();
      } else items()[state.focus[focusKey()]]?.select();
      break;
    case "y":
      changeVolume(invoke("volume_mute"));
      break;
    case "b":
      back();
      break;
    case "x":
      if (state.media.title) invoke("media_control", { action: "toggle" });
      break;
    case "lb":
      switchTab(-1);
      break;
    case "rb":
      switchTab(1);
      break;
  }
}

listen("pad", ({ payload }) => {
  if (!active) return;
  if (payload.kind === "nav" && payload.source !== "right") onNav(payload.dir);
  else if (payload.kind === "press") onPress(payload.button);
});

// ---------- data ----------

async function load() {
  const data = await invoke("home_data");
  state.games = data.games;
  state.apps = data.apps;
  state.pinned = data.pinned;
  state.wallpaper = data.wallpaper;
  state.gameArt = data.game_art;
  render();
}

listen("library", load);
listen("media", ({ payload }) => {
  state.media = payload;
  render();
});
listen("mode", ({ payload }) => {
  active = payload === "home";
  syncMotion();
  if (payload !== "home") return;
  state.sheet = "";
  state.focus.games = 0;
  load();
  invoke("volume_get").then((v) => (state.volume = v));
});

// The progress bar moves on its own between the player's reports.
setInterval(() => {
  if (state.tab === "music" && state.media.playing) updateMusic();
}, 500);

function tick() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}
tick();
setInterval(tick, CLOCK_EVERY_MS);

invoke("current_mode").then((m) => (active = m === "home"));
invoke("volume_get").then((v) => (state.volume = v));
invoke("media_now").then((m) => {
  state.media = m;
  render();
});
load();
