import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });

  if (result.status !== 0) throw new Error(`${command} failed`);
};

for (const fixture of ["qualify", "http", "benchmark", "faults"]) {
  run("bun", [
    "build",
    `packages/sdk-qualification/observability/${fixture}.ts`,
    "--target",
    "node",
    "--packages",
    "external",
    "--outfile",
    `packages/sdk-qualification/dist/observability-${fixture}.mjs`,
  ]);
}

for (const runtime of ["node", "bun"]) {
  for (const recipe of ["otel", "sentry", "datadog"]) {
    for (const sampling of ["on", "off"])
      run(runtime === "node" ? (process.env.SANDBAR_NODE_BINARY ?? "node") : runtime, [
        "packages/sdk-qualification/dist/observability-qualify.mjs",
        recipe,
        sampling,
      ]);
  }

  run(runtime === "node" ? (process.env.SANDBAR_NODE_BINARY ?? "node") : runtime, [
    "packages/sdk-qualification/dist/observability-http.mjs",
  ]);
  run(runtime === "node" ? (process.env.SANDBAR_NODE_BINARY ?? "node") : runtime, [
    "packages/sdk-qualification/dist/observability-benchmark.mjs",
  ]);
  run(runtime === "node" ? (process.env.SANDBAR_NODE_BINARY ?? "node") : runtime, [
    "packages/sdk-qualification/dist/observability-faults.mjs",
  ]);
}
