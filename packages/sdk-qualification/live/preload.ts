import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAndLoad } from "../provider-qualification/build";

declare global {
  var sandbarLiveBuild: { revision: string; dirty: boolean } | undefined;
}

if (process.env.SANDBAR_LIVE === "1") {
  if (process.env.CI || process.env.SANDBAR_QUAL_LIVE_AUTHORIZED !== "yes")
    throw new Error(
      "Live integration tests require explicit authorization and cannot run in ordinary CI",
    );
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await buildAndLoad(root, async () => {
    globalThis.sandbarLiveBuild = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    };
  });
}
