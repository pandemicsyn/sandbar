import { expect, test } from "bun:test";
import { Sandbar, Image } from "sandbar-sdk";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { ProcessFixture } from "../../../packages/sdk-qualification/processes";
import { reopenListed } from "./sandbox-reopen";

test("listed references reopen running sandboxes from a fresh connection", async () => {
  const fixture = new ProcessFixture();

  try {
    await fixture.startFake();

    const connect = () =>
      Sandbar.connect({
        adapter: createFakeAdapter({ url: fixture.fakeUrl!, token: fixture.fakeToken }),
        config: {},
        credentials: {},
      });

    const first = await connect();
    const environment = Image.prepared("fake-starter");
    const kept = await first.sandboxes.create({ environment });
    await (await first.sandboxes.create({ environment })).destroy();
    await first.close();

    const fresh = await connect();

    try {
      const reopened = await reopenListed(fresh);
      expect(reopened.map((box) => box.id)).toEqual([kept.id]);
      await reopened[0]!.destroy();
    } finally {
      await fresh.close();
    }
  } finally {
    await fixture.close();
  }
}, 30_000);
