import { expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { sandboxReference } from "@sandbar-sdk/adapter";
import { createE2BAdapter } from "./index";
import type { E2BRecord } from "./transport";

const owned = (id: string, state: E2BRecord["state"] = "running"): E2BRecord => ({
  id,
  templateId: "template_1",
  state,
  metadata: {
    sandbar_scope: "team_one:template_1",
    sandbar_template: "template_1",
    sandbar_submission: `sub_${id}`,
    sandbar_operation: `op_${id}`,
  },
});

function fixture(records: E2BRecord[]) {
  const lists: { metadata: Record<string, string>; limit: number; nextToken?: string }[] = [];
  const gets: string[] = [];

  const adapter = createE2BAdapter(() => ({
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async buildImage() {
      throw Error("unused");
    },
    async findBuild() {
      return null;
    },
    async create() {
      throw Error("unused");
    },
    async get(id) {
      gets.push(id);

      return records.find((record) => record.id === id) ?? null;
    },
    async list(metadata, limit, nextToken) {
      lists.push({ metadata, limit, nextToken });
      const offset = Number(nextToken ?? "0");
      const next = offset + limit < records.length ? String(offset + limit) : undefined;

      return { items: records.slice(offset, offset + limit), nextToken: next };
    },
    async kill() {
      throw Error("unused");
    },
    async run() {
      return "";
    },
    async read() {
      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {},
  }));

  return {
    lists,
    gets,
    connect: () =>
      Sandbar.connect({
        adapter,
        config: { teamId: "team_one", templateId: "template_1" },
        credentials: { apiKey: "fixture-key" },
      }),
  };
}

test("E2B lists only this binding's Sandbar-created sandboxes and reopens them", async () => {
  const foreign = owned("foreign_scope");
  foreign.metadata.sandbar_scope = "team_two:template_1";
  const unmarked = { ...owned("unmarked"), metadata: {} };
  const records = [owned("one"), foreign, unmarked, owned("paused", "paused"), owned("two")];
  const f = fixture(records);
  const client = await f.connect();

  try {
    const first = await client.sandboxes.list({ limit: 4 });
    expect(f.lists).toEqual([{ metadata: { sandbar_scope: "team_one:template_1" }, limit: 4 }]);
    expect(f.gets).toEqual([]);
    expect(first.coverage).toBe("sandbar-managed");
    expect(first.nextCursor).toBe("4");
    expect(first.items.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "one", state: "running" },
      { id: "paused", state: "suspended" },
    ]);

    const scope = {
      authority: { kind: "team", id: "team_one" },
      partition: { endpoint: "https://api.e2b.app", template: "template_1" },
    };

    expect(first.items[0]!.reference).toEqual(
      sandboxReference("e2b", scope, "one", { operation: "op_one", submission: "sub_one" }),
    );

    const second = await client.sandboxes.list({ cursor: first.nextCursor, limit: 4 });
    expect(f.lists[1]).toEqual({
      metadata: { sandbar_scope: "team_one:template_1" },
      limit: 4,
      nextToken: "4",
    });
    expect(second.items.map((item) => item.id)).toEqual(["two"]);
    expect(second.nextCursor).toBeUndefined();

    const reopened = await client.sandboxes.get(first.items[0]!.reference!);
    expect(reopened.id).toBe("one");
    expect(f.gets).toEqual(["one"]);
  } finally {
    await client.close();
  }
});

test("E2B lists create labels without its own markers, and the start time", async () => {
  const labelled = owned("labelled");
  labelled.metadata.run = "42";
  labelled.startedAt = "2026-10-23T10:00:00.000Z";
  const f = fixture([labelled, owned("plain")]);
  const client = await f.connect();

  try {
    const page = await client.sandboxes.list();
    expect(page.items.map(({ id, labels, createdAt }) => ({ id, labels, createdAt }))).toEqual([
      { id: "labelled", labels: { run: "42" }, createdAt: "2026-10-23T10:00:00.000Z" },
      { id: "plain", labels: {}, createdAt: null },
    ]);
  } finally {
    await client.close();
  }
});
