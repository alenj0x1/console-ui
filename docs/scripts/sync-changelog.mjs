// Copies the repo's CHANGELOG.md (English) and CHANGELOG.es.md (Spanish) into the docs, so the
// Changelog page always matches them. Runs on `predev` and `prebuild`.
// Only released versions are shown: the "Unreleased" / "Sin publicar" section, its compare link and
// the intro line that explains it stay on GitHub.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..");
// CHANGELOG_DIR points to other files while testing; by default, the repository root.
const root = process.env.CHANGELOG_DIR || join(docs, "..");

const pages = [
  {
    src: "CHANGELOG.md",
    out: "changelog.md",
    title: "Changelog",
    description: "What changed in each Console UI version.",
    empty: "No version has been published yet.",
  },
  {
    src: "CHANGELOG.es.md",
    out: "es/changelog.md",
    title: "Cambios",
    description: "Lo que cambió en cada versión de Console UI.",
    empty: "Todavía no se publicó ninguna versión.",
  },
];

for (const p of pages) {
  let md = readFileSync(join(root, p.src), "utf8")
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    // the language switch only makes sense on GitHub
    .replace(/^.*\]\(CHANGELOG(\.es)?\.md\).*\n+/gm, "")
    // the page puts the title
    .replace(/^# .*\n+/m, "")
    // the line about the pending section
    .replace(/^.*\*\*(Unreleased|Sin publicar)\*\*.*\n+/m, "")
    // the pending section itself, up to the next version or the end
    .replace(/^## \[?(Unreleased|Sin publicar)\]?.*\n[\s\S]*?(?=^## |^\[[^\]]+\]: |(?![\s\S]))/m, "")
    // its compare link
    .replace(/^\[(Unreleased|Sin publicar)\]: .*\n?/gm, "")
    .trim();
  if (!/^## /m.test(md)) md += `\n\n${p.empty}`;
  const page = `---
title: ${p.title}
description: ${p.description}
tableOfContents:
  maxHeadingLevel: 2
editUrl: false
---

<!-- Generated from ${p.src} by scripts/sync-changelog.mjs: edit ${p.src}, not this file. -->

${md}
`;
  const out = join(docs, "src", "content", "docs", p.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page);
  console.log(`changelog synced to src/content/docs/${p.out}`);
}
