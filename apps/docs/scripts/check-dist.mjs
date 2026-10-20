import { stat, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

for (const relative of ["index.html", "docs/index.html", "404.html", "pagefind/pagefind.js"]) {
  await stat(dist + relative).catch(() => {
    throw new Error(`Missing static output: ${relative}`);
  });
}

const page = await readFile(dist + "docs/index.html", "utf8");

// Starlight adds @astrojs/sitemap because `site` is set; the landing page must be listed too.
const sitemapIndex = await readFile(dist + "sitemap-index.xml", "utf8").catch(() => {
  throw new Error("Missing static output: sitemap-index.xml");
});

const sitemapUrls = new Set();

for (const [, loc] of sitemapIndex.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const file = dist + new URL(loc).pathname.replace(/^\//, "");

  const sitemap = await readFile(file, "utf8").catch(() => {
    throw new Error(`Sitemap index lists missing file: ${loc}`);
  });

  for (const [, url] of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) sitemapUrls.add(url);
}

for (const url of ["https://sandbarsdk.dev/", "https://sandbarsdk.dev/docs/"]) {
  if (!sitemapUrls.has(url)) throw new Error(`Sitemap lacks ${url}`);
}

const robots = await readFile(dist + "robots.txt", "utf8");

if (!robots.includes("Sitemap: https://sandbarsdk.dev/sitemap-index.xml"))
  throw new Error("robots.txt does not point at the sitemap");

if (/^Disallow:\s*\S/m.test(robots)) throw new Error("robots.txt blocks crawlers");

if (!page.includes("<title>") || !page.includes("sandbarsdk.dev"))
  throw new Error("Docs metadata missing");

const notFound = await readFile(dist + "404.html", "utf8");

if (!notFound.includes("404")) throw new Error("404 page missing");

async function htmlFiles(directory) {
  const output = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) output.push(...(await htmlFiles(path)));
    else if (entry.name.endsWith(".html")) output.push(path);
  }

  return output;
}

const pages = await htmlFiles(dist);

const pageText = new Map(
  await Promise.all(pages.map(async (path) => [path, await readFile(path, "utf8")])),
);

const errors = [];

for (const [source, html] of pageText) {
  for (const [, raw] of html.matchAll(/\bhref="([^"]+)"/g)) {
    if (!raw.startsWith("/") || raw.startsWith("//")) continue;
    const url = new URL(raw.replaceAll("&amp;", "&"), "https://sandbarsdk.dev");
    const relative = decodeURIComponent(url.pathname).replace(/^\//, "");

    const target =
      dist + (relative.endsWith("/") || relative === "" ? relative + "index.html" : relative);

    const actual = pageText.has(target)
      ? target
      : pageText.has(target + "/index.html")
        ? target + "/index.html"
        : target;

    try {
      await stat(actual);
    } catch {
      errors.push(`${source}: missing ${raw}`);
      continue;
    }

    if (url.hash && pageText.has(actual)) {
      const id = decodeURIComponent(url.hash.slice(1));

      if (!pageText.get(actual).includes(`id="${id}"`))
        errors.push(`${source}: missing anchor ${raw}`);
    }
  }
}

if (errors.length) throw new Error(errors.join("\n"));

for (const [path, html] of pageText) {
  // Astro's redirect stubs carry noindex on purpose.
  if (html.includes('http-equiv="refresh"')) continue;

  if (html.includes("noindex")) throw new Error(`Public page carries noindex: ${path}`);
}

console.log(
  `Checked ${pages.length} static pages, local links and anchors, Pagefind, metadata and 404 output`,
);
