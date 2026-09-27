import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../src/content/docs/", import.meta.url);

async function files(directory) {
  const output = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) output.push(...(await files(path)));
    else if (path.endsWith(".md") || path.endsWith(".mdx")) output.push(path);
  }

  return output;
}

const markdown = await files(root.pathname);

const routes = new Set(
  markdown.map(
    (path) =>
      "/" +
      path
        .slice(root.pathname.length)
        .replace(/\.(md|mdx)$/, "")
        .replace(/\/index$/, "") +
      "/",
  ),
);

routes.add("/");

const errors = [];

for (const path of markdown) {
  const content = await readFile(path, "utf8");

  for (const [, href] of content.matchAll(/\]\((\/[^)]+)\)/g)) {
    const [pathname, anchor] = href.split("#");
    const route = pathname.endsWith("/") ? pathname : pathname + "/";

    if (!routes.has(route)) {
      errors.push(`${path}: missing route ${href}`);
      continue;
    }

    if (anchor) {
      const target = markdown.find(
        (file) =>
          "/" +
            file
              .slice(root.pathname.length)
              .replace(/\.(md|mdx)$/, "")
              .replace(/\/index$/, "") +
            "/" ===
          route,
      );

      if (target) {
        const targetText = await readFile(target, "utf8");

        const anchors = [...targetText.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) =>
          heading
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .trim()
            .replace(/\s+/g, "-"),
        );

        if (!anchors.includes(anchor)) errors.push(`${path}: missing anchor ${href}`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Checked local routes and anchors in ${markdown.length} documentation pages`);
