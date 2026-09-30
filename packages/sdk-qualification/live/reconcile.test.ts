import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (const artifacts of ["missing", "stale", "failed-build"] as const)
  test(`reconciliation builds before loading ${artifacts} adapter artifacts and reading custody`, async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbar-reconcile-build-"));

    try {
      const live = join(root, "packages/sdk-qualification/live");
      const qualification = join(root, "packages/sdk-qualification/provider-qualification");
      const adapter = join(root, "node_modules/sandbar-adapter");
      await mkdir(join(live, "fixtures"), { recursive: true });
      await mkdir(join(live, "providers"));
      await mkdir(qualification);
      await mkdir(join(adapter, "dist"), { recursive: true });
      await mkdir(join(root, "custody"), { mode: 0o700 });
      await copyFile(
        fileURLToPath(new URL("./reconcile.ts", import.meta.url)),
        join(live, "reconcile.ts"),
      );
      await copyFile(
        fileURLToPath(new URL("../provider-qualification/build.ts", import.meta.url)),
        join(qualification, "build.ts"),
      );
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module", scripts: { "build:packages": "bun build-fixture.ts" } }),
      );
      await writeFile(
        join(adapter, "package.json"),
        JSON.stringify({ name: "sandbar-adapter", type: "module", exports: "./dist/index.js" }),
      );

      if (artifacts === "stale")
        await writeFile(join(adapter, "dist/index.js"), 'export const schemaVersion = "stale";');
      await writeFile(
        join(root, "build-fixture.ts"),
        `
        import { writeFile } from "node:fs/promises";
        await writeFile("trace.log", "build\\n");
        ${artifacts === "failed-build" ? 'throw Error("fixture build failed");' : 'await writeFile("node_modules/sandbar-adapter/dist/index.js", \'export const schemaVersion = "fresh";\');'}
      `,
      );
      // Only the package boundary is synthetic: the entrypoint and rebuild helper are unchanged.
      await writeFile(
        join(qualification, "ledger.ts"),
        `
        import { appendFile } from "node:fs/promises";
        import { schemaVersion } from "sandbar-adapter";
        await appendFile("trace.log", "ledger:" + schemaVersion + "\\n");
        export async function requirePrivateDirectory() {}
        export class LedgerStore {
          async read() {
            await appendFile("trace.log", "read:" + schemaVersion + "\\n");
            return { provider: "fixture", connection: { schemaVersion } };
          }
        }
      `,
      );
      await writeFile(
        join(live, "providers/index.ts"),
        `
        export async function configuredProvider(connection) {
          if (process.env.SANDBAR_QUAL_PROVIDER !== "fixture" || connection.schemaVersion !== "fresh")
            throw Error("Stale custody schema");
          return { factory: "fresh", cleanupMs: 1000 };
        }
      `,
      );
      await writeFile(
        join(live, "fixtures/reconcile.ts"),
        `
        import { appendFile } from "node:fs/promises";
        export async function cleanupLedger(factory, ledger) {
          if (factory !== "fresh" || (await ledger.read()).connection.schemaVersion !== "fresh")
            throw Error("Stale cleanup schema");
          await appendFile("trace.log", "cleanup:fresh\\n");
        }
      `,
      );

      const child = Bun.spawnSync(
        [process.execPath, join(live, "reconcile.ts"), crypto.randomUUID()],
        {
          cwd: root,
          env: {
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
            SANDBAR_QUAL_LEDGER_DIR: join(root, "custody"),
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );

      const trace = await readFile(join(root, "trace.log"), "utf8");

      if (artifacts === "failed-build") {
        expect(child.exitCode).not.toBe(0);
        expect(trace).toBe("build\n");
        expect(new TextDecoder().decode(child.stdout)).not.toContain("Owned cleanup confirmed");
      } else {
        expect(new TextDecoder().decode(child.stderr)).not.toContain("error:");
        expect(child.exitCode).toBe(0);
        expect(trace).toBe("build\nledger:fresh\nread:fresh\nread:fresh\ncleanup:fresh\n");
        expect(new TextDecoder().decode(child.stdout)).toContain("Owned cleanup confirmed");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);
