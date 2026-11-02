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

const TUNE = [
  { pref: "cursor_speed", name: "Velocidad del puntero", options: [[70, "Lenta"], [100, "Normal"], [140, "Rápida"]] },
  { pref: "deadzone", name: "Ignorar movimientos pequeños", options: [[8, "Poco"], [12, "Normal"], [18, "Mucho"]] },
];
function tuneStep(next) {
  const rows = TUNE.flatMap((t) => {
    const choice = el("div", { className: "choice" });
    const paint = () => [...choice.children].forEach((b) => b.classList.toggle("sel", Number(b.dataset.v) === Prefs.get()?.[t.pref]));
    for (const [v, label] of t.options) {
      const b = el("button", { textContent: label });
      b.dataset.v = v;
      b.addEventListener("click", () => invoke("set_preference", { name: t.pref, value: v }).catch(console.error));
      choice.append(b);
    }
    paint();
    Prefs.watch(paint);
    return [el("span", { className: "name", textContent: t.name }), choice];
  });
  const go = el("button", { className: "action", textContent: "Seguir" });
  go.addEventListener("click", next);
  area.replaceChildren(el("div", { className: "tune" }, ...rows), go);
}

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function typeStep(next) {
  const field = el("input", { className: "field", spellcheck: false, autocomplete: "off", placeholder: "hola" });
  const mark = doneMark("Enviado");
  // hola, then RT (Enter) to send it, then B closes the keyboard.
  let typed = false, sent = false;
  field.addEventListener("input", () => {
    if (typed || !fold(field.value).includes("hola")) return;
    typed = true;
    lineEl.replaceChildren(...say("Presiona {RT} para enviarlo."));
  });
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !typed || sent) return;
    sent = true;
    mark.hidden = false;
    lineEl.replaceChildren(...say("Presiona {B} para cerrar el teclado."));
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
    el("li", {}, ...say("Con {LT} presionado, la cruceta salta de un botón a otro.")),
    el("li", {}, ...say("Mantén {View} para el menú rápido. Apunta con la palanca derecha y suelta.")),
    el("li", {}, ...say("En un juego, mantén {View} + {Menu} para el centro de control.")),
    el("li", {}, ...say("Todo esto se cambia en Ajustes, dentro de Inicio.")));
  const go = el("button", { className: "action", textContent: "Empezar" });
  go.addEventListener("click", finish);
  area.replaceChildren(tips, go);
}

const STEPS = [
  { title: "Hola", line: "Mueve el puntero con la palanca izquierda y presiona {A} sobre cada círculo.", run: pointStep },
  { title: "Cómo se siente el puntero", line: "Elige con {A}. Se aplica al instante, así que puedes probar.", run: tuneStep },
  { title: "El teclado", line: "Presiona {Y} para abrirlo y escribe hola.", run: typeStep },
  { title: "Inicio", line: "Mantén {Menu} para abrir Inicio, con tus juegos y apps. Presiona {B} para volver aquí.", run: (next) => roundTrip("home", next) },
  { title: "Centro de control", line: "Presiona {View}. Ahí cambias de ventana, manejas la música y apagas la computadora. {B} vuelve.", run: (next) => roundTrip("guide", next) },
  { title: "Listo", line: "", run: endStep },
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

let at = -1;
function step() {
  at++;
  modeWait = null;
  const s = STEPS[at];
  titleEl.textContent = s.title;
  lineEl.replaceChildren(...say(s.line));
  s.run(step);
}

function finish() {
  invoke("welcome_done").catch(console.error);
}
document.getElementById("skip").addEventListener("click", finish);

step();
