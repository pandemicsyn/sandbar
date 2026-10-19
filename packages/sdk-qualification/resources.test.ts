import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Sandbar as DirectSandbar, Image as DirectImage } from "sandbar-sdk";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { ProcessFixture } from "./processes";

const fixtures: ProcessFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function backend() {
  const fixture = new ProcessFixture();
  fixtures.push(fixture);
  await fixture.startFake();

  const client = await DirectSandbar.connect({
    adapter: createFakeAdapter({ url: fixture.fakeUrl!, token: fixture.fakeToken }),
    config: {},
    credentials: {},
  });

  return { fixture, client, image: DirectImage.prepared("fake-starter") };
}

describe("public SDK resources", () => {
  test("create, inspect, exec, binary file and destroy", async () => {
    const { fixture, client, image } = await backend();
    const command = { kind: "argv" as const, argv: ["fixture", "binary"] };
    const stdout = Uint8Array.from([0xff, 0x00, 0x80, 0x61]);
    const stderr = Uint8Array.from([0xfe, 0x62]);
    await fixture.fakeControl("/_test/seed", {
      submissionId: "*",
      action: "exec",
      behavior: "normal",
      command: {
        command,
        exitCode: 0,
        stdoutBase64: Buffer.from(stdout).toString("base64"),
        stderrBase64: Buffer.from(stderr).toString("base64"),
      },
    });

    try {
      const box = await client.sandboxes.create({ environment: image });
      expect((await box.inspect()).state).toBe("running");
      const execution = await box.exec({ command });
      expect(execution.exitCode).toBe(0);
      expect(execution.stdout).toEqual(stdout);
      expect(execution.stderr).toEqual(stderr);
      const file = Uint8Array.from([0x00, 0xff, 0x81, 0x61]);
      await box.writeFile("/data/binary", file);
      expect(await box.readFile("/data/binary")).toEqual(file);
      await box.destroy();
      expect((await box.inspect()).state).toBe("destroyed");
    } finally {
      await client.close();
    }
  }, 30_000);

  test("nonzero process exit preserves bounded binary output", async () => {
    const { fixture, client, image } = await backend();
    const command = { kind: "argv" as const, argv: ["fixture", "nonzero"] };
    await fixture.fakeControl("/_test/seed", {
      submissionId: "*",
      action: "exec",
      behavior: "normal",
      command: {
        command,
        exitCode: 7,
        stdoutBase64: Buffer.from([0xff, 0x00]).toString("base64"),
        stderrBase64: Buffer.from([0x80, 0x01]).toString("base64"),
      },
    });

    try {
      const box = await client.sandboxes.create({ environment: image });

      try {
        await expect(box.exec({ command })).rejects.toMatchObject({
          name: "NonzeroExitError",
          result: {
            exitCode: 7,
            stdout: Uint8Array.from([0xff, 0x00]),
            stderr: Uint8Array.from([0x80, 0x01]),
          },
        });
      } finally {
        await box.destroy();
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  test("listed sandboxes page with cursors and reopen through their references", async () => {
    const fixture = new ProcessFixture();
    fixtures.push(fixture);
    await fixture.startFake();
    const actions: string[] = [];

    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        actions.push(z.object({ kind: z.string() }).parse(JSON.parse(String(init?.body))).kind);

        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );

    const client = await DirectSandbar.connect({
      adapter: createFakeAdapter({
        url: fixture.fakeUrl!,
        token: fixture.fakeToken,
        fetch: transport,
      }),
      config: {},
      credentials: {},
    });

    try {
      const created = [];
      const environment = DirectImage.prepared("fake-starter");

      for (let index = 0; index < 3; index++)
        created.push(await client.sandboxes.create({ environment }));
      await created[0]!.writeFile("/data/marker", new TextEncoder().encode("listed"));
      await created[2]!.destroy();
      actions.length = 0;

      const first = await client.sandboxes.list({ limit: 2 });
      expect(actions).toEqual(["inventory"]);
      expect(first.coverage).toBe("provider-scope");
      expect(first.items.map((item) => item.id)).toEqual([created[0]!.id, created[1]!.id]);
      expect(first.nextCursor).toBeDefined();

      const second = await client.sandboxes.list({ cursor: first.nextCursor });
      expect(second).toMatchObject({ items: [{ id: created[2]!.id, state: "destroyed" }] });
      expect(second.nextCursor).toBeUndefined();
      expect((await client.sandboxes.list()).items).toHaveLength(3);

      const listed = first.items[0]!;
      expect(listed.state).toBe("running");
      expect(listed.reference).toMatchObject({
        kind: "sandbox",
        provider: "fake",
        nativeId: created[0]!.id,
        ownership: "unknown",
      });
      expect(listed.reference?.receipt).toBeUndefined();

      const reopened = await client.sandboxes.get(listed.reference!);
      expect(reopened.id).toBe(created[0]!.id);
      expect(new TextDecoder().decode(await reopened.readFile("/data/marker"))).toBe("listed");

      await expect(client.sandboxes.get(second.items[0]!.reference!)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      expect(await client.operations.inventory({ limit: 10 })).toEqual({
        items: [
          { id: created[0]!.id, state: "running" },
          { id: created[1]!.id, state: "running" },
          { id: created[2]!.id, state: "destroyed" },
        ],
      });

      for (const limit of [0, 101, 1.5])
        await expect(client.sandboxes.list({ limit })).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      await Promise.all(created.slice(0, 2).map((box) => box.destroy()));
    } finally {
      await client.close();
    }
  }, 30_000);
});
