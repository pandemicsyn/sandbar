import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterSuite } from "sandbar-adapter/testing";
import { createFakeAdapter } from "./adapter";
import { startFakeProviderServer } from "./server";

test("fake public adapter passes the required managed-compute scenarios", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-fake-adapter-suite-"));
  const token = "long-fake-adapter-suite-token";

  const primary = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "primary.json"),
    token,
    testMode: true,
  });

  const alternate = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "alternate.json"),
    token,
    testMode: true,
  });

  const effects = { create: 0, destroy: 0, release: 0 };
  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;

  // SAFETY: The test fixture controls the provider response shape.
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const action = JSON.parse(String(init?.body));
      const response = await fetch(input, init);

      if (action.kind === "create") {
        effects.create++;

        if (lose) {
          lose = false;
          throw new Error("response lost after native effect");
        }

        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
      }

      if (action.kind === "destroy") effects.destroy++;

      return response;
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

  try {
    const adapter = createFakeAdapter({
      url: `http://127.0.0.1:${primary.port}`,
      token,
      fetch: transport,
    });

    const alternateAdapter = createFakeAdapter({
      url: `http://127.0.0.1:${alternate.port}`,
      token,
    });

    const report = await adapterSuite({
      adapter,
      fixture: {
        config: {},
        credentials: {},
        alternate: { config: {}, credentials: {} },
        alternateAdapter,
        expectedReleasesPerConnection: 0,
        createInput: {
          image: { kind: "prepared", value: "fake-starter" },
          networkPolicy: "blocked",
        },
        counters: () => ({ ...effects }),
        loseNextCreateResponse() {
          lose = true;
        },
        holdNextCreateResponse() {
          hold = true;
        },
        releaseHeldCreateResponse() {
          if (!resume) throw new Error("Fake native response was not held");
          resume();
        },
        assertNativeRetriesDisabled() {
          // FakeProviderDriver.call invokes this fetch once per action with no retry middleware.
          expect(effects.create).toBe(0);
        },
      },
    });

    expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
  } finally {
    primary.stop();
    alternate.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
