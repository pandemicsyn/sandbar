import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daytonaConfiguration, daytonaConnection } from "./daytona-profile";
import { LedgerStore } from "./ledger";
import { runPrepared, reconcileConnection, recordReference } from "./lifecycle";
import { Image } from "sandbar-sdk";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  options: {
    loseCreate?: boolean;
    loseDestroy?: boolean;
    restricted?: boolean;
    networkPolicy?: "blocked" | "daytona-default";
    publicSnapshot?: boolean;
    foreignPrivateSnapshot?: boolean;
    asynchronousDelete?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-daytona-qualification-"));
  directories.push(directory);

  const config = daytonaConfiguration.parse({
    target: "us",
    snapshotId: options.publicSnapshot ? "public-small" : "snap-fixture",
    networkPolicy: options.networkPolicy,
  });

  let organizationReads = 0;
  const ledger = new LedgerStore(directory, crypto.randomUUID());
  await ledger.initialize("daytona", { kind: "borrowed-prepared", class: "prepared" }, config);
  const counters = { create: 0, destroy: 0, upload: 0, build: 0 };

  let native:
    | {
        id: string;
        name: string;
        organizationId: string;
        target: string;
        state: string;
        networkBlockAll: boolean;
        public: boolean;
        labels: Record<string, string>;
        snapshot: string;
        toolboxProxyUrl: string;
      }
    | undefined;

  const path = (filename: string) => {
    if (!filename.startsWith("/tmp/"))
      throw new Error("Offline fixture path outside owned directory");

    return join(directory, filename.slice(5));
  };

  const originalFetch = globalThis.fetch;

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-fixture" });

      if (url.pathname === "/api/regions")
        return Response.json([
          { id: "us", name: "US", regionType: "shared", organizationId: "org-fixture" },
        ]);

      if (url.pathname === "/api/organizations/org-fixture") {
        organizationReads++;

        if (options.networkPolicy === "daytona-default") return new Response(null, { status: 401 });

        return Response.json({
          id: "org-fixture",
          sandboxLimitedNetworkEgress: Boolean(options.restricted),
        });
      }

      if (url.pathname === `/api/snapshots/${config.snapshotId}`)
        return Response.json({
          id: "snap-fixture",
          name: options.publicSnapshot ? "public-small" : undefined,
          general: Boolean(options.publicSnapshot),
          organizationId:
            options.publicSnapshot || options.foreignPrivateSnapshot
              ? "catalog-org"
              : "org-fixture",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (url.pathname === "/api/snapshots" && method === "POST") {
        counters.build++;
        throw new Error("Prepared profile cannot build");
      }

      if (url.pathname === "/api/sandbox" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.ttlMinutes).toBe(15);
        expect(body.snapshot).toBe(options.publicSnapshot ? "public-small" : "snap-fixture");

        if (config.networkPolicy === "blocked") expect(body.networkBlockAll).toBe(true);
        else expect(body).not.toHaveProperty("networkBlockAll");
        const saved = await ledger.read();
        expect(saved.createIntent).toBe(true);
        expect(saved.createReference?.provider).toBe("daytona");
        counters.create++;
        native = {
          ...body,
          networkBlockAll: body.networkBlockAll ?? false,
          id: "owned-daytona",
          organizationId: "org-fixture",
          target: "us",
          state: "started",
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        };

        if (options.loseCreate) throw new Error("lost offline create acknowledgement");

        return Response.json(native);
      }

      if (url.pathname === "/api/sandbox" && method === "GET")
        return Response.json({ items: native ? [native] : [] });

      if (url.pathname === "/api/sandbox/owned-daytona" && method === "DELETE") {
        expect((await ledger.read()).destroyReference?.provider).toBe("daytona");
        counters.destroy++;
        native!.state = "destroyed";

        if (options.loseDestroy) throw new Error("lost offline delete acknowledgement");

        if (options.asynchronousDelete) {
          native = undefined;

          return new Response(null, { status: 204 });
        }

        return Response.json(native);
      }

      if (url.pathname === "/api/sandbox/owned-daytona")
        return native ? Response.json(native) : new Response(null, { status: 404 });

      if (url.pathname.endsWith("/process/execute")) {
        const body = JSON.parse(String(init?.body));

        const script = String(body.command)
          .replaceAll("/tmp/", `${directory}/`)
          .replaceAll("'/tmp'", `'${directory}'`)
          .replaceAll("ln -T --", `${process.platform === "darwin" ? "gln" : "ln"} -T --`);

        const output = Bun.spawnSync({
          cmd: ["/bin/sh", "-c", script],
          cwd: directory,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });

        return Response.json({
          exitCode: output.exitCode,
          result: new TextDecoder().decode(output.stdout),
        });
      }

      if (url.pathname.endsWith("/files/upload-v2")) {
        counters.upload++;

        if (!(init?.body instanceof FormData)) throw new Error("Expected fixture upload form");
        const file = init.body.get("file");

        if (!(file instanceof Blob)) throw new Error("Expected fixture upload blob");
        await writeFile(
          path(url.searchParams.get("path")!),
          new Uint8Array(await file.arrayBuffer()),
        );

        return Response.json({ name: "payload", path: url.searchParams.get("path"), type: "file" });
      }

      if (url.pathname.endsWith("/files/download")) {
        try {
          return new Response(await readFile(path(url.searchParams.get("path")!)));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return new Response(null, { status: 404 });
          throw error;
        }
      }

      throw new Error(`Unexpected offline Daytona route ${url.pathname}`);
    },
    { preconnect: originalFetch.preconnect },
  );

  return {
    ledger,
    config,
    counters,
    organizationReads: () => organizationReads,
    async use<T>(work: () => Promise<T>) {
      globalThis.fetch = fetcher;

      try {
        return await work();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    factory: daytonaConnection(config, "synthetic-fixture-key"),
  };
}

test("Daytona public prepared profile runs baseline with bounded TTL and owned cleanup", async () => {
  const native = await fixture();

  const steps = await native.use(() =>
    runPrepared(native.factory, native.ledger, native.config.snapshotId, {
      network: "blocked",
      cleanupWaitMs: 1000,
    }),
  );

  expect(steps.every((step) => step.status === "passed")).toBe(true);
  expect(native.counters).toEqual({ create: 1, destroy: 1, upload: 3, build: 0 });
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
  expect((await native.ledger.read()).connection).toEqual(native.config);
});

test.each(["loseCreate", "loseDestroy"] as const)(
  "Daytona %s is observed without mutation replay",
  async (mode) => {
    const native = await fixture({ [mode]: true });
    await native.use(async () => {
      await runPrepared(native.factory, native.ledger, native.config.snapshotId, {
        network: "blocked",
        cleanupWaitMs: 1000,
        selectedScenarios: new Set(["inspect"]),
      });
      await reconcileConnection(native.factory, native.ledger, 1000);
    });
    expect(native.counters.create).toBe(1);
    expect(native.counters.destroy).toBe(1);
    expect(native.counters.build).toBe(0);
    expect((await native.ledger.read()).cleanup).toBe("confirmed");
  },
);

test("Daytona restricted organization rejects before native allocation", async () => {
  const native = await fixture({ restricted: true });

  const steps = await native.use(() =>
    runPrepared(native.factory, native.ledger, native.config.snapshotId, {
      network: "blocked",
      cleanupWaitMs: 100,
    }),
  );

  expect(steps.find((step) => step.scenario === "create-prepared")?.status).toBe("unsupported");
  expect(native.counters.create).toBe(0);
  expect(native.counters.destroy).toBe(0);
  expect((await native.ledger.read()).cleanup).toBe("not-required");
});

test("Daytona manual preflight rejects unapproved or unsupported runs before operator credentials", () => {
  for (const action of ["live-prepared", "live-network"]) {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "packages/sdk-qualification/provider-qualification/manual.ts",
        action,
      ],
      env: { SANDBAR_QUAL_PROVIDER: "daytona", SANDBAR_CREDENTIALS_FILE: "/dev/null/never-read" },
    });

    const message = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(message).toMatch(/SANDBAR_QUAL_LIVE_AUTHORIZED|E2B internet-mode support/);
    expect(message).not.toContain("Unable to read Sandbar credential file");
  }

  expect(() =>
    daytonaConfiguration.parse({ target: "us", snapshotId: "snap-fixture", ttlMinutes: 60 }),
  ).toThrow();
});

test("Daytona default policy qualifies a public borrowed snapshot without organization-management access", async () => {
  const native = await fixture({
    networkPolicy: "daytona-default",
    publicSnapshot: true,
    restricted: true,
  });

  const steps = await native.use(() =>
    runPrepared(native.factory, native.ledger, native.config.snapshotId, {
      network: "daytona-default",
      cleanupWaitMs: 1000,
    }),
  );

  expect(steps.every((step) => step.status === "passed")).toBe(true);
  expect(native.organizationReads()).toBe(0);
  expect(native.counters).toEqual({ create: 1, destroy: 1, upload: 3, build: 0 });
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});

test.each(["loseCreate", "loseDestroy"] as const)(
  "Daytona default %s preserves scoped recovery without replay",
  async (mode) => {
    const native = await fixture({
      networkPolicy: "daytona-default",
      publicSnapshot: true,
      [mode]: true,
    });

    await native.use(async () => {
      await runPrepared(native.factory, native.ledger, native.config.snapshotId, {
        network: "daytona-default",
        cleanupWaitMs: 1000,
        selectedScenarios: new Set(["inspect"]),
      });
      await reconcileConnection(native.factory, native.ledger, 1000);
    });
    expect(native.organizationReads()).toBe(0);
    expect(native.counters.create).toBe(1);
    expect(native.counters.destroy).toBe(1);
    expect((await native.ledger.read()).cleanup).toBe("confirmed");
  },
);

test("Daytona default connection rejects a strict blocked request without fallback", async () => {
  const native = await fixture({ networkPolicy: "daytona-default", publicSnapshot: true });

  const steps = await native.use(() =>
    runPrepared(native.factory, native.ledger, native.config.snapshotId, {
      network: "blocked",
      cleanupWaitMs: 100,
    }),
  );

  expect(steps.find((step) => step.scenario === "create-prepared")?.status).toBe("unsupported");
  expect(native.counters.create).toBe(0);
  expect(native.organizationReads()).toBe(0);
  expect((await native.ledger.read()).cleanup).toBe("not-required");
});

test("Daytona default rejects a foreign private snapshot before allocation", async () => {
  const native = await fixture({ networkPolicy: "daytona-default", foreignPrivateSnapshot: true });

  const steps = await native.use(() =>
    runPrepared(native.factory, native.ledger, native.config.snapshotId, {
      network: "daytona-default",
      cleanupWaitMs: 100,
    }),
  );

  expect(steps.find((step) => step.scenario === "create-prepared")?.status).toBe("unsupported");
  expect(native.counters.create).toBe(0);
  expect((await native.ledger.read()).cleanup).toBe("not-required");
});

test("Daytona default recovery cannot be imported into a strict blocked connection", async () => {
  const native = await fixture({ networkPolicy: "daytona-default", publicSnapshot: true });

  await native.use(async () => {
    await runPrepared(native.factory, native.ledger, native.config.snapshotId, {
      network: "daytona-default",
      cleanupWaitMs: 1000,
      selectedScenarios: new Set(["inspect"]),
    });
    const reference = (await native.ledger.read()).createReference!;

    const strict = await daytonaConnection(
      { ...native.config, networkPolicy: "blocked" },
      "synthetic-fixture-key",
    )(async () => {});

    try {
      await expect(strict.recover(reference)).rejects.toThrow();
    } finally {
      await strict.close();
    }
  });
  expect(native.counters.create).toBe(1);
  expect(native.counters.destroy).toBe(1);
});

test("Daytona asynchronous delete acknowledgment survives reconnect and confirms disappearance", async () => {
  const native = await fixture({
    networkPolicy: "daytona-default",
    publicSnapshot: true,
    asynchronousDelete: true,
  });

  await native.use(async () => {
    await native.ledger.update((value) => ({ ...value, createIntent: true }));
    const client = await native.factory((reference) => recordReference(native.ledger, reference));

    const box = await client.sandboxes.create({
      environment: Image.prepared(native.config.snapshotId),
      networkPolicy: "daytona-default",
    });

    await native.ledger.update((value) => ({ ...value, sandboxId: box.id }));

    const deletion = await client.submit("destroy", { id: box.id }, () => undefined, {
      sandboxId: box.id,
    });

    expect(await deletion.observe()).toBeNull();
    await recordReference(native.ledger, deletion.reference);
    await client.close();
    await native.ledger.update((value) => ({ ...value, cleanup: "unresolved" }));

    const steps = await reconcileConnection(native.factory, native.ledger, 1000);
    expect(steps.find((step) => step.scenario === "destroy")?.status).toBe("passed");
    expect((await native.ledger.read()).cleanup).toBe("confirmed");
  });
  expect(native.counters.create).toBe(1);
  expect(native.counters.destroy).toBe(1);
});
