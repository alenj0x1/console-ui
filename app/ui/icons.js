// Line icons from Tabler Icons (MIT, https://tabler.io/icons), inlined so the
// app needs no network. Each entry is the inner SVG markup of a 24×24 icon.
const ICONS = {
  play: '<path d="M7 4v16l13 -8z"/>',
  pause: '<path d="M6 5h4v14h-4z"/><path d="M14 5h4v14h-4z"/>',
  prev: '<path d="M20 5v14l-12 -7z"/><path d="M4 5l0 14"/>',
  next: '<path d="M4 5v14l12 -7z"/><path d="M20 5l0 14"/>',
  edit: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  check: '<path d="M5 12l5 5l10 -10"/>',
  music: '<path d="M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M9 17v-13h10v13"/><path d="M9 8h10"/>',
  volume: '<path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/><path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/>',
  mute: '<path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/><path d="M16 10l4 4m0 -4l-4 4"/>',
  photo: '<path d="M15 8h.01"/><path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12z"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3"/>',
  "photo-off": '<path d="M15 8h.01"/><path d="M7 3h11a3 3 0 0 1 3 3v11m-.856 3.099a2.991 2.991 0 0 1 -2.144 .901h-12a3 3 0 0 1 -3 -3v-12c0 -.845 .349 -1.608 .91 -2.153"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M16.33 12.338c.574 -.054 1.155 .166 1.67 .662l3 3"/><path d="M3 3l18 18"/>',
  folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>',
  "folder-plus": '<path d="M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5"/><path d="M16 19h6"/><path d="M19 16v6"/>',
  "folder-minus": '<path d="M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5"/><path d="M16 19h6"/>',
  download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>',
  "window-maximize": '<path d="M5 5m0 1a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1z"/>',
  apps: '<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z"/><path d="M14 7l6 0"/><path d="M17 4l0 6"/>',
  // Tabler «arrows-shuffle», for «Otra combinación».
  shuffle: '<path d="M18 4l3 3l-3 3"/><path d="M18 20l3 -3l-3 -3"/><path d="M3 7h3a5 5 0 0 1 5 5a5 5 0 0 0 5 5h5"/><path d="M21 7h-5a4.98 4.98 0 0 0 -3 1m-4 8a4.98 4.98 0 0 1 -3 1h-3"/>',
  // The Xbox controller's View and Menu buttons, as printed on them.
  "btn-view": '<rect x="3" y="4" width="12" height="10" rx="2"/><path d="M9 14v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2v-6a2 2 0 0 0 -2 -2h-4"/>',
  "btn-menu": '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  palette: '<path d="M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25"/><path d="M8.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M16.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
  keyboard: '<path d="M2 6m0 2a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2z"/><path d="M6 10l0 .01"/><path d="M10 10l0 .01"/><path d="M14 10l0 .01"/><path d="M18 10l0 .01"/><path d="M6 14l0 .01"/><path d="M18 14l0 .01"/><path d="M10 14l4 .01"/>',
  settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  chevron: '<path d="M9 6l6 6l-6 6"/>',
  pointer: '<path d="M7.904 17.563a1.2 1.2 0 0 0 2.228 .308l2.09 -3.093l4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047 -1.047a1.067 1.067 0 0 0 0 -1.509l-4.907 -4.907l3.113 -2.09a1.2 1.2 0 0 0 -.309 -2.228l-13.582 -3.904l3.904 13.563z"/>',
  "player-play": '<path d="M7 4v16l13 -8z"/>',
  gamepad: '<path d="M2 6m0 2a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2z"/><path d="M6 12h4m-2 -2v4"/><path d="M15 11l0 .01"/><path d="M18 13l0 .01"/>',
};

// A controller button hint, drawn as the button itself: A, B, X, Y, View and
// Menu round (View and Menu with their printed symbols), LB / RB as bumpers,
// LT / RT as triggers, the d-pad directions (↑ ↓ ← →) as a cross. "LT RT"
// draws both. With buttons reassigned in the settings (A and B swapped, one
// hand, the user's own), a hint shows the button that does it now; `literal`
// keeps the named button (text that talks about the buttons themselves).
function setGlyph(span, button, literal = false) {
  span.replaceChildren(...button.split(" ").map((b) => buttonShape(literal ? b : doneBy(b))));
  span.setAttribute("aria-label", button);
  return span;
}

// The button that does what `b` usually does: the engine reassigns first,
// then swaps A and B.
function doneBy(b) {
  const p = typeof Prefs !== "undefined" ? Prefs.get() : null;
  if (!p) return b;
  const wanted = (p.swap_ab ? { A: "B", B: "A" }[b] : null) ?? b;
  const map = p.button_map ?? {};
  const id = wanted.toLowerCase();
  // Another button moved here (one hand, the user's own) is the one to show.
  const moved = Object.keys(map).find((k) => k !== id && map[k] === id);
  return moved ? ({ up: "↑", down: "↓", left: "←", right: "→" }[moved] ?? moved.toUpperCase()) : wanted;
}

// The d-pad directions: a cross as big as the LT / LB badges, the arm of
// that direction filled and the others in outline.
const DPAD_GLYPH = { "↑": [8.5, 2.5, 7, 10], "↓": [8.5, 11.5, 7, 10], "←": [2.5, 8.5, 10, 7], "→": [11.5, 8.5, 10, 7] };
function buttonShape(b) {
  const s = document.createElement("span");
  const arm = DPAD_GLYPH[b] ?? DPAD_GLYPH[{ UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→" }[b]];
  if (arm) {
    s.className = "btn btn-dpad";
    s.innerHTML = `<svg class="glyph-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect class="arm-on" x="${arm[0]}" y="${arm[1]}" width="${arm[2]}" height="${arm[3]}"/><path d="M8.5 2.5h7v6h6v7h-6v6h-7v-6h-6v-7h6z"/></svg>`;
    return s;
  }
  const symbol = { View: "btn-view", Menu: "btn-menu" }[b];
  const kind = symbol || /^([ABXY]|[LR]3)$/.test(b) ? "face" : /^[LR]B$/.test(b) ? "bumper" : /^[LR]T$/.test(b) ? "trigger" : "plain";
  s.className = `btn btn-${kind}${kind === "face" && !symbol && b.length > 1 ? " wide" : ""}`;
  if (symbol) s.innerHTML = icon(symbol, "glyph-icon");
  else s.textContent = b;
  return s;
}

// Text that names buttons: "{B}" or "{View}" inside it becomes the button.
// `literal` false shows the button that does it now instead.
function withButtons(text, literal = true) {
  return text.split(/\{([A-Za-z0-9]+)\}/).map((part, i) =>
    i % 2 ? setGlyph(Object.assign(document.createElement("span"), { className: "glyph inline" }), part, literal) : document.createTextNode(part),
  );
}

function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
