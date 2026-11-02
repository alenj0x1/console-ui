// Copies the app's real pages (app/ui) into site/app so the website can show
// them live: each page gets site/demo/shim.js first, which stands in for the
// desktop app with sample data. Run before serving or deploying the site.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const from = join(root, "app", "ui");
const to = join(root, "site", "app");
const PAGES = ["home.html", "keyboard.html", "guide.html"];
const SKIP = /^(lab|welcome|notice|radial)\.|\.html$/;

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true, filter: (src) => !SKIP.test(src.slice(from.length + 1).split(/[\\/]/).pop()) || src === from });

for (const page of PAGES) {
  const html = readFileSync(join(from, page), "utf8");
  // The shim must run before the page's scripts and before its stylesheets
  // ask for anything, so it goes right after <head>.
  const out = html.replace("<head>", '<head>\n  <script src="../demo/shim.js"></script>\n  <link rel="stylesheet" href="../demo/frame.css">');
  if (out === html) throw new Error(`${page}: no <head> to put the demo in`);
  writeFileSync(join(to, page), out);
}
console.log(`site/app: ${PAGES.length} pages from app/ui`);
