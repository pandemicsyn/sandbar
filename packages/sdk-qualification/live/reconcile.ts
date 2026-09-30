import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { buildAndLoad } from "../provider-qualification/build";
import { LedgerStore, requirePrivateDirectory } from "../provider-qualification/ledger";

const directory = process.env.SANDBAR_QUAL_LEDGER_DIR;

const runId = process.argv[2];

if (!directory || !isAbsolute(directory) || !runId)
  throw Error(
    "Usage: SANDBAR_QUAL_LEDGER_DIR=<existing private directory> bun live/reconcile.ts <run UUID>",
  );

const canonical = await realpath(directory);

await requirePrivateDirectory(canonical);

const ledger = new LedgerStore(canonical, runId);

const saved = await ledger.read();

process.env.SANDBAR_QUAL_PROVIDER = saved.provider;

const root = fileURLToPath(new URL("../../../", import.meta.url));

await buildAndLoad(root, async () => {
  const [{ configuredProvider }, { cleanupLedger }] = await Promise.all([
    import("./providers"),
    import("./fixtures/reconcile"),
  ]);

  const profile = await configuredProvider(saved.connection);
  await cleanupLedger(profile.factory, ledger, profile.cleanupMs);
});

console.log("Owned cleanup confirmed or no resources required cleanup");
