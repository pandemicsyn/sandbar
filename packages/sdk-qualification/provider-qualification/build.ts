import { execFileSync } from "node:child_process";

/** Rebuild dependencies before importing SDK bundles; failure must not load stale output. */
export async function buildAndLoad<T>(
  root: string,
  load: () => Promise<T>,
  build = () => {
    execFileSync("bun", ["run", "build:packages"], { cwd: root, stdio: "inherit" });
  },
) {
  build();

  return load();
}
