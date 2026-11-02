// The radial menu (holding View in the cursor): five slices clockwise from
// the top, the one the stick points at in the accent; with nothing aimed,
// the middle shows that letting go cancels.
// Must match the slots in app/src/radial.rs.

const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();

const SLOTS = [
  { icon: "keyboard", name: "Teclado" },
  { icon: "scissors", name: "Captura" },
  { icon: "desktop", name: "Escritorio" },
  { icon: "close-window", name: "Cerrar ventana" },
  { icon: "home", name: "Inicio" },
];
const C = 280, OUTER = 270, INNER = 92, ICON = 34;
const ring = document.querySelector("svg.ring");

const at = (r, turn) => [C + r * Math.sin(turn * 2 * Math.PI), C - r * Math.cos(turn * 2 * Math.PI)];

// One slice of the ring around `turn` (0 = top, clockwise), as wide as 1/n.
function slice(i, n) {
  const half = 0.5 / n;
  const [a, b] = [i / n - half, i / n + half];
  const [p1, p2, p3, p4] = [at(OUTER, a), at(OUTER, b), at(INNER, b), at(INNER, a)];
  return `M${p1} A${OUTER} ${OUTER} 0 0 1 ${p2} L${p3} A${INNER} ${INNER} 0 0 0 ${p4} Z`;
}

function draw(aim) {
  const n = SLOTS.length;
  const parts = SLOTS.map((s, i) => {
    const [x, y] = at((OUTER + INNER) / 2, i / n);
    const on = i === aim;
    return `<path class="slice${on ? " on" : ""}" d="${slice(i, n)}"/>
      <g class="${on ? "on-mark" : "mark"}" transform="translate(${x - ICON / 2} ${y - ICON / 2 - 12})">${icon(s.icon, "").replace("<svg ", `<svg width="${ICON}" height="${ICON}" `)}</g>
      <text class="label" x="${x}" y="${y + 34}">${s.name}</text>`;
  });
  const cancel = aim == null
    ? `<g class="cancel" transform="translate(${C - ICON / 2} ${C - ICON / 2})">${icon("x", "").replace("<svg ", `<svg width="${ICON}" height="${ICON}" `)}</g>`
    : "";
  ring.innerHTML = `${parts.join("")}<circle class="hub" cx="${C}" cy="${C}" r="${INNER}"/>${cancel}`;
}

here.listen("radial", ({ payload }) => {
  if (payload.kind === "aim") draw(payload.slot);
  // Closing: back to no aim, so the next open never starts on the last one.
  else draw(null);
});
draw(null);
