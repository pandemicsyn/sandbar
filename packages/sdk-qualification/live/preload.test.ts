import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("./preload.ts", import.meta.url));

test("live preload refuses missing authorization and ordinary CI before loading credentials or builds", () => {
  for (const extra of [
    { SANDBAR_QUAL_LIVE_AUTHORIZED: "no" },
    { CI: "1", SANDBAR_QUAL_LIVE_AUTHORIZED: "yes" },
  ]) {
    const result = Bun.spawnSync([process.execPath, path], {
      env: {
        ...process.env,
        CI: "",
        SANDBAR_LIVE: "1",
        SANDBAR_CREDENTIALS_FILE: "/dev/null/never-read",
        ...extra,
      },
    });

    expect(result.exitCode).not.toBe(0);
    const error = new TextDecoder().decode(result.stderr);
    expect(error).toContain("require explicit authorization");
    expect(error).not.toContain("Unable to read Sandbar credential");
  }
});
