import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { cpus, platform, release, arch } from "node:os";
import { Sandbar } from "@sandbar/sdk/direct";
import { EffectCreateClient } from "./dist/index.js";

const sample = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);

  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
};

const imports = {};

for (const runtime of ["node", "bun"]) {
  imports[runtime] = {};

  for (const variant of ["baseline", "effect"]) {
    const values = [];

    for (let i = 0; i < 12; i++) {
      const start = performance.now();

      const result = spawnSync(runtime, ["import-cold.mjs", variant], {
        cwd: import.meta.dirname,
        encoding: "utf8",
      });

      if (result.status !== 0) throw new Error(result.stderr);
      values.push({ startup: performance.now() - start, import: Number(result.stdout.trim()) });
    }

    imports[runtime][variant] = {
      startupMs: sample(values.map((x) => x.startup)),
      importMs: sample(values.map((x) => x.import)),
    };
  }
}

const scope = {
  provider: "memory",
  connectionId: "memory_connection",
  accountId: "memory_account",
};

let createCalls = 0,
  observeCalls = 0;

const receipts = new Map();

const driver = {
  name: "memory",
  async capabilities() {
    return {
      provider: "memory",
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: true,
      supports: { argv: true, shell: false, fileBytes: false, inventory: false },
      maxFileBytes: 0,
      maxOutputBytes: 0,
      networkPolicies: ["blocked"],
    };
  },
  async prepare() {
    return { supported: true, effectiveImage: "memory-image" };
  },
  async create({ identity }) {
    createCalls++;

    const result = {
      status: "completed",
      effect: "applied",
      submissionId: identity.submissionId,
      value: {
        kind: "sandbox",
        observation: {
          ref: { scope, nativeId: `memory_${createCalls}`, kind: "sandbox" },
          state: "running",
          observedAt: "2026-09-27T00:00:00.000Z",
        },
      },
    };

    receipts.set(identity.submissionId, result);

    return result;
  },
  async observe({ submissionId }) {
    observeCalls++;

    return receipts.get(submissionId) ?? null;
  },
};

const input = { environment: { kind: "prepared", value: "memory-image" } };

const operations = {};

for (const [name, make] of Object.entries({
  baseline: () => Sandbar.direct({ provider: { driver, scope } }),
  effect: () => new EffectCreateClient({ provider: { driver, scope } }),
})) {
  const batches = [];

  for (let round = 0; round < 7; round++) {
    const client = make();
    const count = round === 0 ? 50 : 300;
    const beforeObserve = observeCalls;
    const start = performance.now();

    for (let i = 0; i < count; i++) await client.sandboxes.create(input);
    const duration = performance.now() - start;
    const observed = observeCalls - beforeObserve;
    await client.close();

    if (round > 0)
      batches.push({ msPerCreate: duration / count, observesPerCreate: observed / count });
  }

  operations[name] = {
    msPerCreate: sample(batches.map((x) => x.msPerCreate)),
    observesPerCreate: sample(batches.map((x) => x.observesPerCreate)),
  };
}

console.log(
  JSON.stringify(
    {
      machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
      runtimes: Object.fromEntries(
        ["node", "bun"].map((name) => [
          name,
          spawnSync(name, ["--version"], { encoding: "utf8" }).stdout.trim(),
        ]),
      ),
      method:
        "12 fresh child processes per import; six batches of 300 sequential in-memory creates after 50 warmups; medians/min/max; no network in operation loop",
      imports,
      operations,
      createCalls,
      observeCalls,
    },
    null,
    2,
  ),
);
