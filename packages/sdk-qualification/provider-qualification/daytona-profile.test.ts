import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daytonaConfiguration, daytonaConnection } from "./daytona-profile";
import { LedgerStore } from "./ledger";
import { TestResources } from "../live/fixtures/resources";
import { cleanupLedger } from "../live/fixtures/reconcile";
import { lifecycle, execution, files } from "../live/sandbox.test";
import { recordLegacyReference as recordReference } from "./ledger";
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
        // SAFETY: The fixture compares only the provider field persisted by the public SDK pre-dispatch hook.
        expect(
          saved.createReference?.provider ??
            (
              saved.stateMutations?.find((entry) => entry.creation)?.reference as {
                provider: string;
              }
            )?.provider,
        ).toBe("daytona");
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
        const saved = await ledger.read();
        // SAFETY: The fixture compares only the provider field persisted by the public SDK pre-dispatch hook.
        expect(
          saved.destroyReference?.provider ??
            (
              saved.stateMutations?.find(
                (entry) => !entry.creation && entry.role.endsWith("/delete"),
              )?.reference as { provider: string }
            )?.provider,
        ).toBe("daytona");
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

function resources(
  native: Awaited<ReturnType<typeof fixture>>,
  network = native.config.networkPolicy,
) {
  return new TestResources(native.factory, native.ledger, native.config.snapshotId, network, {
    compute: 1,
    snapshots: 0,
    volumes: 0,
    exerciseMs: 5000,
    cleanupMs: 1000,
  });
}

for (const networkPolicy of ["blocked", "daytona-default"] as const)
  test(`Daytona ${networkPolicy} public baseline retains native lifetime and independent owned cleanup`, async () => {
    const native = await fixture({
      networkPolicy,
      publicSnapshot: networkPolicy === "daytona-default",
      restricted: networkPolicy === "daytona-default",
    });

    await native.use(async () => {
      const t = resources(native);

      try {
        await t.open();
        const box = await t.create("sandbox/source");
        await lifecycle(t, box);
        await execution(t, box);
        await files(t, box);
      } finally {
        await t.close();
      }
    });
    expect(native.counters).toEqual({ create: 1, destroy: 1, upload: 3, build: 0 });
    expect((await native.ledger.read()).cleanup).toBe("confirmed");

    if (networkPolicy === "daytona-default") expect(native.organizationReads()).toBe(0);
  });

for (const networkPolicy of ["blocked", "daytona-default"] as const)
  for (const mode of ["loseCreate", "loseDestroy"] as const)
    test(`Daytona ${networkPolicy} ${mode} is observed without mutation replay`, async () => {
      const native = await fixture({
        networkPolicy,
        publicSnapshot: networkPolicy === "daytona-default",
        [mode]: true,
      });

      await native.use(async () => {
        const t = resources(native);
        await t.open();

        try {
          if (mode === "loseCreate") await expect(t.create("sandbox/source")).rejects.toThrow();
          else await t.create("sandbox/source");
        } finally {
          try {
            await t.close();
          } catch {
            await cleanupLedger(native.factory, native.ledger, 1000);
          }
        }
      });
      expect(native.counters.create).toBe(1);
      expect(native.counters.destroy).toBe(1);
      expect((await native.ledger.read()).cleanup).toBe("confirmed");
    });

test("Daytona rejects restricted authority, foreign snapshot and incompatible requested policy before native allocation", async () => {
  for (const opts of [
    { restricted: true },
    { networkPolicy: "daytona-default" as const, foreignPrivateSnapshot: true },
    { networkPolicy: "daytona-default" as const, publicSnapshot: true },
  ]) {
    const native = await fixture(opts);
    await native.use(async () => {
      const t = resources(native, "blocked");

      try {
        await t.open();
        await expect(t.create("sandbox/source")).rejects.toMatchObject({ code: "UNSUPPORTED" });
      } finally {
        await t.close();
      }
    });
    expect(native.counters.create).toBe(0);
    expect((await native.ledger.read()).cleanup).toBe("not-required");
  }

  expect(() =>
    daytonaConfiguration.parse({ target: "us", snapshotId: "snap-fixture", ttlMinutes: 60 }),
  ).toThrow();
});

test("Daytona default recovery rejects import into strict scope", async () => {
  const native = await fixture({ networkPolicy: "daytona-default", publicSnapshot: true });
  await native.use(async () => {
    const t = resources(native);

    try {
      await t.open();
      await t.create("sandbox/source");

      // SAFETY: This receipt was saved by the public SDK hook; recover validates schema and scope.
      const ref = (await native.ledger.read()).stateMutations![0]!
        .reference as import("sandbar-sdk").AdapterRecoveryReference;

      const strict = await daytonaConnection(
        { ...native.config, networkPolicy: "blocked" },
        "synthetic-fixture-key",
      )(async () => {});

      try {
        await expect(strict.recover(ref)).rejects.toThrow();
      } finally {
        await strict.close();
      }
    } finally {
      await t.close();
    }
  });
  expect(native.counters.create).toBe(1);
  expect(native.counters.destroy).toBe(1);
});

test("Daytona legacy asynchronous delete receipt reconnects and observes without replay", async () => {
  const native = await fixture({
    networkPolicy: "daytona-default",
    publicSnapshot: true,
    asynchronousDelete: true,
  });

  await native.use(async () => {
    const client = await native.factory((ref) => recordReference(native.ledger, ref));

    const box = await client.sandboxes.create({
      environment: Image.prepared(native.config.snapshotId),
      networkPolicy: "daytona-default",
    });

    await native.ledger.update((v) => ({ ...v, createIntent: true, sandboxId: box.id }));

    const op = await client.submit("destroy", { id: box.id }, () => undefined, {
      sandboxId: box.id,
    });

    expect(await op.observe()).toBeNull();
    await recordReference(native.ledger, op.reference);
    await client.close();
    await cleanupLedger(native.factory, native.ledger, 1000);
  });
  expect(native.counters.create).toBe(1);
  expect(native.counters.destroy).toBe(1);
  expect((await native.ledger.read()).cleanup).toBe("confirmed");
});
