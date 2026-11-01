// Home screen: games, pinned apps and music, driven by controller events
// from the engine ("pad"). Every tab has the same look: a full background,
// information on the left and a row of tiles at the bottom. Games and apps
// show the focused game's art; music fills the screen with the cover and its
// colour. LB / RB switch tabs, A opens, X plays or pauses the music, up /
// down change the volume and Y mutes it, B goes back or closes; holding Menu
// closes too (engine).

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
const CONTROLS = ["prev", "toggle", "next"];
const SOURCES = { steam: "Steam", epic: "Epic Games" };

const state = {
  tab: "games",
  games: [],
  apps: [],
  pinned: [],
  focus: { games: 0, apps: 0, music: 1, edit: 0 },
  // Editing pinned apps: every app in a grid instead of the row.
  editing: false,
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
let heroShown = 0;
let heroUrl = "";

const art = (game, kind) => `${ASSET}/art/${encodeURIComponent(game.id)}/${kind}`;
const appIcon = (id) => `${ASSET}/icon/${encodeURIComponent(id)}`;
const cover = () => `${ASSET}/cover?r=${state.media.cover}`;
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
    return;
  }
  const next = heroes[1 - heroShown];
  next.onload = () => {
    if (heroUrl !== url) return; // another game was chosen meanwhile
    next.classList.add("shown");
    heroes[heroShown].classList.remove("shown");
    heroShown = 1 - heroShown;
  };
  next.src = url;
}

// The cover's most colourful tone, darkened enough for ivory text on top.
function coverTone(image) {
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, 24, 24);
  let best = [40, 42, 48];
  let bestScore = -1;
  const px = ctx.getImageData(0, 0, 24, 24).data;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Prefer saturated, not too dark or too bright pixels.
    const score = (max - min) * (1 - Math.abs(max - 150) / 150);
    if (score > bestScore) [best, bestScore] = [[r, g, b], score];
  }
  const k = 70 / Math.max(...best, 1);
  return `rgb(${best.map((v) => Math.round(v * k)).join(",")})`;
}

// Music tab with something playing: the cover big on the right over its own colour.
function setStage(on) {
  document.body.classList.toggle("music-stage", on);
  if (!on) return;
  const src = cover();
  if (stageCover.dataset.src === src) return;
  stageCover.dataset.src = src;
  stageCover.classList.remove("loaded");
  stageCover.crossOrigin = "anonymous";
  stageCover.onload = () => {
    stageCover.classList.add("loaded");
    try {
      document.body.style.setProperty("--stage", coverTone(stageCover));
    } catch {
      document.body.style.removeProperty("--stage");
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
      state.editing = true;
      state.focus.edit = 0;
      render();
    },
  };
  return [...pinned, edit];
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
    view.replaceChildren(infoEl({ lead: el("div", { className: "lead-symbol" }, svg("music")), title: "Nada sonando", meta: "Pon música en Spotify, el navegador u otra app y se controla desde aquí." }));
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

function items() {
  if (state.editing) return editItems();
  return { games: gameItems, apps: appItems }[state.tab]();
}

function focusKey() {
  return state.editing ? "edit" : state.tab;
}

// ---------- render ----------

function infoEl(i) {
  const action = i.action && el("div", { className: "action" }, el("span", { textContent: i.action[0] }), glyph(i.action[1]));
  return el("section", { className: "info" },
    el("div", { className: "lead" }, i.lead),
    el("h1", { className: "title", textContent: i.title }),
    el("p", { className: "meta", textContent: i.meta }),
    action);
}

function render() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));

  // The focused game's art stays behind games and apps.
  const g = state.games[Math.min(state.focus.games, state.games.length - 1)];
  setHero(g && g.art.includes("hero") ? art(g, "hero") : "");
  setStage(state.tab === "music" && !!state.media.title && !!state.media.cover);

  if (state.tab === "music" && !state.editing) {
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
  const key = `${state.tab}|${state.editing}|` + list.map((x) => x.key).join("|");
  let strip = view.querySelector(".row, .grid");
  const headFor = () => {
    const head = state.editing
      ? infoEl({ lead: el("div", { className: "lead-symbol" }, svg("edit")), title: "Editar apps", meta: "", action: [state.pinned.includes(state.apps[at]?.id) ? "Quitar" : "Fijar", "A"] })
      : infoEl(list[at].info());
    head.dataset.item = state.editing ? "edit" : list[at].key + "|" + state.media.title + "|" + state.media.artist;
    return head;
  };
  if (!strip || strip.dataset.key !== key) {
    strip = el("div", { className: state.editing ? "grid" : "row" });
    strip.dataset.key = key;
    list.forEach((item) => strip.append(item.tile()));
    view.replaceChildren(headFor(), strip);
  } else if (state.editing) {
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

function renderPlayer() {
  const m = state.media;
  player.hidden = !m.title || state.tab === "music";
  if (player.hidden) return;
  const art = m.cover ? el("img", { className: "art", src: cover(), alt: "" }) : el("span", { className: "art" });
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
  if (!state.editing && (dir === "up" || dir === "down")) {
    changeVolume(invoke("volume_step", { delta: dir === "up" ? VOLUME_STEP : -VOLUME_STEP }));
    return;
  }
  if (state.tab === "music" && !state.editing) {
    state.focus.music = Math.max(0, Math.min(CONTROLS.length - 1, state.focus.music + (dir === "left" ? -1 : 1)));
    render();
    return;
  }
  const fk = focusKey();
  const count = items().length;
  let step = { left: -1, right: 1 }[dir] ?? 0;
  if (state.editing && (dir === "up" || dir === "down")) {
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
  if (state.editing) return;
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

function back() {
  if (state.editing) {
    state.editing = false;
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
  if (state.tab === "music" && !state.editing && state.media.title) return updateMusic();
  const toast = document.getElementById("volume-toast");
  toast.replaceChildren(...volumeEl().childNodes);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), VOLUME_TOAST_MS);
}

function onPress(button) {
  switch (button) {
    case "a":
      if (state.tab === "music" && !state.editing) {
        if (state.media.title) invoke("media_control", { action: CONTROLS[state.focus.music] });
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
  render();
}

listen("library", load);
listen("media", ({ payload }) => {
  state.media = payload;
  render();
});
listen("mode", ({ payload }) => {
  active = payload === "home";
  if (payload !== "home") return;
  state.editing = false;
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
