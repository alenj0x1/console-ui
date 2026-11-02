// Typing lab. `?exp=layouts` compares grid vs split, `?exp=suggest` the grid
// with and without word suggestions. Two warm-up blocks, then ABBA scored
// blocks of 3 phrases. Per phrase: words per minute, error rate (minimum
// string distance), controller actions per character and backspaces; 1–5
// rating per scored block. Text arrives through the real pipeline: overlay →
// SendInput.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const EXPERIMENTS = {
  layouts: {
    grid: { label: "Cuadrícula", layout: "grid", suggest: false },
    split: { label: "Dos mitades", layout: "split", suggest: false },
  },
  suggest: {
    plain: { label: "Sin sugerencias", layout: "grid", suggest: false },
    suggest: { label: "Con sugerencias", layout: "grid", suggest: true },
  },
};
const experiment = new URLSearchParams(location.search).get("exp") === "suggest" ? "suggest" : "layouts";
const CONDITIONS = EXPERIMENTS[experiment];
const [COND_A, COND_B] = Object.keys(CONDITIONS);
const WARMUP_PHRASES = 2;
const SCORED_PHRASES = 3;

const PHRASES = [
  "el gato duerme en la ventana",
  "mañana vamos a jugar en línea",
  "pon música tranquila por favor",
  "la partida empieza en diez minutos",
  "abre el navegador y busca recetas",
  "hoy quiero ver una película",
  "el control está cerca del sofá",
  "busca el disco nuevo de la banda",
  "guarda la partida antes de salir",
  "el café se enfrió otra vez",
  "sube el volumen un poco más",
  "vamos a pedir pizza esta noche",
  "la pantalla se ve muy bien",
  "escribe un mensaje a tu amigo",
  "el juego tiene un mapa enorme",
  "cambia de canción cuando quieras",
  "la lluvia no para desde ayer",
  "apaga la luz de la sala",
  "mi equipo ganó el último partido",
  "revisa el correo en la tarde",
  "el perro quiere salir a caminar",
  "compra pan y leche en la tienda",
  "la batería del control está baja",
  "necesito descargar la actualización",
];

const stage = document.getElementById("stage");
const progressFill = document.getElementById("progress-fill");

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const phrases = shuffle([...PHRASES]);
const first = Math.random() < 0.5 ? COND_A : COND_B;
const second = first === COND_A ? COND_B : COND_A;
const blocks = [
  ...shuffle([COND_A, COND_B]).map((cond) => ({ cond, warmup: true, n: WARMUP_PHRASES })),
  ...[first, second, second, first].map((cond) => ({ cond, warmup: false, n: SCORED_PHRASES })),
];

// Controller actions reported by the keyboard (keys, moves, suggestions).
const actions = { count: 0, accepts: 0 };
listen("kb-action", ({ payload }) => {
  actions.count++;
  if (payload === "accept") actions.accepts++;
});
const totalPhrases = blocks.reduce((s, b) => s + b.n, 0);

const trials = [];
const ratings = [];
let done = 0;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function setProgress() {
  progressFill.style.width = `${(done / totalPhrases) * 100}%`;
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

async function intro() {
  await invoke("set_mode", { mode: "cursor" });
  const start = el("button", { className: "button", textContent: "Empezar" });
  start.addEventListener("click", () => runBlock(0));
  stage.replaceChildren(
    el("h1", { textContent: "Laboratorio del teclado" }),
    el("p", {
      className: "lead",
      textContent:
        experiment === "suggest"
          ? "Escribe cada frase y presiona Menu para enviarla. Primero una ronda de práctica sin y con sugerencias, luego cuatro que cuentan. Con sugerencias, Vista elige la primera y arriba en la cruceta llegas a las demás."
          : "Escribe cada frase y presiona Menu para enviarla. Primero una ronda de práctica con cada teclado y luego cuatro que cuentan. Mantén A (o el gatillo) sobre una vocal para la tilde.",
    }),
    start,
  );
}

async function runBlock(i) {
  const c = CONDITIONS[blocks[i].cond];
  await invoke("set_layout", { layout: c.layout });
  await invoke("set_suggest", { on: c.suggest });
  await invoke("set_mode", { mode: "keyboard" });
  runPhrase(i, 0);
}

function runPhrase(bi, pi) {
  const block = blocks[bi];
  const target = phrases.shift();
  const input = el("input", { className: "typed", spellcheck: false, autocomplete: "off" });
  stage.replaceChildren(
    el("p", { className: "layout-name", textContent: block.warmup ? `${CONDITIONS[block.cond].label} · práctica` : CONDITIONS[block.cond].label }),
    el("p", { className: "phrase", textContent: target }),
    input,
  );
  input.focus();

  let started = 0;
  let backspaces = 0;
  const actionsAt = { ...actions };
  input.addEventListener("beforeinput", (e) => {
    if (!started) started = performance.now();
    if (e.inputType === "deleteContentBackward") backspaces++;
  });
  // Keep focus here even if something steals it.
  input.addEventListener("blur", () => setTimeout(() => input.focus(), 0));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const typed = input.value.trim();
    if (!typed) return;
    const secs = (performance.now() - started) / 1000;
    trials.push({
      cond: block.cond,
      warmup: block.warmup,
      block: bi,
      target,
      typed,
      seconds: secs,
      wpm: (Math.max(typed.length - 1, 0) / 5) / (secs / 60),
      error_rate: distance(target, typed) / Math.max(target.length, typed.length),
      // Enter itself is one of the actions.
      kspc: (actions.count - actionsAt.count) / typed.length,
      accepts: actions.accepts - actionsAt.accepts,
      backspaces,
    });
    done++;
    setProgress();
    if (pi + 1 < block.n) runPhrase(bi, pi + 1);
    else if (block.warmup) bi + 1 < blocks.length ? runBlock(bi + 1) : finish();
    else rate(bi);
  });
}

async function rate(bi) {
  await invoke("set_mode", { mode: "cursor" });
  const block = blocks[bi];
  const row = el("div", { className: "rating-row" });
  for (let n = 1; n <= 5; n++) {
    const b = el("button", { textContent: String(n) });
    b.addEventListener("click", () => {
      ratings.push({ cond: block.cond, block: bi, rating: n });
      bi + 1 < blocks.length ? runBlock(bi + 1) : finish();
    });
    row.append(b);
  }
  stage.replaceChildren(
    el("h1", { textContent: `¿Qué tal se sintió ${CONDITIONS[block.cond].label.toLowerCase()}?` }),
    el("div", { className: "rating" }, row, el("div", { className: "rating-ends" }, el("span", { textContent: "Incómodo" }), el("span", { textContent: "Natural" }))),
  );
}

function summarize() {
  return Object.keys(CONDITIONS).map((cond) => {
    const t = trials.filter((x) => x.cond === cond && !x.warmup);
    const r = ratings.filter((x) => x.cond === cond);
    const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
    return {
      cond,
      phrases: t.length,
      wpm: avg(t.map((x) => x.wpm)),
      error_rate: avg(t.map((x) => x.error_rate)),
      kspc: avg(t.map((x) => x.kspc)),
      accepts: t.reduce((s, x) => s + x.accepts, 0),
      rating: avg(r.map((x) => x.rating)),
    };
  });
}

async function finish() {
  await invoke("set_mode", { mode: "cursor" });
  done = totalPhrases;
  setProgress();
  const summary = summarize();
  let saved;
  try {
    saved = "Guardado en " + (await invoke("lab_save", { json: JSON.stringify({ experiment, conditions: CONDITIONS, blocks, trials, ratings, summary }, null, 2) }));
  } catch (e) {
    saved = "No se pudo guardar: " + e;
  }
  const head = el("tr", {}, ...["Variante", "Palabras/min", "Errores", "Acciones/letra", "Nota"].map((t) => el("th", { textContent: t })));
  const rows = summary.map((s) =>
    el(
      "tr",
      {},
      el("td", { textContent: CONDITIONS[s.cond].label }),
      el("td", { textContent: s.wpm.toFixed(1) }),
      el("td", { textContent: (s.error_rate * 100).toFixed(1) + " %" }),
      el("td", { textContent: s.kspc.toFixed(2) }),
      el("td", { textContent: s.rating.toFixed(1) }),
    ),
  );
  stage.replaceChildren(el("h1", { textContent: "Resultados" }), el("table", {}, head, ...rows), el("p", { className: "saved", textContent: saved }));
}

intro();
