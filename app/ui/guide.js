// The guide: open windows (switch to one, close one) and the music, over a
// game or the desktop. A switches, B goes back, Y closes the window, X plays
// or pauses, LT / RT change the song (as on the home screen).

const { invoke } = window.__TAURI__.core;
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
const listen = here.listen.bind(here);

const ASSET = "http://cui.localhost";
const CLOCK_EVERY_MS = 10_000;

const windowsEl = document.getElementById("windows");
const musicEl = document.getElementById("music");
const hintsEl = document.getElementById("hints");

const state = { windows: [], focus: 0, media: {}, active: false };

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

// Built once per list; moving only changes which tile is marked, so the
// pictures never reload (and never flash).
function renderWindows() {
  if (!state.windows.length) {
    windowsEl.replaceChildren(
      el("div", { className: "empty" },
        el("div", { className: "box" }, svg("window-maximize")),
        el("div", {}, el("b", { textContent: "No hay ventanas abiertas" }), el("span", { textContent: "Las ventanas que abras aparecen aquí." })),
      ),
    );
    return;
  }
  windowsEl.replaceChildren(
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

let hintsKey = "";
function renderHints() {
  const key = `${state.windows.length > 0}|${!!state.media.title}|${!!state.media.playing}|${!!Prefs.get()?.swap_ab}|${JSON.stringify(Prefs.get()?.button_map ?? {})}`;
  if (key === hintsKey) return;
  hintsKey = key;
  const parts = [];
  if (state.windows.length) parts.push(hint("A", "Cambiar"), hint("Y", "Cerrar ventana"));
  if (state.media.title) parts.push(hint("X", state.media.playing ? "Pausar" : "Reproducir"), hint("LT RT", "Canción"));
  parts.push(hint("B", "Volver", "back"));
  hintsEl.replaceChildren(...parts);
}

function render() {
  renderWindows();
  renderMusic();
  renderHints();
}

function move(d) {
  if (!state.windows.length) return;
  state.focus = Math.max(0, Math.min(state.windows.length - 1, state.focus + d));
  markFocus();
}

const focused = () => state.windows[state.focus];

function onPress(button) {
  const music = (action) => state.media.title && invoke("media_control", { action }).catch(console.error);
  switch (button) {
    case "a":
      if (focused()) invoke("guide_switch", { id: focused().id }).catch(console.error);
      break;
    case "b":
      invoke("guide_back").catch(console.error);
      break;
    case "y":
      if (!focused()) break;
      invoke("guide_close_window", { id: focused().id }).catch(console.error);
      state.windows.splice(state.focus, 1);
      if (state.windows.length) windowsEl.children[state.focus].remove();
      state.focus = Math.min(state.focus, Math.max(0, state.windows.length - 1));
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
  if (payload.kind === "nav" && payload.source !== "right") {
    if (payload.dir === "left") move(-1);
    else if (payload.dir === "right") move(1);
  } else if (payload.kind === "press") onPress(payload.button);
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
  state.focus = 0;
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
    state.windows = [];
    windowsEl.replaceChildren();
    musicEl.hidden = true;
  }
});

function tick() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}
tick();
setInterval(tick, CLOCK_EVERY_MS);
invoke("current_mode").then((m) => (state.active = m === "guide"));
