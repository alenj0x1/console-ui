// Home screen: games, pinned apps and media, driven by controller events
// from the engine ("pad"). Every tab has the same look: a full background,
// information on the left and a row of tiles at the bottom. The user's
// background (an animation, a video or a picture) is always there and the
// focused game's art fades in over it on the games tab; on the media tab,
// what is playing fills the screen with its cover and colour. LB / RB switch
// tabs, A opens, X plays or pauses, LT / RT change the song, up / down change
// the volume and Y mutes it, B goes back or closes; holding Menu closes too
// (engine).

const { invoke } = window.__TAURI__.core;
// Only events sent to this window or to every window: the keyboard and the
// home screen each get their own controller events.
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
const listen = here.listen.bind(here);
// Controller events count only while the home screen is the active mode.
let active = false;

const TABS = ["games", "apps", "media", "settings"];
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
// Media apps found among the installed ones.
const MEDIA_APPS = /spotify|vlc|plex|kodi|apple music|itunes|amazon music|deezer|tidal|stremio|netflix|prime video|disney/i;
const NOT_APPS = /uninstall|desinstal|readme|léame|website|sitio web|help|ayuda/i;
// Streaming sites the user can add, opened in the default browser (see
// open_service in home.rs).
const SERVICES = [
  { id: "youtube", name: "YouTube", icon: "services/youtube.png" },
  { id: "youtube-music", name: "YouTube Music", icon: "services/youtube-music.png" },
  { id: "netflix", name: "Netflix", icon: "services/netflix.svg" },
  { id: "twitch", name: "Twitch", icon: "services/twitch.svg" },
  { id: "prime-video", name: "Prime Video", icon: "services/prime-video.png" },
  { id: "disney-plus", name: "Disney+", icon: "services/disney-plus.png" },
];
const SOURCES = { steam: "Steam", epic: "Epic Games" };

const state = {
  tab: "games",
  games: [],
  apps: [],
  pinned: [],
  focus: { games: 0, apps: 0, media: 0, edit: 0, medit: 0, wall: 0, folder: 0 },
  // The media tab's apps and sites (null = the installed media apps).
  picks: null,
  // Its edit grid lists every app only once asked to.
  allApps: false,
  // The settings tab: the category list or its rows has the focus.
  // sub: a list opened from a row (the keyboard's languages), with its own focus.
  settings: { zone: "cats", cat: 0, row: 0, forget: "", sub: "", subRow: 0 },
  prefs: null,
  // A grid over the apps tab instead of the row: "edit" (pinned apps),
  // "medit" (the media tab's apps and sites),
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
  return setGlyph(el("span", { className: "glyph" }), text);
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

// The media tab's apps and sites: the user's picks, or the installed media
// apps until they choose.
function mediaPicks() {
  if (state.picks) return state.picks;
  const seen = new Set();
  return state.apps.filter((a) => MEDIA_APPS.test(a.name) && !NOT_APPS.test(a.name) && !seen.has(a.name) && seen.add(a.name)).map((a) => a.id);
}

const site = (id) => SERVICES.find((s) => `web:${s.id}` === id);
const norm = (s) => s.toLowerCase().replace(/\.exe$/, "");

// The app a player reports (Windows gives its AppUserModelID or exe name).
function sourceApp(source) {
  const s = norm(source);
  if (!s) return null;
  return state.apps.find((a) => norm(a.id) === s) ?? state.apps.find((a) => s.includes(norm(a.name)) || norm(a.id).includes(s)) ?? null;
}

// What plays shows on its own app's card: the song under the name and, while
// the card has the focus, the player on the left over the cover's colour.
function playingInfo(app) {
  const m = state.media;
  const head = infoEl({
    lead: app ? img(appIcon(app.id), "lead-icon") : el("p", { className: "source", textContent: playerName(m.source) }),
    title: m.title,
    meta: [m.artist, app?.name ?? ""].filter(Boolean).join(" · "),
    action: app ? ["Abrir", "A"] : null,
  });
  if (m.duration_ms) {
    head.querySelector(".meta").after(
      el("div", { className: "progress" }, el("span", { className: "time now" }), el("div", { className: "bar" }, el("div", { className: "fill" })), el("span", { className: "time", textContent: clock(m.duration_ms) })),
    );
  }
  const hints = el("span", { className: "hints" },
    el("span", { className: "hint" }, glyph("X"), m.playing ? "Pausar" : "Reproducir"),
    el("span", { className: "hint" }, glyph("LT RT"), "Canción"));
  (head.querySelector(".action") ?? head.querySelector(".progress") ?? head.querySelector(".meta")).after(hints);
  return head;
}

function mediaItems() {
  const m = state.media;
  const playing = m.title ? sourceApp(m.source) : null;
  const ids = mediaPicks();
  const list = ids.map((id) => {
    const s = site(id);
    if (s) {
      return {
        key: id,
        tile: () => el("div", { className: "tile" }, img(s.icon, "tile-icon"), el("span", { className: "name", textContent: s.name })),
        info: () => ({ lead: img(s.icon, "lead-icon"), title: s.name, meta: "Se abre en tu navegador", action: ["Abrir", "A"] }),
        select: () => openService(s.id),
      };
    }
    const app = appById(id);
    return app && { key: app.id, app, tile: () => appTile(app), info: () => ({ lead: img(appIcon(app.id), "lead-icon"), title: app.name, meta: "", action: ["Abrir", "A"] }), select: () => open(app.id) };
  }).filter(Boolean);
  // The player's card comes first; one that is not in the list (a browser
  // playing a video) joins while it plays.
  if (m.title) {
    let at = list.findIndex((x) => x.app && x.app === playing);
    const item = at >= 0 ? list.splice(at, 1)[0] : { key: playing?.id ?? "__player", app: playing, select: () => playing && open(playing.id) };
    item.playing = true;
    item.rev = "~"; // a new song only changes the card's text (see render)
    item.tile = () =>
      el("div", { className: "tile playing" },
        playing ? img(appIcon(playing.id), "tile-icon") : svg("music", "icon symbol"),
        el("span", { className: "name", textContent: playing?.name ?? playerName(m.source) }),
        el("span", { className: "song", textContent: m.title }));
    item.info = () => playingInfo(playing);
    list.unshift(item);
  }
  const edit = {
    key: "__medit",
    tile: () => el("div", { className: "tile" }, svg("edit", "icon symbol"), el("span", { className: "name", textContent: "Editar" })),
    info: () => ({ lead: el("div", { className: "lead-symbol" }, svg("edit")), title: "Editar Multimedia", meta: "", action: ["Editar", "A"] }),
    select: () => {
      state.sheet = "medit";
      state.focus.medit = 0;
      state.allApps = false;
      render();
    },
  };
  return [...list, edit];
}

// Adding or removing apps and sites: the sites, the media apps and the
// apps already added; "Todas las apps" opens the rest.
function mediaEditItems() {
  const picks = mediaPicks();
  const media = (a) => MEDIA_APPS.test(a.name) && !NOT_APPS.test(a.name);
  const sites = SERVICES.map((s) => ({ id: `web:${s.id}`, tile: (on) => el("div", { className: "tile" }, img(s.icon, "tile-icon"), el("span", { className: "name", textContent: s.name }), on ? badge() : null) }));
  const shown = state.apps.filter((a) => state.allApps || media(a) || picks.includes(a.id));
  const apps = shown.map((a) => ({ id: a.id, tile: (on) => appTile(a, on ? badge() : null) }));
  const list = [...sites, ...apps].map((x) => {
    const on = picks.includes(x.id);
    return { key: x.id + (on ? "+" : ""), on, tile: () => x.tile(on), select: () => toggleMedia(x.id) };
  });
  if (!state.allApps && shown.length < state.apps.length) {
    list.push({
      key: "__all",
      more: true,
      tile: () => symbolTile("apps", "Todas las apps"),
      select: () => {
        state.allApps = true;
        render();
      },
    });
  }
  return list;
}

async function toggleMedia(id) {
  const picks = mediaPicks();
  state.picks = picks.includes(id) ? picks.filter((p) => p !== id) : [...picks, id];
  render();
  await invoke("set_media", { ids: state.picks }).catch(console.error);
}

// Moves the progress bar without rebuilding.
function updateMusic() {
  const m = state.media;
  const now = view.querySelector(".info .time.now");
  if (now && m.duration_ms) {
    const p = position();
    now.textContent = clock(p);
    view.querySelector(".info .progress .fill").style.width = `${(p / m.duration_ms) * 100}%`;
  }
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

// ---------- settings ----------

// Every option here works; ids match prefs.rs.
// Language names, each in its own language.
const LANGUAGE_NAMES = { es: "Español", en: "English", pt: "Português", fr: "Français", de: "Deutsch", it: "Italiano" };
const languageName = (code) => LANGUAGE_NAMES[code] ?? code;
const ACCENT_NAMES = { blue: "Azul", violet: "Violeta", green: "Verde", amber: "Ámbar", pink: "Rosa", ivory: "Marfil" };
// Names in everyday words, each with a line that says what it changes.
const CATEGORIES = [
  {
    name: "Apariencia",
    icon: "palette",
    rows: () => [
      { kind: "swatch", name: "Color principal", pref: "accent", options: Object.keys(Prefs.ACCENTS), desc: "El color del marco que muestra dónde estás y de botones como Jugar." },
      { kind: "choice", name: "Tamaño de letra", pref: "text_size", options: [[100, "Normal"], [110, "Grande"], [120, "Muy grande"]], desc: "Agranda los textos de Inicio y de la guía para leerlos de lejos." },
      { kind: "toggle", name: "Marco de selección más grueso", pref: "thick_focus", desc: "Un borde más ancho alrededor de lo que tienes elegido, para verlo mejor desde el sillón." },
      { kind: "link", name: "Fondo", value: state.wallpaper?.title ?? "Color liso", run: openWalls, desc: "Lo que se ve detrás de Inicio, sea una animación, un video o una imagen." },
      { kind: "toggle", name: "Imágenes de los juegos", pref: "game_art", desc: "Muestra el arte del juego elegido detrás de la pestaña Juegos." },
    ],
  },
  {
    name: "Botones",
    icon: "gamepad",
    rows: () => [
      { kind: "toggle", name: "Aceptar con {B}", pref: "swap_ab", desc: "{B} acepta y {A} vuelve atrás, como en las consolas de Nintendo. Para volver a lo normal, entra aquí y presiona {B}." },
      { kind: "toggle", name: "Puntero con la palanca derecha", pref: "swap_sticks", desc: "La palanca derecha mueve el puntero y la izquierda sube o baja la página." },
      { kind: "choice", name: "Tiempo para mantener presionado", pref: "hold_time", options: [["short", "Corto"], ["normal", "Normal"], ["long", "Largo"]], desc: "Cuánto hay que sostener {Menu} para abrir Inicio, o {View} y {Menu} juntos para la guía. Un toque tiene que ser más corto que esto." },
    ],
  },
  {
    name: "Puntero",
    icon: "pointer",
    rows: () => [
      { kind: "choice", name: "Velocidad del puntero", pref: "cursor_speed", options: [["slow", "Lenta"], ["normal", "Normal"], ["fast", "Rápida"]], desc: "Qué tan rápido se mueve el puntero por la pantalla." },
      { kind: "choice", name: "Ayuda para apuntar", pref: "slowdown", options: [["off", "No"], ["soft", "Suave"], ["normal", "Normal"], ["strong", "Fuerte"]], desc: "El puntero va más lento al pasar sobre algo que se puede pulsar, para que no te pases. No frena cuando cruzas la pantalla rápido." },
      { kind: "choice", name: "Ignorar movimientos pequeños", pref: "deadzone", options: [["small", "Poco"], ["normal", "Normal"], ["large", "Mucho"]], desc: "Cuánto hay que mover la palanca para que el puntero reaccione. Súbelo si el puntero se mueve solo o si te tiembla la mano." },
      { kind: "choice", name: "Velocidad al desplazar", pref: "scroll_speed", options: [["slow", "Lenta"], ["normal", "Normal"], ["fast", "Rápida"]], desc: "Qué tan rápido sube o baja la página con la palanca que desplaza." },
      { kind: "toggle", name: "Desplazar al revés", pref: "invert_scroll", desc: "Al empujar la palanca hacia arriba, la página baja." },
    ],
  },
  {
    name: "Teclado",
    icon: "keyboard",
    rows: () => [
      { kind: "choice", name: "Forma del teclado", pref: "keyboard_layout", options: [["grid", "Todo junto"], ["split", "Dos mitades"]], desc: "Todas las teclas juntas, o partidas en dos lados para escribir con las dos manos." },
      { kind: "toggle", name: "Sugerir palabras", pref: "suggestions", desc: "Muestra palabras sobre el teclado para escribir menos y con tildes." },
      { kind: "toggle", name: "Recordar mis palabras", pref: "learn", desc: "Sugiere primero las palabras que más usas. Nunca guarda lo que escribes en contraseñas." },
      { kind: "link", name: "Idiomas del teclado", value: (state.prefs?.languages ?? []).map(languageName).join(", "), run: () => openSub("languages"), desc: "En qué idiomas sugiere palabras." },
      { kind: "action", key: "forget", name: "Borrar palabras recordadas", danger: true, run: () => twice("forget", () => invoke("forget_learned")), desc: "Olvida las palabras que el teclado aprendió de ti. Pide confirmar antes." },
    ],
  },
  {
    name: "Juegos",
    icon: "player-play",
    rows: () => [
      { kind: "toggle", name: "Dejar el control al juego que abras", pref: "auto_game", desc: "Cuando abres un juego, el control es solo del juego. Al cerrarlo, vuelve el puntero. Para usar el puntero sin cerrarlo, mantén {View} y {Menu} y elige otra ventana." },
    ],
  },
  {
    name: "General",
    icon: "settings",
    rows: () => [
      { kind: "toggle", name: "Iniciar con Windows", pref: "start_with_windows", desc: "Se abre sola y en silencio al encender la computadora." },
      { kind: "toggle", name: "Vibrar al cambiar de modo", pref: "rumble", desc: "El control vibra cuando pasa a un juego y cuando vuelve al puntero." },
      { kind: "choice", name: "Forma de este menú", pref: "settings_view", options: [["list", "Lista"], ["tiles", "Cuadros"]], desc: "Todo en una lista, o una categoría a la vez en cuadros grandes." },
      { kind: "action", key: "reset", hint: "Restablecer", name: "Dejar todo como venía", run: () => twice("reset", resetAll), desc: "Vuelve todas las opciones de Ajustes a como venían. Tus apps fijadas y tus palabras se quedan. Pide confirmar antes." },
    ],
  },
];

async function setPref(name, value) {
  const before = state.prefs?.[name];
  try {
    state.prefs = await invoke("set_preference", { name, value });
  } catch (e) {
    console.error(e);
    return render();
  }
  if (CONFIRMED.includes(name) && value === true && !confirming) askToKeep(name, before);
  render();
}

function rowControl(r) {
  const p = state.prefs ?? {};
  switch (r.kind) {
    case "toggle":
      return el("span", { className: `switch${p[r.pref] ? " on" : ""}` });
    case "check":
      return el("span", { className: `check${r.on ? " on" : ""}` }, r.on ? svg("check") : null);
    case "choice":
      return el("span", { className: "choice" }, ...r.options.map(([v, label]) => el("span", { className: v === p[r.pref] ? "sel" : "", textContent: label })));
    case "swatch":
      return el("span", { className: "swatches" }, ...r.options.map((id) => el("span", { className: `swatch${id === p[r.pref] ? " sel" : ""}`, style: `background:${Prefs.ACCENTS[id]}`, title: ACCENT_NAMES[id] })));
    case "link":
      return el("span", { className: "value" }, r.value, svg("chevron"));
    case "action": {
      const f = state.settings.forget;
      const again = withButtons(`Presiona {${Prefs.get()?.swap_ab ? "B" : "A"}} otra vez`);
      return el("span", { className: "value" }, ...(f === `${r.key}:ask` ? again : f === `${r.key}:done` ? [document.createTextNode("Listo")] : []));
    }
  }
}

// A list opened from a row: one line per language, ticked when on.
function subRows() {
  const p = state.prefs ?? {};
  return (p.available_languages ?? []).map((lang) => ({ kind: "check", name: languageName(lang), lang, on: (p.languages ?? []).includes(lang) }));
}

function settingsRows() {
  return state.settings.sub ? subRows() : CATEGORIES[state.settings.cat].rows();
}

function openSub(name) {
  const st = state.settings;
  st.back = st.row;
  st.sub = name;
  st.row = 0;
  render();
}

// The preview stage lives across renders, so its animation never restarts
// when the screen redraws; it only changes when the option or value does.
const stage = el("div", { className: "stage" }, el("canvas"));
const about = el("p", { className: "about" }, el("span", { className: "desc" }), el("span", { className: "now" }));
const card = el("section", { className: "preview-card" }, stage, about);
Previews.mount(stage.firstChild);
let shown = { id: "", value: undefined };

function showPreview(row) {
  const p = state.prefs ?? {};
  about.querySelector(".desc").replaceChildren(...withButtons(row?.desc ?? ""));
  const id = row?.pref;
  const has = !!id && Previews.has(id);
  stage.hidden = !has;
  if (!has) {
    about.querySelector(".now").replaceChildren();
    shown = { id: "", value: undefined };
    return;
  }
  const value = p[id];
  about.querySelector(".now").replaceChildren(...withButtons(Previews.caption(id, value)));
  if (shown.id === id && shown.value === value) return;
  Previews.show(id, value, shown.id === id ? shown.value : undefined);
  shown = { id, value };
}

function renderSettings() {
  const st = state.settings;
  const tiles = state.prefs?.settings_view === "tiles";
  const rows = settingsRows();
  st.row = Math.min(st.row, rows.length - 1);
  const cats = CATEGORIES.map((c, i) =>
    el("div", { className: `cat${i === st.cat ? " sel" : ""}${i === st.cat && st.zone === "cats" ? " on" : ""}` }, svg(c.icon), el("span", { textContent: c.name })),
  );
  const panel = el("section", { className: "panel" },
    st.sub ? el("div", { className: "panel-title" }, "Idiomas") : null,
    ...rows.map((r, i) =>
      el("div", { className: `setting${r.danger ? " danger" : ""}${st.zone === "rows" && i === st.row ? " on" : ""}` }, el("span", { className: "name" }, ...withButtons(r.name)), rowControl(r)),
    ),
  );
  const row = rows[st.row];
  const valued = row && (row.kind === "choice" || row.kind === "swatch");
  const hints = el("div", { className: "settings-hints" },
    st.zone === "cats" ? hintEl("A", "Abrir") : hintEl("A", row?.kind === "link" ? "Abrir" : row?.kind === "action" ? (row.hint ?? "Borrar") : "Cambiar"),
    st.zone === "rows" && valued ? hintEl("← →", "Elegir") : null,
    el("span", { className: "spacer" }),
    hintEl("B", st.zone === "rows" ? "Atrás" : "Cerrar"),
  );
  let body;
  // The row in focus, or the category's first while choosing a category.
  showPreview(st.sub ? null : rows[st.zone === "rows" ? st.row : 0]);
  if (!tiles) body = el("div", { className: "settings list" }, el("nav", { className: "cats" }, ...cats), panel, card);
  else if (st.zone === "cats") body = el("div", { className: "settings tiles" }, ...cats);
  else body = el("div", { className: "settings open" }, el("h2", { className: "cat-title" }, svg(CATEGORIES[st.cat].icon), CATEGORIES[st.cat].name), panel, card);
  view.replaceChildren(body, hints);
}

function hintEl(key, text) {
  return el("span", { className: "hint" }, glyph(key), text);
}

function settingsNav(dir) {
  const st = state.settings;
  const tiles = state.prefs?.settings_view === "tiles";
  if (st.zone === "cats") {
    const cols = tiles ? 3 : 1;
    const step = { up: -cols, down: cols, left: tiles ? -1 : 0, right: tiles ? 1 : 0 }[dir];
    if (!tiles && dir === "right") return enterRows();
    const next = st.cat + step;
    if (step && next >= 0 && next < CATEGORIES.length) {
      st.cat = next;
      st.row = 0;
      st.forget = "";
    }
    return render();
  }
  const rows = settingsRows();
  const r = rows[st.row];
  if (dir === "up" || dir === "down") {
    st.row = Math.max(0, Math.min(rows.length - 1, st.row + (dir === "up" ? -1 : 1)));
    st.forget = "";
    return render();
  }
  const d = dir === "left" ? -1 : 1;
  if (r.kind === "choice") {
    const at = r.options.findIndex(([v]) => v === state.prefs?.[r.pref]);
    const next = r.options[at + d];
    if (next) setPref(r.pref, next[0]);
  } else if (r.kind === "swatch") {
    const next = r.options[r.options.indexOf(state.prefs?.[r.pref]) + d];
    if (next) setPref(r.pref, next);
  } else if (dir === "left" && !tiles && !st.sub) {
    st.zone = "cats";
    render();
  }
}

function enterRows() {
  state.settings.zone = "rows";
  state.settings.row = 0;
  state.settings.forget = "";
  render();
}

function settingsSelect() {
  const st = state.settings;
  if (st.zone === "cats") return enterRows();
  const r = settingsRows()[st.row];
  const p = state.prefs ?? {};
  if (r.kind === "toggle") setPref(r.pref, !p[r.pref]);
  else if (r.kind === "check") {
    const langs = p.languages ?? [];
    const next = langs.includes(r.lang) ? langs.filter((l) => l !== r.lang) : [...langs, r.lang];
    if (next.length) setPref("languages", next); // at least one stays on
  } else if (r.kind === "choice") {
    const at = r.options.findIndex(([v]) => v === p[r.pref]);
    setPref(r.pref, r.options[(at + 1) % r.options.length][0]);
  } else if (r.kind === "link" || r.kind === "action") r.run();
}

// Actions that can't be undone ask for a second A first.
async function twice(key, run) {
  const st = state.settings;
  if (st.forget !== `${key}:ask`) {
    st.forget = `${key}:ask`;
    return render();
  }
  try {
    await run();
    st.forget = `${key}:done`;
  } catch (e) {
    console.error(e);
    st.forget = "";
  }
  render();
}

async function resetAll() {
  state.prefs = await invoke("reset_preferences");
  shown = { id: "", value: undefined };
}

// ---------- confirming swapped buttons ----------

// Swapping the buttons or sticks could leave someone unable to drive the
// screen: the change asks to be kept and goes back by itself if nobody does.
const CONFIRM_SECONDS = 10;
const CONFIRMED = ["swap_ab", "swap_sticks"];
let confirming = null; // { name, before, left, timer }
const confirmEl = el("div", { className: "confirm", hidden: true });
document.body.append(confirmEl);

function askToKeep(name, before) {
  clearInterval(confirming?.timer);
  confirming = { name, before, left: CONFIRM_SECONDS };
  confirming.timer = setInterval(() => {
    confirming.left -= 1;
    if (confirming.left <= 0) return keepChange(false);
    renderConfirm();
  }, 1000);
  renderConfirm();
}

function renderConfirm() {
  confirmEl.hidden = !confirming;
  if (!confirming) return;
  confirmEl.replaceChildren(
    el("div", { className: "confirm-card" },
      el("h2", { textContent: "¿Dejas los botones así?" }),
      el("p", { textContent: `Si no eliges nada, vuelven a como estaban en ${confirming.left} s.` }),
      el("div", { className: "confirm-actions" },
        el("span", { className: "action" }, el("span", { textContent: "Dejar así" }), glyph("A")),
        el("span", { className: "hint" }, glyph("B"), "Volver a como estaba"),
      ),
    ),
  );
}

async function keepChange(keep) {
  const c = confirming;
  if (!c) return;
  clearInterval(c.timer);
  confirming = null;
  renderConfirm();
  if (!keep) await setPref(c.name, c.before);
}

function settingsBack() {
  const st = state.settings;
  if (st.sub) {
    st.sub = "";
    st.row = st.back ?? 0;
    render();
    return true;
  }
  if (state.settings.zone === "rows") {
    state.settings.zone = "cats";
    state.settings.forget = "";
    render();
    return true;
  }
  return false;
}

function items() {
  if (state.sheet === "edit") return editItems();
  if (state.sheet === "medit") return mediaEditItems();
  if (state.sheet === "wall") return wallItems();
  if (state.sheet === "folder") return folderItems();
  return { games: gameItems, apps: appItems, media: mediaItems }[state.tab]();
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

// An item's info is a description for infoEl, or an element it built itself.
function asInfo(i) {
  return i instanceof Element ? i : infoEl(i);
}

function render() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));

  document.body.classList.toggle("settings-open", state.tab === "settings" && !state.sheet);
  if (state.tab === "settings" && !state.sheet) {
    paintBackground();
    // The music tab's cover would stay over the dimmed background.
    setStage(false);
    syncMotion();
    renderSettings();
    renderPlayer();
    return;
  }
  const list = items();
  paintBackground();
  setStage(state.tab === "media" && !state.sheet && !!list[state.focus.media]?.playing && !!state.media.cover);
  syncMotion();

  const fk = focusKey();
  state.focus[fk] = Math.max(0, Math.min(state.focus[fk], list.length - 1));
  const at = state.focus[fk];

  if (!list.length && state.tab === "games") {
    view.replaceChildren(infoEl({ lead: el("div", { className: "lead-symbol" }, svg("gamepad")), title: "Tus juegos aparecen aquí", meta: "Los juegos instalados con Steam o Epic Games se agregan solos." }));
    renderPlayer();
    return;
  }

  // Only what changed is rebuilt, so tiles never reload while moving.
  const key = `${state.tab}|${state.sheet}|` + list.map((x) => x.key + (x.rev ?? "")).join("|");
  let strip = view.querySelector(".row, .grid");
  const editing = state.sheet === "edit" || state.sheet === "medit";
  const editLabel = () => {
    if (state.sheet !== "medit") return state.pinned.includes(state.apps[at]?.id) ? "Quitar" : "Fijar";
    return list[at]?.more ? "Mostrar" : list[at]?.on ? "Quitar" : "Agregar";
  };
  const headFor = () => {
    const head = editing
      ? infoEl({ lead: el("div", { className: "lead-symbol" }, svg("edit")), title: state.sheet === "medit" ? "Editar Multimedia" : "Editar apps", meta: "", action: [editLabel(), "A"] })
      : asInfo(list[at].info());
    const m = state.media;
    head.dataset.item = editing ? "edit" : [list[at].key, m.title, m.artist, m.playing, m.duration_ms > 0].join("|");
    return head;
  };
  if (!strip || strip.dataset.key !== key) {
    strip = el("div", { className: state.sheet ? "grid" : "row" });
    strip.dataset.key = key;
    list.forEach((item) => strip.append(item.tile()));
    view.replaceChildren(headFor(), strip);
  } else if (editing) {
    const label = view.querySelector(".info .action span");
    if (label) label.textContent = editLabel();
  } else {
    const head = headFor();
    if (view.querySelector(".info").dataset.item !== head.dataset.item) view.querySelector(".info").replaceWith(head);
  }
  [...strip.children].forEach((t, k) => t.classList.toggle("on", k === at));
  const song = strip.querySelector(".tile.playing .song");
  if (song && song.textContent !== state.media.title) song.textContent = state.media.title;
  strip.children[at]?.scrollIntoView({ inline: "nearest", block: "nearest" });
  updateMusic();
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
  player.hidden = !m.title || state.tab === "media" || state.tab === "settings";
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
  if (state.tab === "settings" && !state.sheet) return settingsNav(dir);
  // Up / down outside the app grid change the volume.
  if (!state.sheet && (dir === "up" || dir === "down")) {
    changeVolume(invoke("volume_step", { delta: dir === "up" ? VOLUME_STEP : -VOLUME_STEP }));
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
  state.settings.zone = "cats";
  state.settings.sub = "";
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

// A streaming site in the default browser, driven with the cursor.
async function openService(id) {
  try {
    await invoke("open_service", { id });
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
  if (state.tab === "settings" && settingsBack()) return;
  invoke("set_mode", { mode: "cursor" });
}

// Shows the new level in a toast next to the clock.
let toastTimer = null;
async function changeVolume(request) {
  try {
    state.volume = await request;
  } catch (e) {
    return console.error(e);
  }
  const toast = document.getElementById("volume-toast");
  toast.replaceChildren(...volumeEl().childNodes);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), VOLUME_TOAST_MS);
}

function onPress(button) {
  // While a button swap waits to be kept, only its two answers count.
  if (confirming) {
    if (button === "a") keepChange(true);
    else if (button === "b") keepChange(false);
    return;
  }
  switch (button) {
    case "a":
      if (state.tab === "settings" && !state.sheet) settingsSelect();
      else items()[state.focus[focusKey()]]?.select();
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
    case "lt":
    case "rt":
      if (state.media.title) invoke("media_control", { action: button === "lt" ? "prev" : "next" });
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
  if (payload.kind === "nav" && payload.source !== "right") {
    if (!confirming) onNav(payload.dir);
  } else if (payload.kind === "press") onPress(payload.button);
});

// ---------- data ----------

async function load() {
  const data = await invoke("home_data");
  state.games = data.games;
  state.apps = data.apps;
  state.pinned = data.pinned;
  state.wallpaper = data.wallpaper;
  state.picks = data.media;
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
  if (state.tab === "media" && state.media.playing) updateMusic();
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

// The settings screen shows the preferences; the background follows game_art.
Prefs.watch((p) => {
  state.prefs = p;
  state.gameArt = p.game_art;
  render();
  // Its hints show the buttons as they are now.
  if (confirming) renderConfirm();
});
