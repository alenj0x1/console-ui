// The welcome: a few steps you finish by doing them with the controller.
// Point and click, how the pointer feels (speed and small movements, as in
// Ajustes), the keyboard, Inicio and the control centre; then what else the
// controller does. Saltar ends it at any time. The page follows the app's
// modes ("mode" events) to know when a step was done.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const titleEl = document.getElementById("title");
const lineEl = document.getElementById("line");
const area = document.getElementById("area");

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(Boolean));
  return e;
}

// Text with the controller's buttons drawn ("{A}"), as they are now.
const say = (text) => withButtons(text, false);

function doneMark(text) {
  return el("div", { className: "done", hidden: true, innerHTML: icon("check") }, el("span", { textContent: text }));
}

// ---------- the steps ----------

// Three targets, one after the other, in different places.
const SPOTS = [[0.08, 0.15], [0.62, 0.55], [0.36, 0.05]];
function pointStep(next) {
  let hit = 0;
  const place = () => {
    const t = el("div", { className: "target" });
    const [x, y] = SPOTS[hit];
    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.addEventListener("click", () => {
      hit++;
      if (hit < SPOTS.length) place();
      else next();
    });
    area.replaceChildren(t);
  };
  place();
}

// Names: welcome.<pref> and welcome.<pref>.<value>.
const TUNE = [
  { pref: "cursor_speed", options: [70, 100, 140] },
  { pref: "deadzone", options: [8, 12, 18] },
];
function tuneStep(next) {
  const rows = TUNE.flatMap((o) => {
    const choice = el("div", { className: "choice" });
    const paint = () => [...choice.children].forEach((b) => b.classList.toggle("sel", Number(b.dataset.v) === Prefs.get()?.[o.pref]));
    for (const v of o.options) {
      const b = el("button", { textContent: t(`welcome.${o.pref}.${v}`) });
      b.dataset.v = v;
      b.addEventListener("click", () => invoke("set_preference", { name: o.pref, value: v }).catch(console.error));
      choice.append(b);
    }
    paint();
    Prefs.watch(paint);
    return [el("span", { className: "name", textContent: t(`welcome.${o.pref}`) }), choice];
  });
  const go = el("button", { className: "action", textContent: t("welcome.next") });
  go.addEventListener("click", next);
  area.replaceChildren(el("div", { className: "tune" }, ...rows), go);
}

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function typeStep(next) {
  const field = el("input", { className: "field", spellcheck: false, autocomplete: "off", placeholder: t("welcome.word") });
  const mark = doneMark(t("welcome.sent"));
  // The word (hola), then RT (Enter) to send it, then B closes the keyboard.
  let typed = false, sent = false;
  field.addEventListener("input", () => {
    if (typed || !fold(field.value).includes(fold(t("welcome.word")))) return;
    typed = true;
    setLine("welcome.send");
  });
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !typed || sent) return;
    sent = true;
    mark.hidden = false;
    setLine("welcome.close_keyboard");
  });
  area.replaceChildren(field, el("div", {}, mark));
  field.focus();
  waitMode((m) => sent && m === "cursor", next);
}

// Done once the app went to `there` and came back to the cursor.
function roundTrip(there, next) {
  let went = false;
  waitMode((m) => {
    if (m === there) went = true;
    return went && m === "cursor";
  }, next);
  area.replaceChildren();
}

function endStep() {
  const tips = el("ul", { className: "tips" },
    ...["jump", "radial", "guide", "settings"].map((k) => el("li", {}, ...say(t(`welcome.tip.${k}`)))));
  const go = el("button", { className: "action", textContent: t("welcome.start") });
  go.addEventListener("click", finish);
  area.replaceChildren(tips, go);
}

// Texts: welcome.<id>.title and welcome.<id>.line.
const STEPS = [
  { id: "point", run: pointStep },
  { id: "tune", run: tuneStep },
  { id: "type", run: typeStep },
  { id: "home", run: (next) => roundTrip("home", next) },
  { id: "guide", run: (next) => roundTrip("guide", next) },
  { id: "done", run: endStep },
];

let modeWait = null;
function waitMode(test, then) {
  modeWait = { test, then };
}
listen("mode", ({ payload }) => {
  const w = modeWait;
  if (w && w.test(payload)) {
    modeWait = null;
    w.then();
  }
});

// The line under the title (a key), kept to draw it again in another language.
let lineKey = "";
function setLine(key) {
  lineKey = key;
  lineEl.replaceChildren(...say(key ? t(key, { word: t("welcome.word") }) : ""));
}

let at = -1;
function step() {
  at++;
  modeWait = null;
  const s = STEPS[at];
  titleEl.textContent = t(`welcome.${s.id}.title`);
  setLine(s.id === "done" ? "" : `welcome.${s.id}.line`);
  s.run(step);
}

// Another interface language: the step's texts follow, keeping its progress.
I18n.watch(() => {
  const s = STEPS[at];
  titleEl.textContent = t(`welcome.${s.id}.title`);
  setLine(lineKey);
  if (s.run === tuneStep || s.run === endStep) s.run(step);
  area.querySelector(".field")?.setAttribute("placeholder", t("welcome.word"));
  const sent = area.querySelector(".done span");
  if (sent) sent.textContent = t("welcome.sent");
});

function finish() {
  invoke("welcome_done").catch(console.error);
}
document.getElementById("skip").addEventListener("click", finish);

step();
