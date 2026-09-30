import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbar } from "sandbar-sdk";
import { defineAdapter } from "sandbar-adapter";
import { z } from "zod";
import { LedgerStore } from "../../provider-qualification/ledger";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

export const outcomes = (connected: boolean, error = "timeout") => ({
  attempts: [
    connected ? { target: "hostname", connected } : { target: "hostname", connected, error },
    connected ? { target: "ipv4", connected } : { target: "ipv4", connected, error },
  ],
});

export async function networkFixture(
  replies = [outcomes(true), outcomes(false), outcomes(true)],
  failDestroy = false,
  failCreate = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-network-offline-"));
  directories.push(directory);
  const internet = new LedgerStore(directory, crypto.randomUUID());
  const blocked = new LedgerStore(directory, crypto.randomUUID());

  for (const store of [internet, blocked])
    await store.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" });
  let next = 0;
  const created: string[] = [];
  const destroyed: string[] = [];
  const commands: string[] = [];
  let closes = 0;

  const adapter = defineAdapter({
    name: "network-offline-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        closes++;
      });
      const stopped = new Set<string>();

      return {
        scope: { authority: { kind: "fixture", id: "network" }, partition: {} },
        supports: {
          images: ["prepared"] as const,
          network: ["blocked", "internet"] as const,
          exec: { commands: ["argv"] as const, maxOutputBytes: 4096 },
        },
        async create(input) {
          created.push(input.networkPolicy);

          if (failCreate) throw new Error("offline create failure");

          return { id: `owned-${++next}`, state: "running" as const };
        },
        async exec(input) {
          expect(input.command.kind).toBe("argv");
          expect(input.deadlineSeconds).toBe(20);
          commands.push(input.sandbox.id);

          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(JSON.stringify(replies.shift())),
            stderr: new Uint8Array(),
            truncated: false,
          };
        },
        async destroy(input) {
          destroyed.push(input.id);

          if (failDestroy) throw new Error("offline cleanup failure");
          stopped.add(input.id);

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(input) {
          return {
            id: input.id,
            state: stopped.has(input.id) ? ("destroyed" as const) : ("running" as const),
          };
        },
      };
    },
  });

  const factory = (onReference: Parameters<typeof Sandbar.connect>[0]["onReference"]) =>
    Sandbar.connect({ adapter, config: {}, credentials: {}, onReference });

  return {
    internet,
    blocked,
    created,
    destroyed,
    commands,
    closes: () => closes,
    factory,
  };
}
