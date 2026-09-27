import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "./index";
import { adapterSuite } from "./testing";

test("public conformance suite runs the required managed adapter scenarios", async () => {
  const effects = { create: 0, destroy: 0, release: 0 };
  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;

  const adapter = defineAdapter({
    name: "fixture.example",
    config: z.strictObject({ endpoint: z.string() }),
    credentials: z.strictObject({ account: z.string() }),
    async connect({ config, credentials, host }) {
      host.onClose(() => {
        effects.release++;
      });

      return {
        scope: {
          authority: { kind: "account", id: credentials.account },
          partition: { endpoint: config.endpoint },
        },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create(_input, _ctx) {
          effects.create++;
          const id = `box-${effects.create}`;

          if (lose) {
            lose = false;
            throw new Error("response lost after effect");
          }

          if (hold) {
            hold = false;
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }

          return { id, state: "running" as const };
        },
        async destroy(_box, _ctx) {
          effects.destroy++;

          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { endpoint: "primary" },
      credentials: { account: "one" },
      alternate: { config: { endpoint: "alternate" }, credentials: { account: "two" } },
      createInput: { image: { kind: "prepared", value: "image" }, networkPolicy: "blocked" },
      counters: () => ({ ...effects }),
      loseNextCreateResponse() {
        lose = true;
      },
      holdNextCreateResponse() {
        hold = true;
      },
      releaseHeldCreateResponse() {
        if (!resume) throw new Error("held native callback did not begin");
        resume();
      },
      assertNativeRetriesDisabled() {
        // The fixture invokes the single create callback directly and has no transport retry middleware.
        expect(effects.create).toBe(0);
      },
    },
  });

  expect(report.scenarios).toContain("lost response unknown and observation without replay");
  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 2 });
});
