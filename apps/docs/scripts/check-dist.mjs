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
  if (!html.includes("noindex")) throw new Error(`Development page lacks noindex: ${path}`);
}

for (const path of pageText.keys()) {
  const relative = path.slice(dist.length);

  if (
    /^docs\/(?:self-hosting\/|service-quickstart\/|choose-a-mode\/|reference\/http\/)/.test(
      relative,
    )
  )
    throw new Error(`Unreleased service documentation was published: ${relative}`);
}

console.log(
  `Checked ${pages.length} static pages, local links and anchors, Pagefind, metadata and 404 output`,
);
