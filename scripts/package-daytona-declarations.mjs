import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";

// The private SPI implementation is bundled at runtime; vendor its declarations too.
await copyFile("../../provider-spi/dist/index.d.ts", "dist/internal-spi.d.ts");

for (const name of await readdir("dist")) {
  if (!name.endsWith(".d.ts")) continue;
  const path = `dist/${name}`;
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replaceAll('"@sandbar/provider-spi"', '"./internal-spi.js"'));
}
