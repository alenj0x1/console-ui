// The guide: Inicio and the open windows (switch to one, close one) and the
// music, over a game or the desktop. A opens Inicio or switches, B goes back, Y closes the window, X plays
// or pauses, LT / RT change the song (as on the home screen). Menu opens the
// power menu; the controller's battery shows next to the clock.

const { invoke } = window.__TAURI__.core;
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
const listen = here.listen.bind(here);

// Served by the app (see home.rs); overridable for the dev harness.
const ASSET = window.__ASSET ?? "http://cui.localhost";
const CLOCK_EVERY_MS = 10_000;

const windowsEl = document.getElementById("windows");
const musicEl = document.getElementById("music");
const hintsEl = document.getElementById("hints");

const state = { windows: [], focus: 0, media: {}, active: false, battery: null, power: null, tvOn: false };

// The power menu: sleep at once; the rest need A held for a moment (a
// shaky double press never shuts the PC down). With TV mode on, its first
// row turns it off. Names and hold texts: guide.power.<id>(.hold).
const HOLD_MS = 1000;
const POWER = [
  { id: "tv", icon: "tv", tv: true },
  { id: "sleep", icon: "moon" },
  { id: "restart", icon: "restart", hold: true },
  { id: "shutdown", icon: "power", hold: true },
  { id: "signout", icon: "logout", hold: true },
];
const powerRows = () => POWER.filter((o) => !o.tv || state.tvOn);
const powerEl = document.getElementById("power");
const batteryEl = document.getElementById("battery");

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(Boolean));
  return e;
}

function svg(name, cls = "icon") {
  return el("span", { innerHTML: icon(name, cls), style: "display:contents" });
}

// Images fade in only once loaded; a failed one disappears.
function img(src, className = "") {
  const i = el("img", { alt: "", className, decoding: "async" });
  i.addEventListener("load", () => i.classList.add("loaded"));
  i.addEventListener("error", () => i.remove());
  i.src = src;
  return i;
}

function hint(key, text, cls = "") {
  return el("span", { className: `hint ${cls}` }, setGlyph(el("span", { className: "glyph" }), key), text);
}

// The first tile opens Inicio; the open windows follow (the focus starts on
// the window in front).
function homeTile() {
  return el("div", { className: "window home" },
    el("div", { className: "shot" }, svg("home", "icon big")),
    el("div", { className: "label" }, svg("home"), el("span", { className: "title", textContent: t("guide.home") })));
}

// Built once per list; moving only changes which tile is marked, so the
// pictures never reload (and never flash).
function renderWindows() {
  if (!state.windows.length) {
    windowsEl.replaceChildren(
      homeTile(),
      el("div", { className: "empty" },
        el("div", { className: "box" }, svg("window-maximize")),
        el("div", {}, el("b", { textContent: t("guide.no_windows") }), el("span", { textContent: t("guide.no_windows_hint") })),
      ),
    );
    markFocus();
    return;
  }
  windowsEl.replaceChildren(
    homeTile(),
    ...state.windows.map((w) => {
      const id = encodeURIComponent(w.id);
      const shot = el("div", { className: "shot" }, img(`${ASSET}/window-icon/${id}`, "big"));
      if (!w.minimized) shot.append(img(`${ASSET}/window-shot/${id}`, "picture"));
      return el("div", { className: "window" },
        shot,
        el("div", { className: "label" },
          img(`${ASSET}/window-icon/${id}`),
          el("span", { className: "title", textContent: w.title }),
          w.game ? el("span", { className: "kind" }, svg("gamepad")) : null,
        ),
      );
    }),
  );
  markFocus();
}

function markFocus() {
  [...windowsEl.children].forEach((t, i) => t.classList.toggle("on", i === state.focus));
  windowsEl.children[state.focus]?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

// The music card is built once and then only its text, play icon and cover
// change; a new cover replaces the old one once it has loaded.
const music = {
  art: el("img", { alt: "", className: "art" }),
  title: el("b"),
  artist: el("span"),
  play: el("span", { className: "transport-button" }),
  cover: null,
  playing: null,
  // The next cover, until it has replaced the shown one.
  loading: Promise.resolve(),
};
musicEl.append(
  music.art,
  el("div", { className: "text" }, music.title, music.artist),
  el("div", { className: "transport" },
    el("span", { className: "transport-button" }, svg("prev")),
    music.play,
    el("span", { className: "transport-button" }, svg("next")),
  ),
);

function renderMusic() {
  const m = state.media;
  musicEl.hidden = !m.title;
  if (!m.title) return;
  if (music.title.textContent !== m.title) music.title.textContent = m.title;
  if (music.artist.textContent !== m.artist) music.artist.textContent = m.artist;
  if (music.playing !== m.playing) {
    music.playing = m.playing;
    music.play.replaceChildren(svg(m.playing ? "pause" : "play"));
  }
  if (music.cover !== m.cover) {
    music.cover = m.cover;
    const next = new Image();
    next.src = `${ASSET}/cover?r=${m.cover}`;
    music.loading = next.decode().then(() => {
      if (music.cover === m.cover) music.art.src = next.src;
    }, () => {});
  }
}

// state.power: null (closed) or { focus, timer } (timer: A is being held).
function renderPower() {
  const p = state.power;
  powerEl.hidden = !p;
  if (!p) return;
  powerEl.replaceChildren(...powerRows().map((o, i) => {
    const on = i === p.focus;
    const label = el("span");
    label.append(...(on && o.hold ? withButtons(t(`guide.power.${o.id}.hold`), false) : [t(`guide.power.${o.id}`)]));
    return el("div", { className: `row${on ? " on" : ""}${on && p.timer ? " holding" : ""}` }, svg(o.icon), label);
  }));
}

function renderBattery() {
  const b = state.battery;
  batteryEl.hidden = !b;
  if (!b) return;
  // Up to three bars inside the battery outline.
  const bars = [7, 10, 13].slice(0, b.wired ? 0 : b.level).map((x) => `<path d="M${x} 10v4"/>`).join("");
  const mark = b.wired ? icon("plug") : icon("battery").replace("</svg>", `${bars}</svg>`);
  batteryEl.classList.toggle("low", !b.wired && b.level <= 1);
  batteryEl.innerHTML = `${mark}<span>${b.wired ? t("guide.battery.wired") : t(`guide.battery.${b.level}`)}</span>`;
}

let hintsKey = "";
function renderHints() {
  const key = `${!!state.power}|${!!focused()}|${!!state.media.title}|${!!state.media.playing}|${!!Prefs.get()?.swap_ab}|${JSON.stringify(Prefs.get()?.button_map ?? {})}`;
  if (key === hintsKey) return;
  hintsKey = key;
  if (state.power) {
    hintsEl.replaceChildren(hint("A", t("guide.choose")), hint("B", t("guide.close"), "back"));
    return;
  }
  const parts = [];
  if (focused()) parts.push(hint("A", t("guide.go")), hint("Y", t("guide.close_window")));
  else parts.push(hint("A", t("guide.open")));
  if (state.media.title) parts.push(hint("X", t(state.media.playing ? "guide.pause" : "guide.play")), hint("LT RT", t("guide.change_song")));
  parts.push(hint("Menu", t("guide.power_menu")), hint("B", t("guide.close"), "back"));
  hintsEl.replaceChildren(...parts);
}

function render() {
  renderWindows();
  renderMusic();
  renderHints();
}

// state.focus: 0 is Inicio, then the windows.
function move(d) {
  state.focus = Math.max(0, Math.min(state.windows.length, state.focus + d));
  markFocus();
  renderHints();
}

const focused = () => state.windows[state.focus - 1];

function powerRun(o) {
  state.power = null;
  if (o.tv) invoke("tv_set", { on: false }).catch(console.error);
  else invoke("guide_power", { action: o.id }).catch(console.error);
  renderPower();
  renderHints();
}

function powerPress(button) {
  const p = state.power;
  if (button === "a") {
    const o = powerRows()[p.focus];
    if (!o.hold) return powerRun(o);
    if (!p.timer) p.timer = setTimeout(() => powerRun(o), HOLD_MS);
  } else if (button === "b") {
    clearTimeout(p.timer);
    state.power = null;
  }
  renderPower();
  renderHints();
}

// Letting go of A before the moment is up does nothing.
function powerRelease(button) {
  const p = state.power;
  if (button !== "a" || !p?.timer) return;
  clearTimeout(p.timer);
  p.timer = 0;
  renderPower();
}

function powerMove(d) {
  const p = state.power;
  clearTimeout(p.timer);
  p.timer = 0;
  p.focus = Math.max(0, Math.min(powerRows().length - 1, p.focus + d));
  renderPower();
}

function onPress(button) {
  // Menu (a tap) opens and closes the power menu.
  if (button === "menu") {
    clearTimeout(state.power?.timer);
    state.power = state.power ? null : { focus: 0, timer: 0 };
    renderPower();
    return renderHints();
  }
  if (state.power) return powerPress(button);
  const music = (action) => state.media.title && invoke("media_control", { action }).catch(console.error);
  switch (button) {
    case "a":
      if (focused()) invoke("guide_switch", { id: focused().id }).catch(console.error);
      else invoke("guide_home").catch(console.error);
      break;
    case "b":
      invoke("guide_back").catch(console.error);
      break;
    case "y":
      if (!focused()) break;
      invoke("guide_close_window", { id: focused().id }).catch(console.error);
      state.windows.splice(state.focus - 1, 1);
      if (state.windows.length) windowsEl.children[state.focus].remove();
      state.focus = Math.min(state.focus, state.windows.length);
      if (state.windows.length) markFocus();
      else renderWindows();
      renderHints();
      break;
    case "x":
      music("toggle");
      break;
    case "lt":
      music("prev");
      break;
    case "rt":
      music("next");
      break;
  }
}


listen("pad", ({ payload }) => {
  if (!state.active) return;
  if (payload.kind === "nav" && payload.source !== "right" && state.power) {
    if (payload.dir === "up") powerMove(-1);
    else if (payload.dir === "down") powerMove(1);
  } else if (payload.kind === "nav" && payload.source !== "right") {
    if (payload.dir === "left") move(-1);
    else if (payload.dir === "right") move(1);
  } else if (payload.kind === "press") onPress(payload.button);
  else if (payload.kind === "release" && state.power) powerRelease(payload.button);
});

// Waits for the images in the page to be decoded (or a short while).
function imagesReady(ms) {
  const all = [...document.querySelectorAll("img")].filter((i) => i.src).map((i) => i.decode().catch(() => {}));
  all.push(music.loading);
  return Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, ms))]);
}

// The host took the pictures: draw the new list and the music, then ask to
// be shown, so the last list never flashes on screen.
listen("windows", async () => {
  const [windows, media] = await Promise.all([invoke("guide_windows"), invoke("media_now")]);
  state.windows = windows;
  state.media = media;
  state.focus = windows.length ? 1 : 0;
  render();
  await imagesReady(400);
  invoke("guide_ready").catch(console.error);
});
listen("media", ({ payload }) => {
  state.media = payload;
  renderMusic();
  renderHints();
});
listen("mode", ({ payload }) => {
  state.active = payload === "guide";
  // Closing: draw nothing, so the next open never starts on this list.
  if (!state.active) {
    state.power = null;
    powerEl.hidden = true;
    state.windows = [];
    windowsEl.replaceChildren();
    musicEl.hidden = true;
  }
});

function tick() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString(I18n.lang(), { hour: "2-digit", minute: "2-digit" });
}
tick();
setInterval(tick, CLOCK_EVERY_MS);
invoke("current_mode").then((m) => (state.active = m === "guide"));
window.__TAURI__.event.listen("tv", ({ payload }) => (state.tvOn = payload));
invoke("tv_state").then((t) => (state.tvOn = t.on)).catch(() => {});
listen("battery", ({ payload }) => {
  state.battery = payload;
  renderBattery();
});
invoke("pad_battery").then((b) => {
  state.battery = b;
  renderBattery();
});
// Another interface language: everything drawn again in it.
I18n.watch(() => {
  hintsKey = "";
  if (state.active) render();
  renderPower();
  renderBattery();
  tick();
});
