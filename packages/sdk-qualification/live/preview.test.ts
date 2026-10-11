import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdapterSandbox } from "sandbar-sdk";
import { liveEnabled, setupLive, finishLive } from "./providers";

const provider = process.env.SANDBAR_QUAL_PROVIDER ?? "daytona";

const access = provider === "daytona" ? "protected" : "public";

const enabled =
  liveEnabled &&
  (provider === "daytona" ||
    (provider === "e2b" && process.env.SANDBAR_E2B_PREVIEW_ACCESS === "public"));

describe("Sandbar native HTTP preview", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = await setupLive([`preview-${access}`], { compute: 1, snapshots: 0, volumes: 0 });
    await fixture.resources.setup(async () => {
      await fixture!.resources.open();
      box = await fixture!.resources.create("preview/source");
    });
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    `preview-${access}`,
    async () => {
      const t = fixture!.resources;
      const before = await box.inspect({ signal: t.signal });
      const empty = await box.preview(3001, { signal: t.signal });
      expect(empty.access).toBe(access); // Access exists even before a listener is started.

      const emptyResponse = await fetch(empty.url, {
        headers: empty.access === "protected" ? empty.headers : undefined,
        redirect: "manual",
        signal: t.signal,
      });

      expect(emptyResponse.ok).toBe(false);
      await emptyResponse.body?.cancel();
      expect((await box.inspect({ signal: t.signal })).expires).toEqual(before.expires);

      // Owned compute cleanup stops this server; no process-control extension is exercised.
      const marker = `preview-${t.ledger.runId}`;
      const root = `/tmp/sandbar-preview-${t.ledger.runId}`;
      await box.exec(
        [
          "/bin/sh",
          "-c",
          `mkdir -m 700 '${root}' && printf '%s' '${marker}' > '${root}/index.html' && nohup python3 -m http.server 3000 --bind 0.0.0.0 --directory '${root}' > '${root}/server.log' 2>&1 < /dev/null &`,
        ],
        { signal: t.signal },
      );
      const preview = await box.preview(3000, { signal: t.signal });
      expect(preview.access).toBe(access);
      const headers = preview.access === "protected" ? preview.headers : undefined;
      // Bounded test readiness, independent from preview lookup's availability contract.
      const signal = AbortSignal.any([t.signal, AbortSignal.timeout(20000)]);
      let ready = false;

      while (!signal.aborted) {
        const response = await fetch(preview.url, { headers, redirect: "manual", signal });

        if (response.ok && (await response.text()) === marker) {
          ready = true;
          break;
        }

        await response.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(ready).toBe(true);

      if (preview.access === "protected") {
        for (const auth of [undefined, { "x-daytona-preview-token": "invalid-token" }]) {
          const denied = await fetch(preview.url, {
            headers: auth,
            redirect: "manual",
            signal: t.signal,
          });

          expect(denied.ok).toBe(false);
          await denied.body?.cancel();
        }
      }

      const saved = box.reference!;

      const reopened = await t.client.sandboxes.get(JSON.parse(JSON.stringify(saved)), {
        signal: t.signal,
      });

      expect((await reopened.preview(3000, { signal: t.signal })).access).toBe(access);
      expect(JSON.stringify(saved)).not.toContain("token");
      t.at("preview/owned-cleanup");
      await t.destroy("preview/source");
      await expect(box.preview(3000, { signal: t.signal })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    },
    241000,
  );
});
