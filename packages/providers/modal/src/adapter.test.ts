import { expect, test } from "bun:test";
import { adapterSuite } from "sandbar-adapter/testing";
import { createModalAdapter } from "./adapter";
import type { ModalTransport } from "./transport";

test("Modal public adapter passes required managed-compute scenarios", async () => {
  const effects = { create: 0, destroy: 0, release: 0 };
  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();
  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;

  const transportFactory = (): ModalTransport => ({
    async lookupApp(_name, environment) {
      return environment === "main" ? "ap-main" : "ap-alternate";
    },
    async imageExists(id) {
      return id === "im-fixture";
    },
    async create(input) {
      effects.create++;
      const record = { id: `sb-${effects.create}`, tags: input.tags, running: true };
      records.set(input.name, record);

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

      return record.id;
    },
    async findByName(_name, _environment, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      for (const record of records.values()) yield record;
    },
    async terminate(id) {
      effects.destroy++;

      for (const record of records.values()) if (record.id === id) record.running = false;

      return true;
    },
    async readBytes() {
      return new Uint8Array();
    },
    close() {
      effects.release++;
    },
  });

  const adapter = createModalAdapter(transportFactory);

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { appName: "existing", environment: "main", region: "us-east-1" },
      credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
      alternate: {
        config: { appName: "existing", environment: "alternate", region: "us-east-1" },
        credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" },
      },
      createInput: { image: { kind: "prepared", value: "im-fixture" }, networkPolicy: "blocked" },
      counters: () => ({ ...effects }),
      loseNextCreateResponse() {
        lose = true;
      },
      holdNextCreateResponse() {
        hold = true;
      },
      releaseHeldCreateResponse() {
        if (!resume) throw new Error("Native create was not held");
        resume();
      },
      assertNativeRetriesDisabled() {
        // The injected ModalTransport is the exact native boundary; transport.test also
        // qualifies noRetryGrpcMiddleware against the pinned SDK's retry middleware.
        expect(effects.create).toBe(0);
      },
    },
  });

  expect(report.scenarios).toContain("lost response unknown and observation without replay");
  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 2 });
});
