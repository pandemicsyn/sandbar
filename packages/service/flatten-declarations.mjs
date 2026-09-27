import { readFile, writeFile, rm } from "node:fs/promises";

const source = "dist/packages/service/src/";

await writeFile("dist/index.d.ts", await readFile(`${source}index.d.ts`, "utf8"));

const client = await readFile(`${source}client.d.ts`, "utf8");

await writeFile(
  "dist/client.d.ts",
  client.replaceAll("../../../apps/server/src/http-contracts", "./http-contracts.js"),
);

await writeFile(
  "dist/http-contracts.d.ts",
  await readFile("dist/apps/server/src/http-contracts.d.ts", "utf8"),
);

await rm("dist/packages", { recursive: true, force: true });

await rm("dist/apps", { recursive: true, force: true });
