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
  // The tab renderer uses a native parser; keep its platform binding beside its package.
  vite: { ssr: { external: ["satteri"] } },
  integrations: [
    starlight({
      title: "Sandbar",
      description:
        "The TypeScript SDK for sandboxes. Getting started, provider support, guides, and adapter authoring.",
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
          label: "Getting started",
          items: [{ slug: "docs", label: "Overview" }, { slug: "docs/direct-quickstart" }],
        },
        {
          label: "Build with an agent",
          items: [{ slug: "docs/agents/build-with-sdk" }, { slug: "docs/agents/build-a-provider" }],
        },
        {
          label: "Using the SDK",
          items: [
            { slug: "docs/guides/resources" },
            { slug: "docs/guides/snapshots-and-volumes" },
            { slug: "docs/guides/files-and-output" },
            { slug: "docs/guides/images-and-networking" },
            { slug: "docs/guides/recovery" },
            { slug: "docs/guides/troubleshooting" },
          ],
        },
        {
          label: "Providers",
          items: [
            { slug: "docs/providers/support" },
            { slug: "docs/providers/daytona" },
            { slug: "docs/providers/e2b" },
            { slug: "docs/providers/live-qualification", label: "Live test evidence" },
          ],
        },
        {
          label: "Build a provider",
          collapsed: true,
          items: [
            { slug: "docs/guides/write-an-adapter" },
            { slug: "docs/guides/adapter-capabilities" },
            { slug: "docs/guides/adapter-recovery" },
            { slug: "docs/contributing/drivers" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "docs/reference/typescript" },
            { slug: "docs/reference/generated-typescript" },
          ],
        },
      ],
    }),
  ],
});
