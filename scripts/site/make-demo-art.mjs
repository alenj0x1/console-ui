// Draws the sample art the website's live demo uses (site/demo/media): the
// songs' covers and the open windows' pictures, the same every run. The
// games use their official Steam art (site/demo/media/steam).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "site", "demo", "media");

function rng(seed) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

function write(path, content) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), content);
}

// Song covers: shapes on a flat colour.
const COVERS = [
  ["cover-1", "#2c3e66", "#f2b880", "#e86f5a"],
  ["cover-2", "#20463d", "#e9d8a6", "#94d2bd"],
  ["cover-3", "#4a2c4f", "#f6c1cc", "#8e7dbe"],
];
for (const [id, bg, a, b] of COVERS) {
  const r = rng(id);
  let body = `<rect width="600" height="600" fill="${bg}"/>`;
  body += `<circle cx="${200 + r() * 200}" cy="${200 + r() * 120}" r="150" fill="${a}"/>`;
  for (let i = 0; i < 7; i++) body += `<rect x="0" y="${380 + i * 30}" width="600" height="12" fill="${b}" opacity="${0.35 + i * 0.09}"/>`;
  write(`covers/${id}.svg`, svg(600, 600, body));
}

// The control center's open windows: a picture of each.
const ui = (bg, panel, accent, rows) => {
  let body = `<rect width="1280" height="720" fill="${bg}"/><rect width="1280" height="56" fill="${panel}"/>`;
  rows.forEach(([x, y, w, h, fill], i) => (body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill ?? (i % 3 ? panel : accent)}"/>`));
  return svg(1280, 720, body);
};
write("windows/w2-shot.svg", ui("#121212", "#1f1f1f", "#1ed760", [[24, 80, 260, 616, "#1a1a1a"], [312, 80, 944, 220, "#2a2a2a"], [312, 330, 210, 210], [544, 330, 210, 210], [776, 330, 210, 210], [1008, 330, 210, 210], [312, 580, 944, 116, "#181818"]]));
write("windows/w3-shot.svg", ui("#f7f5f0", "#e9e6df", "#c8553d", [[200, 96, 880, 260, "#e0d7c6"], [200, 384, 420, 24, "#3a3a3a"], [200, 424, 860, 14, "#9a968d"], [200, 452, 820, 14, "#9a968d"], [200, 480, 840, 14, "#9a968d"], [200, 528, 260, 150, "#d9cbb3"], [480, 528, 260, 150, "#cfd8c2"], [760, 528, 260, 150, "#e3c3b5"]]));
console.log(`site/demo/media: ${COVERS.length} covers, windows`);
