import { expect, spyOn, test } from "bun:test";
import { ControlStore } from "@sandbar/store";
import type { ProviderRegistry } from "./registry";
import type { SecretBox } from "./crypto";
import { DurableRunner } from "./runner";

test("poll failures expose their stage and allowlisted code without error payloads", async () => {
  const sensitive = "secret-provider-token";

  const failure = Object.assign(new Error(sensitive), {
    code: "SQLITE_MISUSE",
    cause: { credentials: sensitive },
  });

  // SAFETY: Only the mocked expireOutputs method is reached before this tick rejects.
  const store = Object.create(ControlStore.prototype) as ControlStore;
  const expire = spyOn(store, "expireOutputs").mockRejectedValue(failure);
  const output = spyOn(console, "error").mockImplementation(() => {});

  const runner = new DurableRunner({
    store,
    // SAFETY: The injected expiry failure prevents registry access.
    registry: {} as ProviderRegistry,
    // SAFETY: The injected expiry failure prevents secret access.
    secrets: {} as SecretBox,
    pollMs: 60_000,
  });

  try {
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output).toHaveBeenCalledWith("Durable runner poll failed; retrying on next interval", {
      stage: "expire_outputs",
      category: "unexpected",
      code: "SQLITE_MISUSE",
    });
    expect(JSON.stringify(output.mock.calls)).not.toContain(sensitive);
    output.mockClear();
    failure.code = sensitive;
    runner.stop();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.mock.calls[0]?.[1]).toEqual({
      stage: "expire_outputs",
      category: "unexpected",
      code: "UNCLASSIFIED",
    });
  } finally {
    runner.stop();
    expire.mockRestore();
    output.mockRestore();
  }
});
