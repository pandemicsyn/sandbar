import { performance } from "node:perf_hooks";

const target = process.argv[2] === "effect" ? "./dist/index.js" : "@sandbar/sdk/direct";

const start = performance.now();

await import(target);

console.log((performance.now() - start).toFixed(3));
