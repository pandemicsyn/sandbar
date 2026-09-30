import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

const providerModule = new URL("./index.ts", import.meta.url).href;

for (const alias of [false, true])
  test(`private ledger ${alias ? "symlink target" : "directory"} inside checkout is rejected before provider setup`, async () => {
    const directory = await mkdtemp(join(checkout, ".sandbar-ledger-test-"));
    const links = alias ? await mkdtemp(join(tmpdir(), "sandbar-ledger-link-")) : undefined;

    try {
      const supplied = links ? join(links, "ledger") : directory;

      if (links) await symlink(directory, supplied);

      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `import { setupLive } from ${JSON.stringify(providerModule)};
        globalThis.sandbarLiveBuild = {revision: "a".repeat(40), dirty: false};
        try { await setupLive(["sandbox-lifecycle"], {compute: 0, snapshots: 0, volumes: 0}); process.exit(0); }
        catch (error) { console.error(error.message); process.exit(1); }`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            SANDBAR_LIVE: "1",
            SANDBAR_QUAL_LIVE_AUTHORIZED: "yes",
            SANDBAR_QUAL_LEDGER_DIR: supplied,
            // Missing report directory also prevents provider I/O if containment regresses.
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(child.exitCode).toBe(1);
      expect(new TextDecoder().decode(child.stderr).trim()).toBe(
        "Custody requires stable private storage outside checkout/temp",
      );
    } finally {
      if (links) await rm(links, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
