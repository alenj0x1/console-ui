// On-screen keyboard driven by controller events from the engine ("pad").
// Two layouts: "grid" (one highlight, QWERTY) and "split" (one highlight per
// stick, typed with LT / RT). Keys are typed into whatever window has focus.
// A suggestion strip completes the current word, restores accents and, with
// nothing typed yet, predicts the next word. The language key (L3) opens a
// small menu to choose suggestion languages and to forget learned words.

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

const HOLD_MS = 350;
const BACK_DELAY_MS = 400;
const BACK_EVERY_MS = 70;
const FLASH_MS = 120;
const SLOTS = 3;

// Hold the type button on these keys to get the variant.
const VARIANTS = { a: "á", e: "é", i: "í", o: "ó", u: "ú", "?": "¿", "!": "¡" };
// Typing one of these ends a sentence: the next word starts fresh.
const SENTENCE_END = /[.!?¡¿]/;

const ROWS = {
  grid: ["qwertyuiop", "asdfghjklñ", "zxcvbnm,."],
  gridSym: ["1234567890", "@#$%&*-+()", "¿?¡!\"':;/"],
  left: ["qwert", "asdfg", "zxcvb"],
  right: ["yuiop", "hjklñ", "nm,.-"],
  leftSym: ["12345", "@#$%&", "¿?¡!\""],
  rightSym: ["67890", "*-+()", "':;/_"],
};

const ACTIONS = {
  shift: { label: "Mayús", glyph: "LB", width: 96 },
  sym: { label: "?123", glyph: "RB", width: 96 },
  lang: { glyph: "L3", width: 88 },
  space: { label: "Espacio", glyph: "Y", width: 196 },
  back: { label: "Borrar", glyph: "X", width: 124 },
  enter: { label: "Intro", glyph: "Menu", width: 124 },
};
const SPLIT_ACTIONS = ["shift", "sym", "lang", "space", "back", "enter"];

const LANGUAGE_NAMES = { es: "Español", en: "English" };

const state = {
  layout: loadLayout(),
  shift: false,
  sym: false,
  suggest: true,
  // The word being typed and the one before it, as far as this keyboard knows
  // (it cannot read the field). prev: a word, START, or "" when unknown.
  word: "",
  prev: START,
  suggestions: [],
  // Password field focused: no suggestions, nothing learned.
  private: false,
  languages: ["es"],
  available: ["es"],
  learn: false,
  // Language menu: null when closed, else { focus, confirmForget }.
  menu: null,
  grid: { r: 2, c: 4 },
  left: { r: 1, c: 3 },
  right: { r: 1, c: 1 },
};

const panel = document.getElementById("panel");
const suggester = new Suggester();
const loaded = new Set();
const holds = {};
let backTimer = null;

function loadLayout() {
  try {
    return localStorage.getItem("layout") === "split" ? "split" : "grid";
  } catch {
    return "grid";
  }
}

function saveLayout() {
  try {
    localStorage.setItem("layout", state.layout);
  } catch {}
}

// ---------- languages and learning ----------

async function loadLanguage(lang) {
  if (loaded.has(lang)) return;
  loaded.add(lang);
  const [words, pairs] = await Promise.all([
    fetch(`data/words-${lang}.txt`).then((r) => r.text()),
    fetch(`data/pairs-${lang}.tsv`).then((r) => r.text()),
  ]);
  if (state.languages.includes(lang)) suggester.addLanguage(lang, words, pairs);
  else loaded.delete(lang);
}

async function applyLanguages() {
  for (const lang of state.available) {
    if (!state.languages.includes(lang)) {
      suggester.removeLanguage(lang);
      loaded.delete(lang);
    }
  }
  await Promise.all(state.languages.map(loadLanguage));
  refresh();
}

async function init() {
  const cfg = await invoke("keyboard_config");
  state.languages = cfg.languages;
  state.available = cfg.available;
  state.learn = cfg.learn;
  suggester.setLearned(cfg.learned);
  await applyLanguages();
}

async function checkPrivate() {
  state.private = await invoke("focus_is_password");
  refresh();
}

// A word was finished (space, punctuation, enter or a suggestion).
function finishWord(word) {
  const w = word.toLowerCase();
  if (state.learn && !state.private && Suggester.learnable(w)) {
    suggester.learn(state.prev, w);
    invoke("learn_word", { prev: state.prev, word: w });
  }
  state.prev = Suggester.learnable(w) ? w : "";
}

// ---------- model ----------

function chars(row) {
  return [...row].map((ch) => ({ type: "char", ch }));
}

function stripRow() {
  return Array.from({ length: SLOTS }, (_, i) => ({ type: "suggest", i }));
}

function gridRows() {
  const r = state.sym ? ROWS.gridSym : ROWS.grid;
  return [
    ...(state.suggest ? [stripRow()] : []),
    chars(r[0]),
    chars(r[1]),
    [{ type: "action", id: "shift" }, ...chars(r[2])],
    ["sym", "lang", "space", "back", "enter"].map((id) => ({ type: "action", id })),
  ];
}

function halfRows(side) {
  const r = state.sym ? ROWS[side + "Sym"] : ROWS[side];
  return r.map(chars);
}

function focusedKey(where) {
  const pos = state[where];
  const rows = where === "grid" ? gridRows() : halfRows(where);
  return rows[pos.r]?.[pos.c];
}

function menuItems() {
  return [
    ...state.available.map((lang) => ({ kind: "lang", lang })),
    { kind: "forget" },
    { kind: "done" },
  ];
}

// ---------- render ----------

function glyphEl(text) {
  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.textContent = text;
  return glyph;
}

function keyEl(key, id, focused) {
  const el = document.createElement("div");
  el.className = "key";
  el.dataset.id = id;
  if (focused) el.classList.add("on");
  if (key.type === "suggest") {
    const word = state.suggestions[key.i];
    el.classList.add("suggestion");
    const label = document.createElement("span");
    label.textContent = word ?? "";
    el.append(label);
    if (word && key.i === 0) el.append(glyphEl(state.layout === "grid" ? "RT" : "View"));
  } else if (key.type === "char") {
    el.textContent = state.shift ? key.ch.toUpperCase() : key.ch;
    if (VARIANTS[key.ch]) {
      const alt = document.createElement("span");
      alt.className = "alt";
      alt.textContent = VARIANTS[key.ch];
      el.append(alt);
    }
  } else {
    const a = ACTIONS[key.id];
    el.classList.add("action");
    el.style.width = a.width + "px";
    if ((key.id === "shift" && state.shift) || (key.id === "sym" && state.sym)) el.classList.add("active");
    const label = document.createElement("span");
    label.textContent =
      key.id === "lang" ? state.languages.map((l) => l.toUpperCase()).join(" · ") : key.id === "sym" && state.sym ? "abc" : a.label;
    el.append(label, glyphEl(a.glyph));
  }
  return el;
}

function rowEl(keys, prefix, r, focus, extraClass) {
  const row = document.createElement("div");
  row.className = "row" + (extraClass ? " " + extraClass : "");
  keys.forEach((k, c) => row.append(keyEl(k, `${prefix}-${r}-${c}`, focus && focus.r === r && focus.c === c)));
  return row;
}

function renderMenu() {
  const list = document.createElement("div");
  list.className = "menu";
  menuItems().forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "menu-item";
    if (state.menu.focus === i) el.classList.add("on");
    if (item.kind === "lang") {
      const box = document.createElement("span");
      box.className = "check" + (state.languages.includes(item.lang) ? " checked" : "");
      const label = document.createElement("span");
      label.textContent = LANGUAGE_NAMES[item.lang] ?? item.lang;
      el.append(box, label);
    } else if (item.kind === "forget") {
      el.classList.add("danger");
      el.textContent = state.menu.confirmForget ? "Confirmar: olvidar palabras aprendidas" : "Olvidar palabras aprendidas";
    } else {
      el.append(Object.assign(document.createElement("span"), { textContent: "Listo" }), glyphEl("L3"));
    }
    list.append(el);
  });
  panel.append(list);
}

function render() {
  panel.replaceChildren();
  panel.classList.toggle("is-menu", !!state.menu);
  if (state.menu) return renderMenu();
  if (state.layout === "grid") {
    gridRows().forEach((keys, r) => panel.append(rowEl(keys, "grid", r, state.grid, state.suggest && r === 0 ? "strip" : "")));
    return;
  }
  if (state.suggest) panel.append(rowEl(stripRow(), "strip", 0, null, "strip"));
  const halves = document.createElement("div");
  halves.className = "halves";
  for (const side of ["left", "right"]) {
    const half = document.createElement("div");
    half.className = "half";
    halfRows(side).forEach((keys, r) => half.append(rowEl(keys, side, r, state[side])));
    halves.append(half);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  SPLIT_ACTIONS.forEach((id) => actions.append(keyEl({ type: "action", id }, "act-" + id, false)));
  panel.append(halves, actions);
}

function flash(id) {
  const el = panel.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.classList.add("hit");
  setTimeout(() => el.classList.remove("hit"), FLASH_MS);
}

// Recomputes suggestions for the current word and redraws.
function refresh() {
  const on = state.suggest && !state.private;
  state.suggestions = on ? suggester.suggest(state.prev, state.word, SLOTS) : [];
  render();
}

function setWord(word) {
  state.word = word;
  refresh();
}

// ---------- navigation ----------

function moveGrid(dir) {
  const rows = gridRows();
  const pos = state.grid;
  if (dir === "left" || dir === "right") {
    const n = rows[pos.r].length;
    pos.c = (pos.c + (dir === "right" ? 1 : n - 1)) % n;
    return;
  }
  const r = pos.r + (dir === "down" ? 1 : -1);
  if (r < 0 || r >= rows.length) return;
  // Pick the key in the next row whose centre is closest horizontally.
  const from = panel.querySelector(`[data-id="grid-${pos.r}-${pos.c}"]`).getBoundingClientRect();
  const x = from.left + from.width / 2;
  let best = 0;
  let bestDist = Infinity;
  rows[r].forEach((_, c) => {
    const rect = panel.querySelector(`[data-id="grid-${r}-${c}"]`).getBoundingClientRect();
    const d = Math.abs(rect.left + rect.width / 2 - x);
    if (d < bestDist) [best, bestDist] = [c, d];
  });
  state.grid = { r, c: best };
}

function moveHalf(side, dir) {
  const rows = halfRows(side);
  const pos = state[side];
  const dr = { up: -1, down: 1 }[dir] ?? 0;
  const dc = { left: -1, right: 1 }[dir] ?? 0;
  pos.r = Math.min(rows.length - 1, Math.max(0, pos.r + dr));
  pos.c = Math.min(rows[pos.r].length - 1, Math.max(0, pos.c + dc));
}

// ---------- actions ----------

function track(kind) {
  emit("kb-action", kind);
}

async function typeChar(ch) {
  const text = state.shift ? ch.toUpperCase() : ch;
  state.shift = false;
  track("type");
  if (/\p{L}/u.test(text)) {
    setWord(state.word + text);
  } else {
    // Punctuation or digits end the word.
    if (state.word) finishWord(state.word);
    if (SENTENCE_END.test(text)) state.prev = START;
    else if (!state.word) state.prev = "";
    setWord("");
  }
  await invoke("type_text", { text });
}

function accept(i) {
  const word = state.suggestions[i];
  if (!word) return;
  track("accept");
  invoke("replace_word", { delete: [...state.word].length, text: word + " " });
  finishWord(word);
  setWord("");
  flash(`strip-0-${i}`);
  flash(`grid-0-${i}`);
}

function act(id) {
  switch (id) {
    case "shift":
      state.shift = !state.shift;
      render();
      break;
    case "sym":
      state.sym = !state.sym;
      render();
      break;
    case "lang":
      openMenu();
      return;
    case "space":
      track("space");
      if (state.word) finishWord(state.word);
      setWord("");
      invoke("type_text", { text: " " });
      break;
    case "back":
      track("back");
      // Deleting past the start of the word: we no longer know what is before the caret.
      if (!state.word) state.prev = "";
      setWord([...state.word].slice(0, -1).join(""));
      invoke("press_key", { key: "backspace" });
      break;
    case "enter":
      track("enter");
      if (state.word) finishWord(state.word);
      state.prev = START;
      setWord("");
      invoke("press_key", { key: "enter" });
      // Enter may move focus to another field.
      checkPrivate();
      break;
  }
  flash("act-" + id);
}

function focusedId(where) {
  const p = state[where];
  return `${where}-${p.r}-${p.c}`;
}

// Type button pressed on a key: actions and plain keys fire at once; keys
// with a variant wait to see whether it is a tap or a hold.
function typePress(button, where) {
  const key = focusedKey(where);
  if (!key) return;
  const id = focusedId(where);
  if (key.type === "suggest") {
    accept(key.i);
    return;
  }
  if (key.type === "action") {
    act(key.id);
    flash(id);
    return;
  }
  const variant = VARIANTS[key.ch];
  if (!variant) {
    typeChar(key.ch);
    flash(id);
    return;
  }
  holds[button] = {
    key,
    id,
    timer: setTimeout(() => {
      holds[button].done = true;
      typeChar(variant);
      flash(id);
    }, HOLD_MS),
  };
}

function typeRelease(button) {
  const h = holds[button];
  if (!h) return;
  delete holds[button];
  if (h.done) return;
  clearTimeout(h.timer);
  typeChar(h.key.ch);
  flash(h.id);
}

function backPress() {
  act("back");
  clearTimeout(backTimer);
  const repeat = () => {
    act("back");
    backTimer = setTimeout(repeat, BACK_EVERY_MS);
  };
  backTimer = setTimeout(repeat, BACK_DELAY_MS);
}

function backRelease() {
  clearTimeout(backTimer);
  backTimer = null;
}

// ---------- language menu ----------

function openMenu() {
  state.menu = { focus: 0, confirmForget: false };
  render();
}

function closeMenu() {
  state.menu = null;
  refresh();
}

async function menuSelect() {
  const item = menuItems()[state.menu.focus];
  if (item.kind === "done") return closeMenu();
  if (item.kind === "forget") {
    if (!state.menu.confirmForget) {
      state.menu.confirmForget = true;
      return render();
    }
    await invoke("forget_learned");
    suggester.setLearned({});
    state.menu.confirmForget = false;
    return closeMenu();
  }
  const on = state.languages.includes(item.lang);
  // At least one language stays on.
  if (on && state.languages.length === 1) return;
  const next = on ? state.languages.filter((l) => l !== item.lang) : [...state.languages, item.lang];
  state.languages = state.available.filter((l) => next.includes(l));
  render();
  await invoke("set_languages", { languages: state.languages });
  await applyLanguages();
  render();
}

function onMenuNav(dir) {
  const n = menuItems().length;
  if (dir === "up") state.menu.focus = (state.menu.focus + n - 1) % n;
  else if (dir === "down") state.menu.focus = (state.menu.focus + 1) % n;
  else return;
  state.menu.confirmForget = false;
  render();
}

// ---------- input ----------

function onNav(source, dir) {
  track("nav");
  if (state.menu) return onMenuNav(dir);
  if (state.layout === "grid") {
    if (source === "right") {
      if (dir === "left" || dir === "right") {
        // The caret left the word: suggestions no longer apply.
        state.prev = "";
        setWord("");
        invoke("press_key", { key: dir });
      }
      return;
    }
    moveGrid(dir);
  } else {
    moveHalf(source === "right" ? "right" : "left", dir);
  }
  render();
}

function onPress(button) {
  if (state.menu) {
    if (button === "a" || button === "lt" || button === "rt") menuSelect();
    else if (button === "l3") closeMenu();
    return;
  }
  const grid = state.layout === "grid";
  switch (button) {
    case "a":
      if (grid) typePress("a", "grid");
      break;
    case "lt":
      if (!grid) typePress("lt", "left");
      break;
    case "rt":
      if (grid) accept(0);
      else typePress("rt", "right");
      break;
    case "view":
      accept(0);
      break;
    case "x":
      backPress();
      break;
    case "y":
      act("space");
      break;
    case "lb":
      act("shift");
      break;
    case "rb":
      act("sym");
      break;
    case "l3":
      act("lang");
      break;
    case "menu":
      act("enter");
      break;
  }
}

function onRelease(button) {
  if (button === "x") backRelease();
  else typeRelease(button);
}

listen("pad", ({ payload }) => {
  if (payload.kind === "nav") onNav(payload.source, payload.dir);
  else if (payload.kind === "press") onPress(payload.button);
  else if (payload.kind === "release") onRelease(payload.button);
});

function resetFocus() {
  state.grid = { r: state.suggest ? 2 : 1, c: 4 };
  state.left = { r: 1, c: 3 };
  state.right = { r: 1, c: 1 };
}

listen("layout", ({ payload }) => {
  state.layout = payload === "split" ? "split" : "grid";
  state.shift = false;
  state.sym = false;
  saveLayout();
  resetFocus();
  state.prev = START;
  setWord("");
});

listen("suggest", ({ payload }) => {
  state.suggest = payload === true;
  resetFocus();
  setWord("");
});

listen("mode", ({ payload }) => {
  if (payload === "keyboard") {
    // Opening the keyboard: we do not know what is already in the field.
    state.prev = "";
    state.menu = null;
    setWord("");
    checkPrivate();
    return;
  }
  // Closing mid-hold must not leave timers running.
  for (const b of Object.keys(holds)) {
    clearTimeout(holds[b].timer);
    delete holds[b];
  }
  backRelease();
});

render();
init();
