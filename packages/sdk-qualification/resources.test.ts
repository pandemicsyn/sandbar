import { afterEach, describe, expect, test } from "bun:test";
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
});
