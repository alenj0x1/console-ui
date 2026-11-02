// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

// The landing page lives at the root of GitHub Pages (https://alenj0x1.github.io/console-ui/), so the docs
// are published under it: BASE=/console-ui/docs. Locally the base is "/".
export default defineConfig({
  site: process.env.SITE || "https://alenj0x1.github.io",
  base: process.env.BASE || "/",
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: "Console UI",
      description: "Use all of Windows from the couch with a game controller.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        es: { label: "Español", lang: "es" },
      },
      customCss: ["./src/styles/fonts.css", "./src/styles/console-ui.css"],
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false })],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/alenj0x1/console-ui" }],
      editLink: { baseUrl: "https://github.com/alenj0x1/console-ui/edit/main/docs/" },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: "Getting started",
          translations: { es: "Empezar" },
          items: ["getting-started/install", "getting-started/hidhide", "getting-started/first-run", "getting-started/from-source"],
        },
        {
          label: "Guide",
          translations: { es: "Guía de uso" },
          items: [
            "guide/controls",
            "guide/cursor",
            "guide/keyboard",
            "guide/home",
            "guide/personalize",
            "guide/settings",
            "guide/game-mode",
            "guide/quick-menu",
            "guide/tv-mode",
            "guide/accessibility",
          ],
        },
        {
          label: "How it works",
          translations: { es: "Cómo funciona" },
          items: ["how-it-works/input-core", "how-it-works/game-detection", "how-it-works/privacy-security"],
        },
        {
          label: "Reference",
          translations: { es: "Referencia" },
          items: ["reference/settings", "reference/command-line", "reference/files"],
        },
        { label: "Troubleshooting", translations: { es: "Solución de problemas" }, slug: "troubleshooting" },
        {
          label: "Development",
          translations: { es: "Desarrollo" },
          items: ["development/structure", "development/testing", "development/labs", "development/commits", "development/releases"],
        },
        { label: "Changelog", translations: { es: "Cambios" }, slug: "changelog" },
      ],
    }),
  ],
});
