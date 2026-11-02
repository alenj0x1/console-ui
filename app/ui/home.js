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
// Official colours of well-known apps and sites, matched by name; any other
// app takes the main colour of its own icon (see toneTile).
const BRANDS = [
  [/youtube/i, [255, 0, 0]],
  [/spotify/i, [30, 215, 96]],
  [/netflix/i, [229, 9, 20]],
  [/twitch/i, [145, 70, 255]],
  [/prime video/i, [0, 168, 225]],
  [/disney/i, [17, 60, 207]],
  [/discord/i, [88, 101, 242]],
  [/vlc/i, [255, 136, 0]],
  [/plex/i, [229, 160, 13]],
  [/kodi/i, [23, 178, 231]],
  [/apple music|itunes/i, [250, 36, 60]],
  [/deezer/i, [162, 56, 255]],
  [/amazon music/i, [37, 209, 218]],
  [/steam/i, [42, 71, 94]],
];

const state = {
  tab: "games",
  games: [],
  // Games with a window open (see gameItems).
  running: [],
  apps: [],
  pinned: [],
  focus: { games: 0, apps: 0, media: 0, edit: 0, medit: 0, wall: 0, folder: 0, search: 0 },
  // Finding a game (the "search" sheet): what was typed, and whether the
  // letters or the results have the focus.
  search: { q: "", zone: "keys", key: 0 },
  // The media tab's apps and sites (null = the installed media apps).
  picks: null,
  // Its edit grid lists every app only once asked to.
  allApps: false,
  // The settings tab: the category list or its rows has the focus.
  // sub: a list opened from a row (the keyboard's languages), with its own focus.
  settings: { zone: "cats", cat: 0, row: 0, forget: "", sub: "", subRow: 0 },
  prefs: null,
  // TV mode (tv_state): the screens and sound outputs, the chosen ones, on or off.
  tv: null,
  // A grid over the apps tab instead of the row: "edit" (pinned apps),
  // "medit" (the media tab's apps and sites),
  // "wall" (background), "folder" (adding a folder of backgrounds) or
  // "search" (finding a game, over the games tab); "" when closed.
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
// The trailer's sound is its own file, played alongside the video only when
// the user wants sound (X on the games tab, or Ajustes > Juegos).
const trailerSound = Object.assign(new Audio(), { loop: true, preload: "auto" });
// The game whose trailer may play, once it has kept the focus long enough.
let trailerFor = null;
let trailerTimer = null;
// The game whose trailer is loaded (its sound may be asked for from then on).
let trailerReady = null;
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

// The tab bar's LB / RB, drawn as the buttons (and as the ones that switch
// tabs now, with a one-hand layout).
function paintTabGlyphs() {
  document.querySelectorAll(".tabs > .glyph").forEach((g) => setGlyph(g, g.dataset.button ??= g.textContent.trim()));
}
paintTabGlyphs();

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

// A game's trailer fades in over its art after it keeps the focus for a
// moment; it is downloaded once the first time.
function setTrailer(gameId) {
  if (gameId === trailerFor) return;
  trailerFor = gameId;
  trailerReady = null;
  clearTimeout(trailerTimer);
  trailer.classList.remove("shown");
  loadSound();
  if (!gameId || calm.matches) return syncMotion();
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
    render(); // its sound button shows now
  }, { once: true });
  trailer.src = `${ASSET}/trailer/${encodeURIComponent(gameId)}`;
  trailerReady = gameId;
  loadSound();
}

listen("trailer", ({ payload }) => playTrailer(payload));
listen("trailer-sound", ({ payload }) => payload === trailerFor && loadSound(true));

function soundWanted() {
  return !!Prefs.get()?.trailer_sound;
}
// The sound file of the trailer that may play, only while sound is wanted.
function loadSound(again = false) {
  const src = soundWanted() && trailerReady ? `${ASSET}/trailer-sound/${encodeURIComponent(trailerReady)}` : "";
  if (!again && (trailerSound.dataset.src ?? "") === src) return syncSound();
  trailerSound.dataset.src = src;
  trailerSound.pause();
  if (src) trailerSound.src = src;
  else trailerSound.removeAttribute("src");
  trailerSound.load();
  syncSound();
}
// The sound follows the video: it plays while the video plays, at its time.
function syncSound() {
  const on = trailerSound.dataset.src && !trailer.paused && trailer.classList.contains("shown");
  if (!on) {
    if (!trailerSound.paused) trailerSound.pause();
    return;
  }
  if (Math.abs(trailerSound.currentTime - trailer.currentTime) > 0.25) trailerSound.currentTime = trailer.currentTime;
  if (trailerSound.paused) trailerSound.play().catch(() => {});
}
["play", "pause", "timeupdate"].forEach((e) => trailer.addEventListener(e, syncSound));
trailerSound.addEventListener("canplay", syncSound);

// X on a game whose trailer is playing: sound on or off, kept for every
// trailer after it.
function toggleTrailerSound() {
  setPref("trailer_sound", !soundWanted());
}

// Windows' "Show animations" is off: backgrounds stay still and trailers
// do not play.
const calm = matchMedia("(prefers-reduced-motion: reduce)");
calm.addEventListener("change", () => { Backgrounds.stop(); syncMotion(); });

// Videos and animations run only while they can be seen (not under a game's
// art, the music cover or with the home screen closed).
function syncMotion() {
  const stage = document.body.classList.contains("music-stage");
  if (active && !stage && !calm.matches && !Prefs.get()?.high_contrast && trailer.classList.contains("shown")) trailer.play().catch(() => {});
  else if (!trailer.paused) trailer.pause();
  const covered = stage || Prefs.get()?.high_contrast || heroes.some((h) => h.classList.contains("shown"));
  const visible = (layer) => active && layer.classList.contains("shown") && !covered;
  if (visible(wallVideo) && wallVideo.paused && !calm.matches) wallVideo.play().catch(() => {});
  else if ((!visible(wallVideo) || calm.matches) && !wallVideo.paused) wallVideo.pause();
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

// An app's card takes its brand's colour or its icon's main colour, darkened
// for ivory text. Colours are kept per icon so rebuilt cards never flash.
const tones = new Map();
// Darkened, its colour capped so none is louder than the others, then a
// fifth of the graphite surface mixed in.
const GRAPHITE = [42, 43, 47];
const MAX_SPREAD = 34;
function deep(rgb) {
  let d = rgb.map((v) => (v * 62) / Math.max(...rgb, 1));
  const grey = (d[0] + d[1] + d[2]) / 3, spread = Math.max(...d) - Math.min(...d);
  if (spread > MAX_SPREAD) d = d.map((v) => grey + ((v - grey) * MAX_SPREAD) / spread);
  return `rgb(${d.map((v, i) => Math.round(v * 0.8 + GRAPHITE[i] * 0.2)).join(",")})`;
}

// The icon's most present clearly coloured tone; null for grey icons.
function iconColour(image) {
  const c = Object.assign(document.createElement("canvas"), { width: 24, height: 24 });
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, 24, 24);
  const px = ctx.getImageData(0, 0, 24, 24).data;
  const groups = new Map();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 160) continue;
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    const e = groups.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    Object.assign(e, { n: e.n + 1, r: e.r + r, g: e.g + g, b: e.b + b });
    groups.set(key, e);
  }
  let best = null;
  for (const e of groups.values()) {
    const rgb = [e.r / e.n, e.g / e.n, e.b / e.n];
    const max = Math.max(...rgb);
    const sat = max ? (max - Math.min(...rgb)) / max : 0;
    if (sat < 0.35 || max < 60) continue;
    if (!best || e.n * sat > best.score) best = { rgb, score: e.n * sat };
  }
  return best?.rgb ?? null;
}

function toneTile(tile, name, icon) {
  const set = (rgb) => rgb && tile.style.setProperty("--tone", deep(rgb));
  const brand = BRANDS.find(([re]) => re.test(name))?.[1];
  if (brand) set(brand);
  else if (tones.has(icon)) set(tones.get(icon));
  else if (icon) {
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      let rgb = null;
      try {
        rgb = iconColour(probe);
      } catch {}
      tones.set(icon, rgb);
      set(rgb);
    };
    probe.onerror = () => tones.set(icon, null);
    probe.src = icon;
  }
  return tile;
}

// The playing card shows the cover on its right; a new cover replaces the
// old one only once it has loaded.
function tileCover(tile) {
  if (!state.media.cover) {
    tile.querySelector("img.cover")?.remove();
    tile.classList.remove("with-cover");
    delete tile.dataset.cover;
    return;
  }
  const src = coverUrl();
  if (!src || tile.dataset.cover === src) return;
  tile.dataset.cover = src;
  const next = el("img", { alt: "", className: "cover" });
  next.onload = () => {
    if (tile.dataset.cover !== src) return;
    tile.querySelector("img.cover")?.remove();
    tile.append(next);
    tile.classList.add("with-cover");
  };
  // No picture for this song: the card goes without, never with the last one.
  next.onerror = () => {
    if (tile.dataset.cover !== src) return;
    tile.querySelector("img.cover")?.remove();
    tile.classList.remove("with-cover");
  };
  next.src = src;
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

// ---------- lyrics ----------
// Synced lyrics of what plays (LRCLIB, through the app). While the player's
// card has the focus, R3 shows them in place of the cover (which goes small
// next to the title) and back; the choice is kept (also in Ajustes).
// The line being sung is lit and kept in the middle; songs without synced
// lyrics show none.
const lyricsBox = document.getElementById("lyrics");
const lyrics = { song: "", lines: [], at: -1, tries: 0, timer: 0 };
const lyricsWanted = () => !!Prefs.get()?.music_lyrics;
const LYRICS_RETRY_MS = 20000;
const LYRICS_TRIES = 3;

function songKey(m) {
  return m.title ? `${m.artist}
${m.title}` : "";
}

function loadLyrics() {
  const m = state.media;
  const song = songKey(m);
  if (song === lyrics.song) return;
  clearTimeout(lyrics.timer);
  Object.assign(lyrics, { song, lines: [], at: -1, tries: 0 });
  drawLyrics();
  if (song && Prefs.get()?.music_online !== false) fetchLyrics(song);
}

function fetchLyrics(song) {
  lyrics.tries++;
  invoke("lyrics")
    .then((l) => {
      if (lyrics.song !== song || !l || songKey(l) !== song) return;
      lyrics.lines = l.lines.filter((x, i, all) => x.text || (i > 0 && all[i - 1].text));
      drawLyrics();
      render(); // its Y hint
    })
    // The service can be busy for a moment: a few more tries, then none.
    .catch(() => {
      if (lyrics.song === song && lyrics.tries < LYRICS_TRIES) lyrics.timer = setTimeout(() => fetchLyrics(song), LYRICS_RETRY_MS);
    });
}

function drawLyrics() {
  const box = lyricsBox.querySelector(".lines");
  box.replaceChildren(...lyrics.lines.map((l) => el("p", { className: l.text ? "line" : "line gap", textContent: l.text || "•••" })));
  lyrics.at = -1;
  document.body.classList.toggle("has-lyrics", lyrics.lines.length > 0);
  followLyrics();
}

function toggleLyrics() {
  lyrics.at = -1;
  setPref("music_lyrics", !lyricsWanted());
}

// Lights the line being sung and centres it.
function followLyrics() {
  if (!document.body.classList.contains("lyrics-view")) return;
  const p = position() + LYRICS_LEAD_MS;
  let at = -1;
  while (at + 1 < lyrics.lines.length && lyrics.lines[at + 1].ms <= p) at++;
  if (at === lyrics.at) return;
  lyrics.at = at;
  const box = lyricsBox.querySelector(".lines");
  [...box.children].forEach((line, i) => {
    line.classList.toggle("now", i === at);
    line.classList.toggle("past", i < at);
  });
  const line = box.children[Math.max(at, 0)];
  const middle = lyricsBox.clientHeight / 2 - (line.offsetTop + line.offsetHeight / 2);
  box.style.transform = `translateY(${middle}px)`;
}
// A line lights a moment early, as the singer takes a breath.
const LYRICS_LEAD_MS = 250;
setInterval(followLyrics, 200);

function setStage(on) {
  document.body.classList.toggle("music-stage", on);
  document.body.classList.toggle("lyrics-view", on && lyricsWanted() && lyrics.lines.length > 0);
  if (on) {
    lyrics.at = -1;
    requestAnimationFrame(followLyrics);
  }
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

// How the tabs show their items (Ajustes > Apariencia): a row of wide
// banners, a row of box covers, a grid of covers or a list of names. Sheets
// (editing, search, backgrounds) are always a grid.
const libraryView = () => (state.sheet ? "" : state.prefs?.library_view ?? "banners");
// Box covers instead of wide banners; the backgrounds sheet always keeps the
// wide pictures.
const coversView = () => {
  const v = state.prefs?.library_view;
  return (v === "covers" || v === "grid") && state.sheet !== "wall" && state.sheet !== "folder";
};

// Open games come first (the last one played before the rest), then the
// last one played; A brings an open game back instead of starting it again.
function gameItems() {
  const open = (g) => state.running.includes(g.id);
  const rank = (g) => (open(g) ? (g.id === state.lastGame ? 0 : 1) : g.id === state.lastGame ? 2 : 3);
  const games = state.games.map((g, i) => [g, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([g]) => g);
  return games.map((g) => ({
    key: g.id,
    rev: open(g) ? "+" : "",
    tile: () => {
      // The name shows in the list, or when there is no picture.
      const kind = coversView() ? "capsule" : "header";
      return el("div", { className: "tile" }, g.art.includes(kind) ? img(art(g, kind), "art") : null, el("span", { className: "name", textContent: g.name }));
    },
    info: () => {
      const head = infoEl({
        lead: g.art.includes("logo") ? el("img", { className: "logo", src: art(g, "logo"), alt: g.name }) : null,
        title: g.name,
        meta: [open(g) ? "Abierto" : playedAgo(g.last_played), SOURCES[g.source]].filter(Boolean).join(" · "),
        action: [open(g) ? "Reanudar" : "Jugar", "A"],
      });
      if (state.sheet !== "search") {
        const hints = el("span", { className: "hints" }, el("span", { className: "hint" }, glyph("Y"), "Buscar"));
        if (trailerFor === g.id && trailer.classList.contains("shown")) hints.append(el("span", { className: "hint" }, glyph("X"), soundWanted() ? "Silenciar" : "Activar sonido"));
        head.querySelector(".action").after(hints);
      }
      return head;
    },
    name: g.name,
    select: () => open(g.id),
  }));
}

// ---------- finding a game ----------
// Y on the games tab: letters on top, every game below in A–Z order, the
// ones that match what was typed. A types, X erases, Y adds a space, LT / RT
// jump to the previous / next letter.
// Ten to a row, numbers last (game names like 2048 or FIFA 23).
const SEARCH_KEYS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const SEARCH_COLUMNS = 10;
const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const initial = (name) => fold(name)[0] ?? "";

function searchItems() {
  const q = fold(state.search.q).trim();
  const byName = (a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" });
  // Words that start with what was typed ("ho" finds Hollow Knight, not Asphalt).
  const words = (name) => " " + fold(name).replace(/[^a-z0-9]+/g, " ");
  return gameItems().filter((g) => !q || words(g.name).includes(" " + q)).sort(byName);
}

function searchHead() {
  const s = state.search;
  const keys = el("div", { className: "search-keys" },
    ...SEARCH_KEYS.map((k, i) => el("span", { className: `search-key${s.zone === "keys" && i === s.key ? " on" : ""}`, textContent: k })));
  const field = el("div", { className: "search-field" }, svg("search"),
    el("span", { className: s.q ? "query" : "query empty", textContent: s.q || "Buscar un juego" }));
  const hints = el("div", { className: "hints" },
    el("span", { className: "hint" }, glyph("X"), "Borrar"),
    el("span", { className: "hint" }, glyph("Y"), "Espacio"),
    el("span", { className: "hint" }, glyph("LT RT"), "Letra"),
    el("span", { className: "hint" }, glyph("B"), "Cerrar"));
  const head = el("section", { className: "search" }, field, keys, hints);
  head.dataset.item = "search";
  return head;
}

function openSearch() {
  state.sheet = "search";
  state.search = { q: "", zone: "keys", key: 0 };
  state.focus.search = 0;
  render();
}

function typeSearch(text) {
  const s = state.search;
  s.q = text === null ? s.q.slice(0, -1) : (s.q + text).slice(0, 40);
  state.focus.search = 0;
  render();
}

// LT / RT: the first game of the previous or next letter among the results.
function jumpLetter(dir) {
  const list = searchItems();
  if (!list.length) return;
  const starts = list.map((g, i) => i).filter((i) => i === 0 || initial(list[i].name) !== initial(list[i - 1].name));
  const at = state.focus.search;
  const group = starts.filter((i) => i <= at).pop();
  const to = dir > 0 ? starts.find((i) => i > at) : starts.filter((i) => i < group).pop();
  if (to === undefined) return;
  state.search.zone = "grid";
  state.focus.search = to;
  render();
}

function appTile(app, extra) {
  return toneTile(el("div", { className: "tile" }, img(appIcon(app.id), "tile-icon"), el("span", { className: "name", textContent: app.name }), extra), app.name, appIcon(app.id));
}

function siteTile(s, extra) {
  return toneTile(el("div", { className: "tile" }, img(s.icon, "tile-icon"), el("span", { className: "name", textContent: s.name }), extra), s.name, s.icon);
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
  // With the lyrics in its place, the cover goes small next to the title.
  const small = lyricsWanted() && lyrics.lines.length && coverUrl();
  const head = infoEl({
    lead: small ? el("img", { className: "lead-cover", src: small, alt: "" }) : app ? img(appIcon(app.id), "lead-icon") : el("p", { className: "source", textContent: playerName(m.source) }),
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
  if (lyrics.lines.length) hints.append(el("span", { className: "hint" }, glyph("R3"), lyricsWanted() ? "Carátula" : "Letra"));
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
        tile: () => siteTile(s),
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
    item.tile = () => {
      const name = playing?.name ?? playerName(m.source);
      const tile = el("div", { className: "tile playing" },
        playing ? img(appIcon(playing.id), "tile-icon") : svg("music", "icon symbol"),
        el("span", { className: "name", textContent: name }),
        el("span", { className: "song", textContent: m.title }));
      tileCover(tile);
      return toneTile(tile, name, playing ? appIcon(playing.id) : "");
    };
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
  const sites = SERVICES.map((s) => ({ id: `web:${s.id}`, tile: (on) => siteTile(s, on ? badge() : null) }));
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
  await invoke("set_media", { ids: state.picks }).catch((e) => failed("No se pudo guardar el cambio.", e));
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
// Which hand holds the controller; three long names do not fit side by side.
const HANDS = [["both", "Dos manos"], ["left", "Mano izquierda"], ["right", "Mano derecha"]];
const handName = (v) => (HANDS.find(([h]) => h === v) ?? HANDS[0])[1];
const TEXT_SIZES = [[100, "Normal"], [110, "Grande"], [120, "Muy grande"], [135, "Enorme"], [150, "La más grande"]];
const textSizeName = (v) => (TEXT_SIZES.find(([s]) => s === v) ?? TEXT_SIZES[0])[1];
// Buttons that can be reassigned, as the settings name them, and what each can do.
// Laid out as on the controller: the left hand's buttons, then the right's.
const PAD_LEFT = ["lt", "lb", "l3", "up", "left", "right", "down"];
const PAD_RIGHT = ["rt", "rb", "y", "x", "b", "a", "r3"];
const REMAP_BUTTONS = [...PAD_LEFT, ...PAD_RIGHT];
const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };
const buttonText = (b) => (ARROWS[b] ? `Cruceta ${ARROWS[b]}` : `{${b.toUpperCase()}}`);
// What each button usually does, in words, and the extra actions.
const ACTION_WORDS = {
  a: "Aceptar, clic", b: "Volver", x: "Clic derecho", y: "Teclado", lb: "Atrás", rb: "Adelante", lt: "Puntero lento", rt: "Siguiente canción",
  l3: "Clic central", r3: "Intro", up: "Flecha arriba", down: "Flecha abajo", left: "Flecha izquierda", right: "Flecha derecha",
  scroll_up: "Subir la página", scroll_down: "Bajar la página", none: "Nada",
};
const ACTIONS = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "l3", "r3", "up", "down", "left", "right", "scroll_up", "scroll_down", "none"];
const ACCENT_NAMES = { blue: "Azul", violet: "Violeta", green: "Verde", amber: "Ámbar", pink: "Rosa", ivory: "Marfil" };
// Names in everyday words, each with a line that says what it changes.
const CATEGORIES = [
  {
    name: "Apariencia",
    icon: "palette",
    rows: () => [
      Prefs.get()?.high_contrast ? null : { kind: "swatch", name: "Color principal", pref: "accent", options: Object.keys(Prefs.ACCENTS), desc: "El color del marco que muestra dónde estás y de botones como Jugar." },
      { kind: "toggle", name: "Alto contraste", pref: "high_contrast", desc: "Fondo negro liso, letras y bordes blancos y un marco amarillo grueso en lo que tienes elegido. Se enciende sola si Windows usa alto contraste." },
      { kind: "link", name: "Tamaño de letra", value: textSizeName(state.prefs?.text_size), run: () => openSub("text_size"), desc: "Agranda los textos de Inicio y del centro de control para leerlos de lejos." },
      { kind: "toggle", name: "Marco de selección más grueso", pref: "thick_focus", desc: "Un borde más ancho alrededor de lo que tienes elegido, para verlo mejor desde el sillón." },
      { kind: "link", name: "Fondo", value: state.wallpaper?.title ?? "Color liso", run: openWalls, desc: "Lo que se ve detrás de Inicio, sea una animación, un video o una imagen." },
      { kind: "toggle", name: "Letra en lugar de la carátula", pref: "music_lyrics", desc: "En Multimedia, lo que suena muestra su letra donde va la carátula, que pasa a verse chica junto al título. También se cambia con {R3}." },
      { kind: "toggle", name: "Imágenes de los juegos", pref: "game_art", desc: "Muestra el arte del juego elegido detrás de la pestaña Juegos." },
      { kind: "choice", name: "Forma de Inicio", pref: "library_view", options: [["banners", "Anchas"], ["covers", "Portadas"], ["grid", "Cuadrícula"], ["list", "Lista"]], desc: "Cómo se ven Juegos, Apps y Multimedia. En Cuadrícula y Lista, arriba y abajo se mueven por ellas y el volumen queda en {RT} + {↕}." },
    ].filter(Boolean),
  },
  {
    name: "Botones",
    icon: "gamepad",
    rows: () => [
      { kind: "link", name: "Distribución", pref: "hand", value: handName(state.prefs?.hand), run: () => openSub("hand"), desc: "Con una sola mano, todo queda del lado de esa mano. Clic con el botón de arriba, clic derecho con el gatillo y la cruceta o los botones desplazan. En un juego, mantén {View} con la izquierda o {Menu} con la derecha para abrir el centro de control." },
      { kind: "link", name: "Personalizar botones", value: "", run: () => openSub("buttons"), desc: "Elige qué hace cada botón del control. Cambia la distribución de arriba para empezar de nuevo." },
      { kind: "link", name: "Color del control", value: padThemeById(state.prefs?.pad_theme).name, run: () => openSub("pad_theme"), desc: "Los colores del control que se dibuja en Personalizar botones. Como vienen los controles, o una combinación al azar." },
      { kind: "toggle", name: "Aceptar con {B}", pref: "swap_ab", desc: "{B} acepta y {A} vuelve atrás. Para volver a lo normal, entra aquí y presiona {B}." },
      { kind: "toggle", name: "Puntero con la palanca derecha", pref: "swap_sticks", desc: "La palanca derecha mueve el puntero y la izquierda sube o baja la página." },
      { kind: "choice", name: "Tiempo para mantener presionado", pref: "hold_time", options: [["short", "Corto"], ["normal", "Normal"], ["long", "Largo"]], desc: "Cuánto hay que sostener {Menu} para abrir Inicio, o {View} + {Menu} para el centro de control. Un toque tiene que ser más corto que esto." },
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
      { kind: "toggle", name: "Tráileres con sonido", pref: "trailer_sound", desc: "Los tráileres de los juegos suenan. También se cambia con {X} mientras se ve uno." },
      { kind: "toggle", name: "Dejar el control al juego que abras", pref: "auto_game", desc: "Cuando abres un juego, el control es solo del juego. Al cerrarlo, vuelve el puntero. Para usar el puntero sin cerrarlo, mantén {View} + {Menu} y elige otra ventana." },
    ],
  },
  {
    name: "Modo TV",
    icon: "tv",
    rows: () => {
      const tv = state.tv;
      const nameOf = (list, id) => list?.find((c) => c.id === id)?.name;
      return [
        { kind: "toggle", tv: true, name: "Modo TV", desc: "Solo la TV queda encendida, como pantalla principal y con su sonido. Al apagarlo, todo vuelve como estaba. Si la TV no muestra nada, espera 15 s y vuelve sola." },
        { kind: "link", name: "Pantalla de la TV", value: nameOf(tv?.displays, tv?.display) ?? "Elegir", run: () => openSub("tv_display"), desc: "La pantalla que queda encendida en Modo TV." },
        { kind: "link", name: "Sonido en Modo TV", value: nameOf(tv?.outputs, tv?.audio) ?? "Sin cambiar", run: () => openSub("tv_audio"), desc: "Por dónde sale el sonido en Modo TV, por ejemplo los parlantes de la TV." },
      ];
    },
  },
  {
    name: "General",
    icon: "settings",
    rows: () => [
      { kind: "toggle", name: "Iniciar con Windows", pref: "start_with_windows", desc: "Se abre sola y en silencio al encender la computadora." },
      { kind: "toggle", name: "Carátulas y letras de internet", pref: "music_online", desc: "Muestra la carátula en alta calidad y la letra de lo que suena. Para buscarlas, envía el nombre de la canción y del artista a Deezer, Apple y LRCLIB." },
      { kind: "toggle", name: "Vibrar al cambiar de modo", pref: "rumble", desc: "El control vibra cuando pasa a un juego y cuando vuelve al puntero." },
      { kind: "choice", name: "Forma de este menú", pref: "settings_view", options: [["list", "Lista"], ["tiles", "Cuadros"]], desc: "Todo en una lista, o una categoría a la vez en cuadros grandes." },
      { kind: "link", name: "Practicar con el control", value: "", run: () => invoke("welcome_open").catch((e) => failed("No se pudo abrir la práctica.", e)), desc: "La práctica del principio: apuntar, cómo se siente el puntero, el teclado, Inicio y el centro de control." },
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
  if (CONFIRMED.includes(name) && value !== before && (value === true || (name === "hand" && value !== "both")) && !confirming) askToKeep(name, before);
  // High contrast hides the colour row above it: the focus stays on it.
  if (name === "high_contrast" && before !== value) state.settings.row = Math.max(0, state.settings.row + (value ? -1 : 1));
  render();
}

function rowControl(r) {
  const p = state.prefs ?? {};
  switch (r.kind) {
    case "toggle":
      return el("span", { className: `switch${(r.tv ? state.tv?.on : p[r.pref]) ? " on" : ""}` });
    case "check":
      // One choice (a size, a hand): only the chosen one is ticked. Several (languages): boxes.
      if (r.size || r.hand || r.single) return r.on ? svg("check", "icon tick") : null;
      return el("span", { className: `check${r.on ? " on" : ""}` }, r.on ? svg("check") : null);
    case "choice":
      return el("span", { className: "choice" }, ...r.options.map(([v, label]) => el("span", { className: v === p[r.pref] ? "sel" : "", textContent: label })));
    case "swatch":
      return el("span", { className: "swatches" }, ...r.options.map((id) => el("span", { className: `swatch${id === p[r.pref] ? " sel" : ""}`, style: `background:${Prefs.ACCENTS[id]}`, title: ACCENT_NAMES[id] })));
    case "link":
      return el("span", { className: "value" }, r.value, svg("chevron"));
    case "action": {
      const f = state.settings.forget;
      const again = withButtons("Presiona {A} otra vez", false);
      return el("span", { className: "value" }, ...(f === `${r.key}:ask` ? again : f === `${r.key}:done` ? [document.createTextNode("Listo")] : []));
    }
  }
}

// A list opened from a row: one line per language, ticked when on, one per
// text size or controller theme with the chosen one ticked, or a button's
// actions with a ✓ on the current one and a faint mark on the button's own.
function subRows() {
  const p = state.prefs ?? {};
  const sub = state.settings.sub;
  const map = p.button_map ?? {};
  if (sub === "buttons") return REMAP_BUTTONS.map((b) => ({ kind: "pick", name: buttonText(b), value: ACTION_WORDS[map[b] ?? b], button: b }));
  if (sub.startsWith("button:")) {
    const b = sub.slice(7);
    return ACTIONS.map((a) => ({ kind: "check", name: ACTION_WORDS[a], original: a === b, button: b, action: a, on: (map[b] ?? b) === a }));
  }
  if (sub === "pad_theme") return themeRows();
  if (sub === "hand") return HANDS.map(([hand, name]) => ({ kind: "check", name, hand, on: (p.hand ?? "both") === hand }));
  if (sub === "text_size") return TEXT_SIZES.map(([size, name]) => ({ kind: "check", name, size, on: p.text_size === size }));
  if (sub === "tv_display") return (state.tv?.displays ?? []).map((c) => ({ kind: "check", single: true, name: c.name, tv: ["display", c.id], on: state.tv.display === c.id }));
  if (sub === "tv_audio") {
    const outs = [{ id: "", name: "Sin cambiar" }, ...(state.tv?.outputs ?? [])];
    return outs.map((c) => ({ kind: "check", single: true, name: c.name, tv: ["audio", c.id], on: (state.tv?.audio ?? "") === c.id }));
  }
  return (p.available_languages ?? []).map((lang) => ({ kind: "check", name: languageName(lang), lang, on: (p.languages ?? []).includes(lang) }));
}

function settingsRows() {
  return state.settings.sub ? subRows() : CATEGORIES[state.settings.cat].rows();
}

function subTitle(sub) {
  if (sub === "text_size") return "Tamaño de letra";
  if (sub === "hand") return "Distribución";
  if (sub === "tv_display") return "Pantalla de la TV";
  if (sub === "tv_audio") return "Sonido en Modo TV";
  if (sub === "buttons" || sub === "pad_theme" || sub.startsWith("button:")) return "";
  return "Idiomas";
}

function openSub(name) {
  const st = state.settings;
  (st.trail ??= []).push({ sub: st.sub, row: st.row });
  st.sub = name;
  // A list of choices opens on the one in use.
  const chosen = name === "text_size" || name === "hand" || name === "pad_theme" || name.startsWith("button:") || name.startsWith("tv_");
  st.row = chosen ? Math.max(0, subRows().findIndex((r) => r.on)) : 0;
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
  // Lists opened from a row (languages, buttons) have nothing to explain.
  card.hidden = !row?.desc && !has;
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
    st.sub && subTitle(st.sub) && st.sub !== "buttons" ? el("div", { className: "panel-title" }, ...withButtons(subTitle(st.sub))) : null,
    ...rows.map((r, i) =>
      el("div", { className: `setting${r.danger ? " danger" : ""}${st.zone === "rows" && i === st.row ? " on" : ""}` }, el("span", { className: "name" }, ...withButtons(r.name)), rowControl(r)),
    ),
  );
  const row = rows[st.row];
  const valued = row && (row.kind === "choice" || row.kind === "swatch");
  const onPad = st.sub === "buttons" || st.sub.startsWith("button:");
  const hints = el("div", { className: "settings-hints" },
    st.zone === "cats" ? hintEl("A", "Abrir") : hintEl("A", onPad ? "Elegir" : row?.kind === "link" ? "Abrir" : row?.kind === "action" ? (row.hint ?? "Borrar") : "Cambiar"),
    st.zone === "rows" && valued ? hintEl("← →", "Elegir") : null,
    el("span", { className: "spacer" }),
    hintEl("B", st.zone === "rows" ? "Atrás" : "Cerrar"),
  );
  if (st.sub === "pad_theme") return renderThemes(rows, cats);
  let body;
  showPreview(st.sub ? null : rows[st.zone === "rows" ? st.row : 0]);
  const pad = onPad ? padMap(rows) : null;
  if (pad && !tiles) body = el("div", { className: "settings list" }, el("nav", { className: "cats" }, ...cats), pad);
  else if (pad) body = el("div", { className: "settings open" }, el("h2", { className: "cat-title" }, svg(CATEGORIES[st.cat].icon), CATEGORIES[st.cat].name), pad);
  else if (!tiles) body = el("div", { className: "settings list" }, el("nav", { className: "cats" }, ...cats), panel, card);
  else if (st.zone === "cats") body = el("div", { className: "settings tiles" }, ...cats);
  else body = el("div", { className: "settings open" }, el("h2", { className: "cat-title" }, svg(CATEGORIES[st.cat].icon), CATEGORIES[st.cat].name), panel, card);
  view.replaceChildren(body, hints);
  panel.querySelector(".setting.on")?.scrollIntoView({ block: "nearest" });
  fadeEdges(panel);
  if (pad) padGuide();
}

// ---------- the controller ----------
// An Xbox Series controller seen from the front, on a 600 × 396 canvas.
// Every reassignable button is a <g data-b> whose .key shape lights up in
// the accent; the rest (body, Xbox, View, Menu, Share) never does.
const PAD_GEO = {
  ls: [165, 156], rs: [375, 238], dpad: [225, 238], face: [455, 156], gap: 36,
  guide: [300, 84], view: [250, 118], menu: [350, 118], share: [300, 136],
};
// The body: shoulders, flanks opening out to the widest point low down, fat
// grips tilted outwards and the U between them; a small dip at the top for
// the Xbox button.
const PAD_BODY = "M300 46C290 46 284 40 270 40C200 40 140 42 112 54C92 62 80 80 74 100C62 160 44 230 40 280C38 330 62 388 118 388C156 388 176 356 196 322C212 288 388 288 404 322C424 356 444 388 482 388C538 388 562 330 560 280C556 230 538 160 526 100C520 80 508 62 488 54C460 42 400 40 330 40C316 40 310 46 300 46Z";
// LB: a 13 px band inside the top-left corner, a little way down the side,
// drawn over the body. LT: behind the body, at most 30 px showing above LB.
const PAD_BUMPER = "M165 42C140 43 124 47 112 55C96 62 86 76 80 96L72 100C76 76 90 54 108 43C124 34 144 30 165 30C172 30 172 42 165 42Z";
const PAD_TRIGGER = "M98 46C98 26 106 12 124 9L152 8C161 8 165 14 165 22V46Z";

function padSvg(themeId = state.prefs?.pad_theme) {
  const g = PAD_GEO;
  const uid = ++padIds;
  const theme = padThemeById(themeId);
  const mirror = 'transform="translate(600 0) scale(-1 1)"';
  const part = (b, cls, d, t = "") => `<g data-b="${b}" ${t}><path class="key ${cls}" d="${d}"/></g>`;
  const stick = (b, [x, y]) =>
    `<circle class="well" cx="${x}" cy="${y}" r="32"/><g data-b="${b}"><circle class="key cap" cx="${x}" cy="${y}" r="20"/></g>`;
  const face = (b, x, y) =>
    `<g data-b="${b}"><circle class="key face" cx="${x}" cy="${y}" r="17"/><text class="letter-${b}" x="${x}" y="${y}">${b.toUpperCase()}</text></g>`;
  const [fx, fy] = g.face;
  const [dx, dy] = g.dpad;
  const w = 7; // half the d-pad arm's width
  const L = 18; // arm length from the centre (a 36 px cross)
  const cross = `M${dx - w} ${dy - L}H${dx + w}V${dy - w}H${dx + L}V${dy + w}H${dx + w}V${dy + L}H${dx - w}V${dy + w}H${dx - L}V${dy - w}H${dx - w}Z`;
  // Each arm, tip to centre, lights up whole.
  const arm = (b, rect, tri) => `<g data-b="${b}"><rect class="key arm" ${rect} rx="1.5"/><path class="arrow" d="${tri}"/></g>`;
  const [vx, vy] = g.view;
  const [mx, my] = g.menu;
  return `<svg class="pad-drawing" viewBox="0 0 600 396" style="${padThemeStyle(theme, uid)}" aria-hidden="true">
  ${padPatterns(uid)}
  ${part("lt", "trigger", PAD_TRIGGER)}${part("rt", "trigger", PAD_TRIGGER, mirror)}
  <path class="body" d="${PAD_BODY}"/>
  ${part("lb", "bumper", PAD_BUMPER)}${part("rb", "bumper", PAD_BUMPER, mirror)}
  ${stick("l3", g.ls)}${stick("r3", g.rs)}
  <circle class="well" cx="${dx}" cy="${dy}" r="32"/>
  <path class="cross" d="${cross}"/>
  ${arm("up", `x="${dx - w}" y="${dy - L}" width="${2 * w}" height="${L}"`, `M${dx} ${dy - L + 4}l4 5h-8z`)}
  ${arm("down", `x="${dx - w}" y="${dy}" width="${2 * w}" height="${L}"`, `M${dx} ${dy + L - 4}l4 -5h-8z`)}
  ${arm("left", `x="${dx - L}" y="${dy - w}" width="${L}" height="${2 * w}"`, `M${dx - L + 4} ${dy}l5 4v-8z`)}
  ${arm("right", `x="${dx}" y="${dy - w}" width="${L}" height="${2 * w}"`, `M${dx + L - 4} ${dy}l-5 4v-8z`)}
  ${face("y", fx, fy - g.gap)}${face("x", fx - g.gap, fy)}${face("b", fx + g.gap, fy)}${face("a", fx, fy + g.gap)}
  <circle class="small" cx="${g.guide[0]}" cy="${g.guide[1]}" r="20"/>
  <circle class="guide-mark" cx="${g.guide[0]}" cy="${g.guide[1]}" r="9"/>
  <circle class="small" cx="${vx}" cy="${vy}" r="11"/>
  <path class="mark thin" d="M${vx - 4.5} ${vy - 3.5}h5v4h-5zM${vx - 1.5} ${vy + 0.5}v2.5h6v-4.5h-2"/>
  <circle class="small" cx="${mx}" cy="${my}" r="11"/>
  <path class="mark thin" d="M${mx - 4} ${my - 3}h8M${mx - 4} ${my}h8M${mx - 4} ${my + 3}h8"/>
  <rect class="small" x="${g.share[0] - 12}" y="${g.share[1] - 6}" width="24" height="12" rx="6"/>
  <path class="mark thin" d="M${g.share[0]} ${g.share[1] + 2.5}v-5M${g.share[0] - 2.5} ${g.share[1]}l2.5 -2.5l2.5 2.5"/>
</svg>`;
}

// ---------- themes ----------
// The controller's colours: deep, muted colours as a factory would make them,
// most with a quiet texture that is regular and on a grid (dots, fine lines,
// a fine grid, stripes, honeycomb, carbon weave, concentric rings), always
// flat: no blotches, no gradients. A theme is only data: each key becomes a
// CSS token on the drawing. High contrast ignores the theme.
const PAD_TEXT = "#ece8df";
const PAD_BONE = "#b9b3a5";
const PAD_BLACK = "#16171a";
const PAD_IVORY = "#ece8de";
const PAD_ACCENT = "#4c8dff";
// The face buttons' usual colours.
const PAD_ABXY = { a: "#3f9a2a", b: "#d0352c", x: "#2b72c4", y: "#b38700" };
// Textures a theme can have.
const PAD_PATTERNS = ["dots", "lines", "grid", "stripes", "hex", "carbon", "rings"];

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
// `t` of b into a.
const mix = (a, b, t) => rgbHex(hexRgb(a).map((v, i) => v + (hexRgb(b)[i] - v) * t));
function luminance(h) {
  return hexRgb(h).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function hsl(h, s, l) {
  s /= 100;
  l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return rgbHex([f(0), f(8), f(4)]);
}
// A colour with almost no colour in it (bone, grey, black).
function neutral(h) {
  const c = hexRgb(h);
  return (Math.max(...c) - Math.min(...c)) / 255 < 0.08;
}
// Dark enough for ivory text, the accent and a light focus ring.
const isDark = (c) => luminance(c) < 0.1;
// The colour pushed towards black or white, no further than it needs to read on `bg`.
function readable(c, bg, ratio) {
  const to = contrast(bg, "#ffffff") >= contrast(bg, "#000000") ? "#ffffff" : "#000000";
  for (let t = 0; t <= 1.001; t += 0.05) if (contrast(mix(c, to, t), bg) >= ratio) return mix(c, to, t);
  return to;
}
// The outline: the body's own colour, lightened or darkened only as much as
// it takes to read (3 : 1), so it never shines.
const lineOn = (c) => readable(c, c, 3.2);
// Letters in their colours (softened) or one colour; always 4.5 : 1.
function letters(face, coloured) {
  if (!coloured) {
    const mono = readable(face, face, 4.8);
    return { a: mono, b: mono, x: mono, y: mono };
  }
  return Object.fromEntries(Object.entries(PAD_ABXY).map(([k, c]) => [k, readable(mix(c, isDark(face) ? PAD_TEXT : "#000000", 0.35), face, 4.5)]));
}

// A full theme from a few colours; the rest follows from them.
function padTheme({ body, back, bumper = back, stick, dpad = stick, face, coloured = true, pattern = null, hue = null }) {
  const l = letters(face, coloured);
  return {
    body, back, bumper, stick, dpad, face, pattern, hue,
    well: mix(stick, "#000000", 0.45),
    line: lineOn(body),
    mark: readable(face, face, 4.5),
    // The texture: one shade lighter and one darker than the body.
    p1: mix(body, "#ffffff", isDark(body) ? 0.07 : 0.06),
    p2: mix(body, "#000000", isDark(body) ? 0.22 : 0.07),
    // The focus ring's outer edge: ivory on dark bodies, black on light ones.
    halo: isDark(body) ? PAD_IVORY : "#000000",
    la: l.a, lb: l.b, lx: l.x, ly: l.y,
  };
}

const PAD_THEMES = [
  { id: "grafito", name: "Grafito", ...padTheme({ body: "#35373c", back: "#212226", bumper: "#2b2d31", stick: "#45474c", face: "#2a2b2f" }) },
  { id: "carbon", name: "Carbón", ...padTheme({ body: "#1b1c1f", back: "#111214", bumper: "#222326", stick: "#2a2b2f", face: "#141517", coloured: false, pattern: "carbon" }) },
  { id: "puntos", name: "Puntos", ...padTheme({ body: "#2b2d31", back: "#8a8780", stick: "#45474c", face: PAD_BLACK, pattern: "dots" }) },
  { id: "marino", name: "Marino", ...padTheme({ body: "#1f3550", back: PAD_BONE, stick: PAD_BLACK, face: PAD_BLACK, coloured: false, pattern: "lines" }) },
  { id: "petroleo", name: "Petróleo", ...padTheme({ body: "#1d4049", back: PAD_BLACK, stick: "#8a8780", face: PAD_BLACK, pattern: "rings" }) },
  { id: "vino", name: "Vino", ...padTheme({ body: "#4a1f2a", back: PAD_BONE, stick: PAD_BLACK, face: PAD_BLACK, coloured: false, pattern: "grid" }) },
  { id: "bosque", name: "Bosque", ...padTheme({ body: "#24392c", back: PAD_BLACK, stick: PAD_BLACK, face: PAD_BLACK, coloured: false, pattern: "stripes" }) },
  { id: "oliva", name: "Oliva", ...padTheme({ body: "#3e4128", back: PAD_BLACK, stick: "#8a8780", face: PAD_BLACK, coloured: false, pattern: "hex" }) },
  { id: "ciruela", name: "Ciruela", ...padTheme({ body: "#3d2440", back: PAD_BONE, stick: PAD_BLACK, face: PAD_BLACK, pattern: "dots" }) },
  { id: "pizarra", name: "Pizarra", ...padTheme({ body: "#3a4148", back: PAD_BLACK, stick: "#8a8780", face: PAD_BLACK }) },
  { id: "hueso", name: "Hueso", ...padTheme({ body: "#c4bdae", back: "#4f4c46", stick: "#4f4c46", face: "#3a3833" }) },
  { id: "arena", name: "Arena", ...padTheme({ body: "#a3957a", back: "#3a3833", stick: "#3a3833", face: "#2a2926", coloured: false, pattern: "lines" }) },
];
const PAD_RANDOM = "random";

// What every theme must meet.
function themeProblems(t) {
  const out = [];
  if (contrast(t.line, t.body) < 3) out.push("line");
  if ([t.la, t.lb, t.lx, t.ly].some((c) => contrast(c, t.face) < 4.5)) out.push("letters");
  // The focus ring reads on the body and its texture: its outer edge or the
  // accent itself. The guide line (black edge) must read on the body too.
  const ground = t.pattern ? [t.body, t.p1, t.p2] : [t.body];
  if (!ground.every((c) => Math.max(contrast(PAD_ACCENT, c), contrast(t.halo, c)) >= 3)) out.push("focus");
  // (Thin textures — dots, lines, contour lines, honeycomb, specks — cover
  // too little of the body to matter for a 3 px line; the filled ones do.)
  const filled = ["stripes", "carbon"].includes(t.pattern) ? ground : [t.body];
  if (!filled.every((c) => Math.max(contrast(PAD_ACCENT, c), contrast("#000000", c)) >= 3)) out.push("guide");
  // Each part stands out from the body, or is a plain neutral.
  for (const k of ["back", "stick", "dpad", "face"]) if (t[k] !== t.body && !neutral(t[k]) && contrast(t[k], t.body) < 3) out.push(k);
  return out;
}

// ---------- random themes ----------
// A seed always gives the same controller, in the same deep, muted colours as
// the themes: a dark body (now and then a muted light one), its parts in
// bone, grey, black or a darker or lighter shade of the opposite colour, and
// often one of the textures. Never brown, never bright. A combination that
// does not meet themeProblems is drawn again.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Hues that stay a colour when dark (no oranges or yellows: they turn brown).
// Only two of them are wines and plums, so a draw seldom turns red.
const PAD_HUES = [100, 150, 185, 210, 230, 255, 280, 315, 345];

function randomTheme(seed) {
  const r = seededRandom(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const between = (a, b) => a + r() * (b - a);
  for (let tries = 0; tries < 40; tries++) {
    const light = r() < 0.18;
    const hue = light ? between(25, 55) : (pick(PAD_HUES) + between(-6, 6) + 360) % 360;
    // Dark: deep and muted, dark enough for the accent to read on it.
    let body;
    if (light) body = hsl(hue, between(10, 22), between(58, 68));
    else {
      let l = between(16, 24);
      // Dark reds need a little more colour or they turn brown.
      const sat = hue > 330 || hue < 15 ? between(32, 40) : between(24, 42);
      body = hsl(hue, sat, l);
      while (luminance(body) > 0.05 && l > 8) body = hsl(hue, sat, (l -= 1));
    }
    const opposite = (hue + 180 + between(-30, 30)) % 360;
    const shade = light ? hsl(hue, between(10, 20), between(22, 30)) : hsl(opposite, between(12, 25), between(60, 70));
    const parts = light ? [PAD_BLACK, "#3a3833", "#4f4c46"] : [PAD_BONE, "#8a8780", PAD_BLACK, shade];
    const back = pick(parts);
    const stick = pick(parts);
    const face = light ? pick([PAD_BLACK, "#3a3833"]) : PAD_BLACK;
    const theme = padTheme({
      body, back, bumper: r() < 0.5 ? back : body, stick, dpad: r() < 0.5 ? stick : face, face,
      // Light bodies take only the finest textures.
      coloured: r() < 0.5, pattern: r() < 0.6 ? pick(light ? ["dots", "lines", "grid"] : PAD_PATTERNS) : null, hue: light ? null : hue,
    });
    if (!themeProblems(theme).length) return { id: `${PAD_RANDOM}:${seed}`, name: "Al azar", ...theme };
  }
  return { ...PAD_THEMES[0], id: `${PAD_RANDOM}:${seed}`, name: "Al azar" };
}
// A new combination, its colour at least 40° away from the one before.
function newSeed(previous) {
  const before = previous?.startsWith(`${PAD_RANDOM}:`) ? padThemeById(previous).hue : null;
  for (;;) {
    const seed = 1 + Math.floor(Math.random() * 1e9);
    const hue = randomTheme(seed).hue;
    if (before == null || hue == null || Math.min(Math.abs(hue - before), 360 - Math.abs(hue - before)) >= 40) return seed;
  }
}

function padThemeById(id) {
  if (id?.startsWith(`${PAD_RANDOM}:`)) return randomTheme(+id.slice(PAD_RANDOM.length + 1) || 1);
  return PAD_THEMES.find((t) => t.id === id) ?? PAD_THEMES[0];
}

// The theme as CSS tokens on the drawing; none in high contrast.
let padIds = 0;
function padThemeStyle(t, uid) {
  if (state.prefs?.high_contrast) return "";
  const v = {
    "--pad-body": t.body, "--pad-back": t.back, "--pad-bumper": t.bumper, "--pad-well": t.well, "--pad-stick": t.stick,
    "--pad-dpad": t.dpad, "--pad-face": t.face, "--pad-line": t.line, "--pad-mark": t.mark, "--pad-halo": t.halo,
    "--pad-letter-a": t.la, "--pad-letter-b": t.lb, "--pad-letter-x": t.lx, "--pad-letter-y": t.ly,
    "--pad-p1": t.p1, "--pad-p2": t.p2,
    "--pad-paint": t.pattern ? `url(#pad-${t.pattern}-${uid})` : t.body,
  };
  return Object.entries(v).map(([k, c]) => `${k}:${c}`).join(";");
}

// The textures: regular and on a grid, one shade off the body so they read as
// the material. Flat colours only.
function padPatterns(uid) {
  const P = (name, w, h, inner) => `<pattern id="pad-${name}-${uid}" width="${w}" height="${h}" patternUnits="userSpaceOnUse"><rect width="${w}" height="${h}" fill="var(--pad-body)"/>${inner}</pattern>`;
  // Honeycomb: hexagons of side 8, in staggered rows.
  const s = 8;
  const hx = (cx, cy) => {
    const pts = [0, 60, 120, 180, 240, 300].map((a) => [cx + s * Math.cos((a * Math.PI) / 180), cy + s * Math.sin((a * Math.PI) / 180)]);
    return "M" + pts.map((p) => p.map((v) => v.toFixed(2)).join(" ")).join("L") + "Z";
  };
  const [hw, hh] = [3 * s, Math.sqrt(3) * s];
  const honey = [hx(0, 0), hx(hw, 0), hx(0, hh), hx(hw, hh), hx(hw / 2, hh / 2)].join("");
  return `<defs>
  ${P("dots", 14, 14, '<circle cx="7" cy="7" r="0.9" fill="var(--pad-p1)"/>')}
  ${P("lines", 7, 7, '<path d="M-1 8L8 -1M-1 1L1 -1M6 8L8 6" stroke="var(--pad-p1)" stroke-width="1"/>')}
  ${P("grid", 12, 12, '<path d="M0 0.5H12M0.5 0V12" stroke="var(--pad-p1)" stroke-width="1" fill="none"/>')}
  ${P("stripes", 12, 12, '<rect y="0" width="12" height="4" fill="var(--pad-p2)" opacity="0.55"/>')}
  ${P("hex", hw, hh, `<path d="${honey}" fill="none" stroke="var(--pad-p2)" stroke-width="1"/>`)}
  ${P("carbon", 8, 8, '<rect width="4" height="4" fill="var(--pad-p2)"/><rect x="4" y="4" width="4" height="4" fill="var(--pad-p2)"/><path d="M0 2h4M6 4v4M4 6h4M2 0v4" stroke="var(--pad-p1)" stroke-width="0.6"/>')}
  ${P("rings", 40, 40, '<g fill="none" stroke="var(--pad-p1)" stroke-width="1"><circle cx="20" cy="20" r="6"/><circle cx="20" cy="20" r="12"/><circle cx="20" cy="20" r="18"/></g>')}
</defs>`;
}

// A label's button, drawn as on the controller.
const padData = (e, d) => (Object.assign(e.dataset, d), e);
const padGlyph = (b) => setGlyph(el("span", { className: "glyph inline" }), ARROWS[b] ?? b.toUpperCase(), true);

// ---------- the map ----------
// The button in focus lights up inside a ring in the theme's halo colour
// (ivory on dark bodies, black on light ones), so the accent reads on any theme.
function padFocus(drawing, b) {
  const g = drawing.querySelector(`[data-b="${b}"]`);
  const key = g?.querySelector(".key");
  if (!key) return;
  g.classList.add("on");
  const halo = key.cloneNode();
  halo.setAttribute("class", "halo");
  g.insertBefore(halo, key);
}

function padMap(rows) {
  const st = state.settings;
  const p = state.prefs ?? {};
  const map = p.button_map ?? {};
  const choosing = st.sub.startsWith("button:");
  const at = choosing ? st.sub.slice(7) : rows[st.row]?.button;
  // With one hand, the other hand's column is quieter (still usable).
  const idle = { left: "right", right: "left" }[p.hand];
  const label = (b) =>
    padData(el("div", { className: `pad-label${b === at && !choosing ? " on" : ""}${b === at ? " at" : ""}` },
      padGlyph(b),
      el("span", { className: "value", textContent: ACTION_WORDS[map[b] ?? b] })), { b });
  const side = (name, buttons) => {
    if (choosing && buttons.includes(at)) return actionList(name, rows);
    return el("div", { className: `pad-side ${name}${idle === name ? " idle" : ""}` }, ...buttons.map(label));
  };
  const drawing = el("div", { className: "pad-center", innerHTML: padSvg() });
  padFocus(drawing, at);
  const guide = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  guide.classList.add("pad-guide");
  guide.innerHTML = '<path class="halo" d=""/><path class="line" d=""/>';
  return el("section", { className: `pad-map${choosing ? " choosing" : ""}` }, side("left", PAD_LEFT), drawing, side("right", PAD_RIGHT), guide);
}

// The actions of the button in focus, in place of its column.
function actionList(name, rows) {
  const st = state.settings;
  return el("div", { className: `pad-actions ${name}` },
    ...rows.map((r, i) =>
      el("div", { className: `pad-action${i === st.row ? " on" : ""}${r.on ? " current" : ""}` },
        el("span", { className: "name", textContent: r.name }),
        r.original ? el("span", { className: "original", textContent: "original" }) : null,
        r.on ? svg("check", "icon tick") : null)));
}

// The open list shows whole rows only: its height is a whole number of rows
// and the action in focus sits in the middle when it can.
function padListFit(list) {
  const items = [...list.children];
  if (!items.length) return;
  list.style.height = "";
  const cs = getComputedStyle(list);
  const [padTop, padBottom] = [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)];
  const gap = parseFloat(cs.rowGap) || 0;
  const pitch = items[0].offsetHeight + gap;
  const cell = getComputedStyle(list.parentElement);
  const room = list.parentElement.clientHeight - parseFloat(cell.paddingTop) - parseFloat(cell.paddingBottom);
  const n = Math.max(1, Math.min(items.length, Math.floor((room - padTop - padBottom + gap) / pitch)));
  list.style.height = `${n * pitch - gap + padTop + padBottom}px`;
  const at = Math.max(0, items.findIndex((i) => i.classList.contains("on")));
  list.scrollTop = Math.max(0, Math.min(items.length - n, at - Math.floor(n / 2))) * pitch;
  list.classList.toggle("more-up", list.scrollTop > 1);
  list.classList.toggle("more-down", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
}

// The guide: from the row in focus (a label, or an action in the open list)
// to the edge of its button, in straight runs at right angles only. It leaves
// the button sideways when the way out is clear, otherwise above or below it
// (the shoulder buttons by their top or their outer side), runs out to 16 px
// past the controller, then up or down to the row. It never crosses another
// button.
function padGuide() {
  const map = view.querySelector(".pad-map");
  if (!map) return;
  const paths = map.querySelectorAll(".pad-guide path");
  const path = { setAttribute: (k, v) => paths.forEach((p) => p.setAttribute(k, v)) };
  const box = map.getBoundingClientRect();
  const list = map.querySelector(".pad-actions");
  if (list) padListFit(list);
  const b = list ? state.settings.sub.slice(7) : map.querySelector(".pad-label.at")?.dataset.b;
  const group = b && map.querySelector(`.pad-drawing [data-b="${b}"]`);
  const key = group?.querySelector(".key");
  if (!key) return path.setAttribute("d", "");
  const left = PAD_LEFT.includes(b);
  const row = (list ? list.querySelector(".pad-action.on") : map.querySelector(".pad-label.at")).getBoundingClientRect();
  const root = getComputedStyle(document.documentElement);
  const ring = parseFloat(root.getPropertyValue("--focus")) * parseFloat(root.fontSize) || 0;
  const sx = left ? row.right + ring : row.left - ring;
  const sy = row.top + row.height / 2;
  const body = map.querySelector(".pad-drawing .body").getBoundingClientRect();
  const ex = left ? body.left - 16 : body.right + 16;
  const k = key.getBoundingClientRect();
  const [cx, cy] = [k.left + k.width / 2, k.top + k.height / 2];
  const edge = left ? k.left : k.right;
  // Everything else drawn on the controller that a line must not cross.
  const pad = 8;
  const blocks = [...map.querySelectorAll(".pad-drawing .key, .pad-drawing .small")]
    .filter((e) => e.closest("[data-b]") !== group)
    .map((e) => e.getBoundingClientRect());
  const hits = (a, c) => blocks.some((r) =>
    Math.min(a[0], c[0]) < r.right + pad && Math.max(a[0], c[0]) > r.left - pad &&
    Math.min(a[1], c[1]) < r.bottom + pad && Math.max(a[1], c[1]) > r.top - pad);
  const clear = (pts) => pts.every((p, i) => i === 0 || !hits(pts[i - 1], p));
  const tail = (y) => [[ex, y], [ex, sy], [sx, sy]];
  const step = 8;
  let pts = null;
  if (b === "lt" || b === "rt") pts = [[cx, k.top], [cx, k.top - 12], ...tail(k.top - 12)];
  else if (b === "lb" || b === "rb") pts = [[edge, k.bottom - 6], ...tail(k.bottom - 6)];
  else {
    const sideways = [[edge, cy], ...tail(cy)];
    if (clear(sideways)) pts = sideways;
    else {
      // Above or below, nearer the row first, on the first clear lane.
      const ways = sy < cy ? [-1, 1] : [1, -1];
      for (let n = 1; n <= 12 && !pts; n++) {
        for (const w of ways) {
          const from = [cx, w < 0 ? k.top : k.bottom];
          const lane = from[1] + w * (step + (n - 1) * step);
          const cand = [from, [cx, lane], ...tail(lane)];
          if (clear(cand)) { pts = cand; break; }
        }
      }
      pts ??= sideways;
    }
  }
  const o = ([x, y]) => `${(x - box.left).toFixed(1)} ${(y - box.top).toFixed(1)}`;
  path.setAttribute("d", "M" + pts.map(o).join("L"));
}

addEventListener("resize", padGuide);
document.fonts?.ready.then(padGuide);

// ---------- choosing the theme ----------
// Ajustes > Botones > Color del control: the themes in a list, with the
// controller beside it in the theme in focus. «Al azar» keeps a generated
// combination; «Otra combinación» makes a new one at once, and it stays.
function themeRows() {
  const cur = state.prefs?.pad_theme ?? PAD_THEMES[0].id;
  const random = cur.startsWith(`${PAD_RANDOM}:`) ? cur : `${PAD_RANDOM}:${(state.settings.seed ??= newSeed(cur))}`;
  return [
    ...PAD_THEMES.map((t) => ({ kind: "theme", name: t.name, theme: t.id, on: cur === t.id })),
    { kind: "theme", name: "Al azar", theme: random, on: cur === random },
    { kind: "reroll", name: "Otra combinación", theme: random },
    // The one before the last «Otra combinación», to go back to it.
    ...(state.settings.previous && state.settings.previous !== cur ? [{ kind: "theme", name: "Combinación anterior", theme: state.settings.previous, back: true }] : []),
  ];
}
// Two circles: the body (with its pattern) and its parts (the one that
// stands out most from the body).
function themeChip(id) {
  const t = padThemeById(id);
  const parts = [t.back, t.stick, t.face].sort((x, y) => contrast(y, t.body) - contrast(x, t.body))[0];
  // A textured theme shows fine diagonal lines on its circle.
  const paint = t.pattern ? `repeating-linear-gradient(45deg, ${t.p1} 0 1px, transparent 1px 4px), ${t.body}` : t.body;
  return el("span", { className: "pad-chip" }, el("span", { style: `background:${paint}` }), el("span", { style: `background:${parts}` }));
}

function renderThemes(rows, cats) {
  const st = state.settings;
  const row = rows[st.row];
  const panel = el("section", { className: "panel" },
    ...rows.map((r, i) =>
      el("div", { className: `setting pad-theme-row${i === st.row ? " on" : ""}` },
        r.kind === "reroll" ? svg("shuffle", "icon pad-chip-icon") : themeChip(r.theme),
        el("span", { className: "name", textContent: r.name }),
        r.on ? svg("check", "icon tick") : null)));
  const preview = el("section", { className: "preview-card pad-theme-card", innerHTML: padSvg(row.kind === "reroll" ? state.prefs?.pad_theme : row.theme) });
  const hints = el("div", { className: "settings-hints" },
    hintEl("A", row.kind === "reroll" ? "Otra combinación" : "Usar"),
    el("span", { className: "spacer" }),
    hintEl("B", "Atrás"));
  view.replaceChildren(el("div", { className: "settings list" }, el("nav", { className: "cats" }, ...cats), panel, preview), hints);
  panel.querySelector(".setting.on")?.scrollIntoView({ block: "nearest" });
  fadeEdges(panel);
}

// Fade the edge where a list goes on, so no row looks cut.
function fadeEdges(list) {
  list.classList.toggle("more-above", list.scrollTop > 2);
  list.classList.toggle("more-below", list.scrollTop + list.clientHeight < list.scrollHeight - 2);
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
  // On the controller: up and down along a side, left and right across.
  if (st.sub === "buttons") {
    const side = st.row < PAD_LEFT.length ? 0 : PAD_LEFT.length;
    const size = side ? PAD_RIGHT.length : PAD_LEFT.length;
    const i = st.row - side;
    if (dir === "up" || dir === "down") st.row = side + Math.max(0, Math.min(size - 1, i + (dir === "up" ? -1 : 1)));
    else st.row = (dir === "left" ? 0 : PAD_LEFT.length) + Math.min(i, (dir === "left" ? PAD_LEFT : PAD_RIGHT).length - 1);
    return render();
  }
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
  if (r.kind === "theme") {
    // Going back swaps: the one left behind becomes the one before.
    if (r.back) st.previous = p.pad_theme;
    setPref("pad_theme", r.theme);
  } else if (r.kind === "reroll") {
    // A new combination at once; the focus stays here to press again.
    st.previous = p.pad_theme;
    setPref("pad_theme", `${PAD_RANDOM}:${(st.seed = newSeed(p.pad_theme))}`);
  }
  else if (r.kind === "toggle" && r.tv) toggleTv();
  else if (r.kind === "toggle") setPref(r.pref, !p[r.pref]);
  else if (r.kind === "check" && r.tv) chooseTv(...r.tv);
  else if (r.kind === "check" && r.size) setPref("text_size", r.size);
  else if (r.kind === "check" && r.hand) setPref("hand", r.hand);
  else if (r.kind === "pick") openSub(`button:${r.button}`);
  else if (r.kind === "check" && r.action) setPref("button_map", { button: r.button, action: r.action }).then(settingsBack);
  else if (r.kind === "check") {
    const langs = p.languages ?? [];
    const next = langs.includes(r.lang) ? langs.filter((l) => l !== r.lang) : [...langs, r.lang];
    if (next.length) setPref("languages", next); // at least one stays on
  } else if (r.kind === "choice") {
    const at = r.options.findIndex(([v]) => v === p[r.pref]);
    setPref(r.pref, r.options[(at + 1) % r.options.length][0]);
  } else if (r.kind === "link" || r.kind === "action") r.run();
}

// TV mode: what can be chosen and whether it is on, read when the home
// screen opens and after every change.
async function loadTv() {
  state.tv = await invoke("tv_state").catch(() => null);
  render();
}

// Turning it on with no screen chosen asks for the screen first, then turns on.
let tvAfterChoice = false;
async function toggleTv() {
  if (!state.tv?.display && !state.tv?.on) {
    tvAfterChoice = true;
    return openSub("tv_display");
  }
  const on = !state.tv.on;
  try {
    await invoke("tv_set", { on });
    if (on) askToKeepTv();
  } catch (e) {
    failed(on ? "No se pudo encender el Modo TV." : "No se pudo apagar el Modo TV.", e);
  }
  await loadTv();
}

async function chooseTv(what, id) {
  try {
    await invoke("tv_choose", { what, id });
  } catch (e) {
    return failed("No se pudo guardar el cambio.", e);
  }
  await loadTv();
  settingsBack();
  if (what === "display" && tvAfterChoice) {
    tvAfterChoice = false;
    toggleTv();
  }
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
const CONFIRMED = ["swap_ab", "swap_sticks", "hand"];
let confirming = null; // { name, before, left, timer } or { tv: true, left, timer }
// TV mode asks the same way (app/src/tv.rs CONFIRM_WITHIN).
const TV_CONFIRM_SECONDS = 15;
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

function askToKeepTv() {
  clearInterval(confirming?.timer);
  confirming = { tv: true, left: TV_CONFIRM_SECONDS };
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
  const tv = confirming.tv;
  confirmEl.replaceChildren(
    el("div", { className: "confirm-card" },
      el("h2", { textContent: tv ? "¿Se ve bien la TV?" : "¿Dejas los botones así?" }),
      el("p", { textContent: tv ? `Si no eliges nada, todo vuelve como estaba en ${confirming.left} s.` : `Si no eliges nada, vuelven a como estaban en ${confirming.left} s.` }),
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
  if (c.tv) {
    await invoke(keep ? "tv_confirm" : "tv_set", keep ? {} : { on: false }).catch((e) => failed("No se pudo cambiar el Modo TV.", e));
    return loadTv();
  }
  if (!keep) await setPref(c.name, c.before);
}

function settingsBack() {
  const st = state.settings;
  if (st.sub) {
    const back = st.trail?.pop() ?? { sub: "", row: 0 };
    st.sub = back.sub;
    st.row = back.row;
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
  if (state.sheet === "search") return searchItems();
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

// Where the volume is: up and down on the d-pad in a row, with RT held in a
// grid or a list (RT + the d-pad, with room between them).
function volumeHint(head) {
  const held = libraryView() === "grid" || libraryView() === "list";
  const keys = held ? [glyph("RT"), plusSign(), glyph("↕")] : [glyph("↕")];
  const hint = el("span", { className: "hint" }, ...keys, "Volumen");
  const hints = head.querySelector(".hints");
  if (hints) hints.append(hint);
  else (head.querySelector(".action") ?? head.querySelector(".meta"))?.after(el("span", { className: "hints" }, hint));
  return head;
}

// An item's info is a description for infoEl, or an element it built itself.
function asInfo(i) {
  return i instanceof Element ? i : infoEl(i);
}

// Which sides of a row have more tiles beyond the edge (they fade there).
function edges(strip) {
  if (!strip.classList.contains("row")) return;
  strip.classList.toggle("more-left", strip.scrollLeft > 1);
  strip.classList.toggle("more-right", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
}

// Big text or a long title may not fit above the row: the tiles give up size
// (down to 60 %) before the info would be cut. Within a tab they only shrink,
// so they don't change size while moving between items.
function fitRow(strip) {
  const key = `${state.tab}|${state.sheet}|${libraryView()}|${state.prefs?.text_size}|${innerHeight}`;
  if (view.dataset.fit !== key) {
    view.dataset.fit = key;
    view.style.removeProperty("--fit");
  }
  const info = view.querySelector(".info");
  if (state.sheet || !strip.classList.contains("row") || !info) return;
  const over = info.scrollHeight - info.clientHeight;
  if (over <= 0) return;
  // The focused tile's picture height at full size (see .tile in home.css).
  const focused = (coversView() ? 22.5 : 11.75) * (innerHeight / 67.5);
  const fit = parseFloat(view.style.getPropertyValue("--fit") || "1");
  view.style.setProperty("--fit", Math.max(0.6, fit - (over + 4) / focused).toFixed(3));
}

function render() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));

  document.body.classList.toggle("settings-open", state.tab === "settings" && !state.sheet);
  document.body.classList.toggle("search-open", state.sheet === "search");
  view.classList.remove("as-grid", "as-list");
  document.body.classList.remove("as-list");
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

  // A grid shows the info in short over it; a list takes the right side.
  const shape = libraryView();
  view.classList.toggle("as-grid", shape === "grid" && list.length > 0);
  view.classList.toggle("as-list", shape === "list" && list.length > 0);
  document.body.classList.toggle("as-list", shape === "list");

  if (state.sheet === "search" && !list.length) {
    view.replaceChildren(searchHead(), el("div", { className: "search-empty" },
      el("div", { className: "lead-symbol" }, svg("search")),
      el("div", {}, el("b", { textContent: "Ningún juego coincide" }), el("span", {}, ...withButtons("Borra una letra con {X} para ver más.", false)))));
    renderPlayer();
    return;
  }
  if (!list.length && state.tab === "games") {
    view.replaceChildren(infoEl({ lead: el("div", { className: "lead-symbol" }, svg("gamepad")), title: "Tus juegos aparecen aquí", meta: "Los juegos instalados con Steam o Epic Games se agregan solos." }));
    renderPlayer();
    return;
  }

  // Only what changed is rebuilt, so tiles never reload while moving.
  const covers = coversView();
  const key = `${state.tab}|${state.sheet}|${covers}|${shape}|` + list.map((x) => x.key + (x.rev ?? "")).join("|");
  let strip = view.querySelector(".row, .grid, .list");
  const editing = state.sheet === "edit" || state.sheet === "medit";
  const editLabel = () => {
    if (state.sheet !== "medit") return state.pinned.includes(state.apps[at]?.id) ? "Quitar" : "Fijar";
    return list[at]?.more ? "Mostrar" : list[at]?.on ? "Quitar" : "Agregar";
  };
  const headFor = () => {
    if (state.sheet === "search") return searchHead();
    const head = editing
      ? infoEl({ lead: el("div", { className: "lead-symbol" }, svg("edit")), title: state.sheet === "medit" ? "Editar Multimedia" : "Editar apps", meta: "", action: [editLabel(), "A"] })
      : volumeHint(asInfo(list[at].info()));
    const m = state.media;
    const sound = trailer.classList.contains("shown") ? `${trailerFor}:${soundWanted()}` : "";
    const words = list[at]?.playing ? `${lyrics.lines.length > 0}:${lyricsWanted()}:${!!coverArt.url}` : "";
    head.dataset.item = editing ? "edit" : [list[at].key + (list[at].rev ?? ""), m.title, m.artist, m.playing, m.duration_ms > 0, sound, words].join("|");
    return head;
  };
  if (!strip || strip.dataset.key !== key) {
    const kind = state.sheet || shape === "grid" ? "grid" : shape === "list" ? "list" : "row";
    strip = el("div", { className: kind + (covers ? " covers" : "") });
    strip.dataset.key = key;
    // The focused tile grows after it is scrolled to, so it is scrolled again
    // once it has its full size.
    strip.addEventListener("transitionend", (e) => {
      if (e.propertyName === "width" && e.target.classList.contains("on")) {
        e.target.scrollIntoView({ inline: "nearest", block: "nearest" });
        edges(strip);
      }
    });
    list.forEach((item) => strip.append(item.tile()));
    view.replaceChildren(headFor(), strip);
  } else if (state.sheet === "search") {
    view.querySelector(".search").replaceWith(headFor());
  } else if (editing) {
    const label = view.querySelector(".info .action span");
    if (label) label.textContent = editLabel();
  } else {
    const head = headFor();
    if (view.querySelector(".info").dataset.item !== head.dataset.item) view.querySelector(".info").replaceWith(head);
  }
  const ringed = state.sheet !== "search" || state.search.zone === "grid";
  [...strip.children].forEach((t, k) => t.classList.toggle("on", ringed && k === at));
  const song = strip.querySelector(".tile.playing .song");
  if (song && song.textContent !== state.media.title) song.textContent = state.media.title;
  const nowTile = strip.querySelector(".tile.playing");
  if (nowTile) tileCover(nowTile);
  fitRow(strip);
  strip.children[at]?.scrollIntoView({ inline: "nearest", block: "nearest" });
  edges(strip);
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
  if (!grid) return 1;
  const tiles = [...grid.children];
  const top = tiles[0]?.offsetTop;
  const n = tiles.findIndex((t) => t.offsetTop !== top);
  return n === -1 ? Math.max(tiles.length, 1) : n;
}

function searchNav(dir) {
  const s = state.search;
  // The list can empty itself (a library reload): the letters take the focus.
  if (!searchItems().length) s.zone = "keys";
  if (s.zone === "keys") {
    const step = { left: -1, right: 1, up: -SEARCH_COLUMNS, down: SEARCH_COLUMNS }[dir];
    const to = s.key + step;
    if (to >= 0 && to < SEARCH_KEYS.length) s.key = to;
    // Down from the last row of letters: the results.
    else if (dir === "down" && searchItems().length) s.zone = "grid";
    render();
    return true;
  }
  if (dir === "up" && state.focus.search < columns(view.querySelector(".grid"))) {
    s.zone = "keys";
    render();
    return true;
  }
  return false;
}

function onNav(dir) {
  if (state.tab === "settings" && !state.sheet) return settingsNav(dir);
  if (state.sheet === "search" && searchNav(dir)) return;
  // Up / down in a row change the volume (in a grid or a list they move;
  // RT + d-pad changes the volume from anywhere).
  const shape = libraryView();
  if (!state.sheet && (shape === "banners" || shape === "covers") && (dir === "up" || dir === "down")) {
    changeVolume(invoke("volume_step", { delta: dir === "up" ? VOLUME_STEP : -VOLUME_STEP }));
    return;
  }
  const fk = focusKey();
  const count = items().length;
  let step = { left: -1, right: 1 }[dir] ?? 0;
  if (shape === "list") step = { up: -1, down: 1 }[dir] ?? 0;
  else if (dir === "up" || dir === "down") {
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
  state.settings.trail = [];
  state.tab = TABS[(TABS.indexOf(state.tab) + delta + TABS.length) % TABS.length];
  render();
}

// Says what failed (and why, in the host's words) for a few seconds.
const TOAST_MS = 5000;
let failTimer = 0;
function failed(what, e) {
  console.error(e);
  const toast = document.getElementById("toast");
  toast.querySelector("b").textContent = what;
  const why = typeof e === "string" ? e : "";
  toast.querySelector("span").textContent = why ? why[0].toUpperCase() + why.slice(1) + "." : "";
  toast.hidden = false;
  clearTimeout(failTimer);
  failTimer = setTimeout(() => (toast.hidden = true), TOAST_MS);
}

async function open(id) {
  try {
    const isGame = await invoke("launch", { id });
    await invoke("set_mode", { mode: isGame ? "off" : "cursor" });
  } catch (e) {
    const name = state.games.find((g) => g.id === id)?.name ?? appById(id)?.name;
    failed(name ? `No se pudo abrir ${name}.` : "No se pudo abrir.", e);
  }
}

async function togglePin(id) {
  state.pinned = state.pinned.includes(id) ? state.pinned.filter((p) => p !== id) : [...state.pinned, id];
  render();
  await invoke("set_pinned", { ids: state.pinned }).catch((e) => failed("No se pudieron guardar tus apps.", e));
}

async function openWalls() {
  try {
    const data = await invoke("wallpapers");
    state.walls = data.items;
    state.wallpaper = data.items.find((w) => w.id === data.current) ?? null;
    state.engine = data.engine;
    state.folders = data.folders;
  } catch (e) {
    return failed("No se pudieron cargar los fondos.", e);
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
    failed("No se pudo cambiar el fondo.", e);
    state.wallpaper = before;
    render();
  }
}

async function toggleGameArt() {
  state.gameArt = !state.gameArt;
  render();
  await invoke("set_game_art", { on: state.gameArt }).catch((e) => failed("No se pudo guardar el cambio.", e));
}

// A streaming site in the default browser, driven with the cursor.
async function openService(id) {
  try {
    await invoke("open_service", { id });
    await invoke("set_mode", { mode: "cursor" });
  } catch (e) {
    failed("No se pudo abrir el sitio.", e);
  }
}

async function openWorkshop() {
  try {
    await invoke("open_workshop");
    await invoke("set_mode", { mode: "cursor" });
  } catch (e) {
    failed("No se pudo abrir Wallpaper Engine.", e);
  }
}

// `path` null = the drives.
async function openFolder(path) {
  try {
    state.folder = await invoke("browse_folders", { path });
  } catch (e) {
    return failed("No se pudo abrir la carpeta.", e);
  }
  state.sheet = "folder";
  state.focus.folder = 0;
  render();
}

async function addFolder(path) {
  try {
    await invoke("add_wallpaper_folder", { path });
  } catch (e) {
    return failed("No se pudo agregar la carpeta.", e);
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
  if (state.sheet === "search") {
    const s = state.search;
    if (button === "a" && s.zone === "keys") return typeSearch(SEARCH_KEYS[s.key].toLowerCase());
    if (button === "x") return typeSearch(null);
    if (button === "y") return typeSearch(" ");
    if (button === "lt" || button === "rt") return jumpLetter(button === "lt" ? -1 : 1);
  }
  switch (button) {
    case "a":
      if (state.tab === "settings" && !state.sheet) settingsSelect();
      else items()[state.focus[focusKey()]]?.select();
      break;
    case "y":
      if (state.tab === "games" && !state.sheet && state.games.length) openSearch();
      else changeVolume(invoke("volume_mute"));
      break;
    case "b":
      back();
      break;
    case "r3":
      if (document.body.classList.contains("music-stage") && lyrics.lines.length) toggleLyrics();
      break;
    case "x":
      if (state.tab === "games" && !state.sheet && trailer.classList.contains("shown")) toggleTrailerSound();
      else if (state.media.title) invoke("media_control", { action: "toggle" });
      break;
    case "lt":
      if (state.media.title) invoke("media_control", { action: "prev" });
      break;
    case "rt":
      Object.assign(rt, { held: true, used: false });
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
    if (!confirming) (rt.held ? rtNav : onNav)(payload.dir);
  } else if (payload.kind === "press") onPress(payload.button);
  else if (payload.kind === "release" && payload.button === "rt") rtUp();
});

// RT held with the d-pad: up / down change the volume, left / right the
// song, as everywhere else. A tap alone, on release, plays the next song.
const rt = { held: false, used: false };
function rtNav(dir) {
  rt.used = true;
  if (dir === "up" || dir === "down") changeVolume(invoke("volume_step", { delta: dir === "up" ? VOLUME_STEP : -VOLUME_STEP }));
  else if (state.media.title) invoke("media_control", { action: dir === "left" ? "prev" : "next" });
}
function rtUp() {
  if (rt.held && !rt.used && !confirming && state.media.title) invoke("media_control", { action: "next" });
  rt.held = false;
}

// ---------- data ----------

async function load() {
  const data = await invoke("home_data");
  state.games = data.games;
  state.apps = data.apps;
  state.pinned = data.pinned;
  state.wallpaper = data.wallpaper;
  state.picks = data.media;
  state.gameArt = data.game_art;
  state.lastGame = data.last_game;
  state.running = data.running;
  render();
  loadTv();
}

listen("library", load);
listen("media", ({ payload }) => {
  state.media = payload;
  loadLyrics();
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

// Games opened or closed while Inicio shows: the list follows, and the
// focus stays on the same game.
const OPEN_GAMES_EVERY_MS = 3000;
setInterval(async () => {
  if (!active || state.tab !== "games" || state.sheet) return;
  const ids = await invoke("open_games").catch(() => null);
  if (!ids || ids.join() === state.running.join()) return;
  const focused = gameItems()[state.focus.games]?.key;
  state.running = ids;
  const at = gameItems().findIndex((g) => g.key === focused);
  if (at >= 0) state.focus.games = at;
  render();
}, OPEN_GAMES_EVERY_MS);

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
  loadLyrics();
  render();
});
load();

// The settings screen shows the preferences; the background follows game_art.
Prefs.watch((p) => {
  // Lyrics come and go with Ajustes > General.
  if (p.music_online !== state.prefs?.music_online) {
    lyrics.song = "-";
    loadLyrics();
  }
  state.prefs = p;
  state.gameArt = p.game_art;
  loadSound();
  render();
  syncMotion(); // high contrast stops the videos and animations behind
  // Its hints show the buttons as they are now.
  if (confirming) renderConfirm();
  paintTabGlyphs();
});
