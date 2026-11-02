// Serves site/ locally (http://localhost:4600) with caching off, so every
// reload shows the files as they are now: the app pages under site/app change
// as app/ui does. Pages adds its own caching once deployed.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../site/", import.meta.url));
const port = Number(process.env.PORT) || 4600;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".tsv": "text/plain; charset=utf-8", ".xml": "application/xml",
};

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  // Nothing outside site/.
  if (!file.startsWith(root.replace(/[\\/]$/, "") + sep)) return void res.writeHead(403).end();
  let info;
  try {
    info = statSync(file);
  } catch {
    return void res.writeHead(404).end("Not found");
  }
  if (info.isDirectory()) return void res.writeHead(301, { Location: path + "/" }).end();
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`site: http://localhost:${port}`));
