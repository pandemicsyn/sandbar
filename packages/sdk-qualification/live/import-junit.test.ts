import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseReport, renderLiveMatrix } from "../provider-qualification/report";

const importer = fileURLToPath(new URL("./import-junit.py", import.meta.url));

for (const name of [
  "snapshot-roundtrip",
  "sandbox-lifecycle",
  "execution",
  "execution-stdin",
  "files",
  "network-controls",
] as const)
  for (const mode of [
    "pass",
    "assertion",
    "setup",
    "teardown",
    "skip",
    "cleanup",
    "dirty",
  ] as const)
    test(`standard Bun JUnit ${name} ${mode} cannot fabricate support evidence`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "sandbar-junit-"));

      try {
        const context = {
          provider: "daytona",
          names: [name],
          dirty: mode === "dirty",
          sdkCommit: "a".repeat(40),
          harnessCommit: "a".repeat(40),
          sdkVersion: "0.1.0",
          nativeVersion: "fixture",
          runtime: `Bun ${Bun.version}`,
          platform: "offline",
          timestamp: "2026-09-30T00:00:00Z",
          configuration: {
            imageClass: "prepared",
            network: "blocked-requested",
            regionClass: "fixture",
            stateProbe: "snapshot-roundtrip-v3",
            freshProcess: true,
            preserve: "filesystem",
            restoreExecution: "fresh",
            sourceAfter: "running",
          },
          cleanup: mode === "cleanup" ? "unresolved" : "confirmed",
          closeSucceeded: true,
          runId: "PRIVATE-CUSTODY-DO-NOT-COPY",
          privateHostname: "private.example.invalid",
        };

        await mkdir(join(dir, "contexts"));
        await writeFile(join(dir, "contexts", `${name}.context.json`), JSON.stringify(context));
        await writeFile(
          join(dir, "ordinary.test.ts"),
          `import {beforeAll,afterAll,describe,test,expect} from "bun:test";describe("Sandbar workflow",()=>{beforeAll(()=>{${mode === "setup" ? 'throw Error("private setup error")' : ""}});afterAll(()=>{${mode === "teardown" ? 'throw Error("private close error")' : ""}});${mode === "skip" ? "test.skip" : "test"}("${name}",()=>{expect(true).toBe(true);expect(${mode === "assertion" ? "false" : "true"}).toBe(true);});});`,
        );

        const child = Bun.spawn(
          [
            process.execPath,
            "test",
            join(dir, "ordinary.test.ts"),
            "--reporter=junit",
            `--reporter-outfile=${join(dir, "junit.xml")}`,
          ],
          { stdout: "ignore", stderr: "ignore", env: { ...process.env, SANDBAR_LIVE: "0" } },
        );

        const exit = await child.exited;

        const imported = Bun.spawnSync([
          "python3",
          importer,
          "--junit",
          join(dir, "junit.xml"),
          "--contexts",
          join(dir, "contexts"),
          "--exit-code",
          String(exit),
          "--evidence-ref",
          "fixture/junit",
          "--output",
          join(dir, "report.json"),
        ]);

        if (mode === "dirty" || mode === "setup") {
          expect(imported.exitCode).not.toBe(0);

          return;
        }

        expect(new TextDecoder().decode(imported.stderr)).toBe("");
        expect(imported.exitCode).toBe(0);
        const raw = await readFile(join(dir, "report.json"), "utf8");
        expect(raw).not.toContain(context.runId);
        expect(raw).not.toContain("private close error");
        expect(raw).not.toContain(context.privateHostname);
        const report = parseReport(JSON.parse(raw));
        expect(report.records[0]?.status).toBe(
          (
            {
              pass: "passed",
              skip: "not-run",
              assertion: "failed",
              teardown: "failed",
              cleanup: "failed",
            } as const
          )[mode],
        );

        if (mode === "assertion") {
          const newer = report.records[0]!;
          const prior = { ...newer, status: "passed" as const, timestamp: "2026-09-29T00:00:00Z" };

          const matrix = renderLiveMatrix([
            parseReport({ schemaVersion: 1, records: [prior, newer] }),
          ]);

          expect(matrix).toContain("failed");
          expect(matrix).not.toContain("| passed |");
        }

        expect(report.records).toHaveLength(1);
        expect(report.records[0]?.scenario).toBe(name);
        expect(report.records[0]?.runner?.testName).toBe(name);
        expect(() =>
          parseReport({
            schemaVersion: 1,
            records: [{ ...report.records[0], status: "passed", runCleanup: "incomplete" }],
          }),
        ).toThrow("confirmed test-owned cleanup");
        expect(renderLiveMatrix([report])).toContain(name);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 10000);
