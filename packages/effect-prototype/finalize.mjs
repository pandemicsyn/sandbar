import { copyFile, rm } from "node:fs/promises";

await copyFile("dist/effect-prototype/src/index.d.ts", "dist/index.d.ts");

await rm("dist/effect-prototype", { recursive: true, force: true });

await rm("dist/sdk", { recursive: true, force: true });
