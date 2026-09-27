import { expect, test } from "bun:test";
import { Sandbar, Image } from "sandbar-sdk/direct";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { ProcessFixture } from "../../../packages/sdk-qualification/processes";

test("direct quickstart uses the independent fake provider", async () => {
  const fixture = new ProcessFixture();

  try {
    await fixture.startFake();
    const command = { kind: "argv" as const, argv: ["fixture", "hello"] };
    await fixture.fakeControl("/_test/seed", {
      submissionId: "*",
      action: "exec",
      behavior: "normal",
      command: { command, exitCode: 0, stdoutBase64: Buffer.from("hello").toString("base64") },
    });

    const sandbar = await Sandbar.connect({
      adapter: createFakeAdapter({ url: fixture.fakeUrl!, token: fixture.fakeToken }),
      config: {}, credentials: {},
    });

    try {
      const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });

      try {
        expect((await box.inspect()).state).toBe("running");
        await box.writeFile("/input.bin", Uint8Array.of(0, 255));
        expect(await box.readFile("/input.bin")).toEqual(Uint8Array.of(0, 255));
        const result = await box.exec({ command });
        expect(result.stdoutText(4096)).toBe("hello");
      } finally {
        await box.destroy();
      }
    } finally {
      await sandbar.close();
    }
  } finally {
    await fixture.close();
  }
}, 30_000);
