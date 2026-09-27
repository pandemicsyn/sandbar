import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code";
import { oceanDriveCodeTheme } from "./src/ocean-drive-code-theme.mjs";

const fonts =
  "https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;800&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap";

// The landing page links to /docs/?search to open the Pagefind dialog on arrival.
const openSearchFromQuery = `addEventListener("DOMContentLoaded", () => {
  if (!new URLSearchParams(location.search).has("search")) return;
  let tries = 0;
  const open = () => {
    const button = document.querySelector("site-search button[data-open-modal]");
    if (button && !button.disabled) return button.click();
    if (++tries < 40) setTimeout(open, 50);
  };
  open();
});`;

export default defineConfig({
  site: "https://sandbarsdk.dev",
  output: "static",
  integrations: [
    starlight({
      title: "Sandbar",
      description: "Development documentation for the provider-neutral sandbox API.",
      favicon: "/favicon.svg",
      head: [
        { tag: "meta", attrs: { name: "robots", content: "noindex, nofollow" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        { tag: "link", attrs: { rel: "stylesheet", href: fonts } },
        { tag: "script", content: openSearchFromQuery },
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/pandemicsyn/sandbar" }],
      customCss: ["./src/styles/tokens.css", "./src/styles/docs.css"],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        ThemeSelect: "./src/components/ThemeToggle.astro",
      },
      expressiveCode: {
        themes: [new ExpressiveCodeTheme(oceanDriveCodeTheme)],
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: "12px",
          borderColor: "transparent",
          codeFontFamily: "var(--sb-font-mono)",
          uiFontFamily: "var(--sb-font-mono)",
          codeFontSize: "0.875rem",
          codeLineHeight: "1.8",
          codePaddingInline: "1.25rem",
          frames: {
            shadowColor: "transparent",
            editorActiveTabIndicatorTopColor: "#EF4F91",
            editorActiveTabIndicatorBottomColor: "transparent",
            editorTabBarBorderBottomColor: "transparent",
            terminalTitlebarBorderBottomColor: "transparent",
            terminalTitlebarDotsForeground: "#8189AE",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      sidebar: [
        {
          label: "Start",
          items: [
            { slug: "docs" },
            { slug: "docs/direct-quickstart" },
            { slug: "docs/service-quickstart" },
            { slug: "docs/choose-a-mode" },
          ],
        },
        { label: "Guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
        {
          label: "Reference",
          items: [
            { slug: "docs/reference/typescript" },
            { slug: "docs/reference/generated-typescript" },
            { slug: "docs/reference/http" },
          ],
        },
        {
          label: "Operate",
          items: [
            { autogenerate: { directory: "docs/self-hosting" } },
            { autogenerate: { directory: "docs/providers" } },
          ],
        },
        { label: "Contribute", items: [{ autogenerate: { directory: "docs/contributing" } }] },
      ],
    }),
  ],
});
