import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import {
  AdapterCheckpointError,
  connectAdapter,
  createAttemptContext,
  operationParts,
  type Json,
} from "@sandbar-sdk/adapter";
import { adapterSuite, snapshotSuite } from "@sandbar-sdk/adapter/testing";
import { Image, Preserve, Sandbar, type ExecInput } from "sandbar-sdk";
import { createVercelAdapter } from "./adapter";
import type { VercelTransport } from "./transport";

export function fixture() {
  const effects = { create: 0, destroy: 0, release: 0 };

  const records = new Map<
    string,
    {
      id: string;
      region: string;
      status: string;
      networkPolicy: { mode: string };
      startedAt?: number;
      timeout?: number;
      sourceSnapshotId?: string;
    }
  >();

  const logical = new Map<
    string,
    {
      name: string;
      currentSessionId: string;
      persistent: boolean;
      createdAt: number;
      tags: Record<string, string>;
      image: string;
      mounts: Record<string, never>;
      region: string;
      status: string;
      networkPolicy: { mode: string };
      currentSnapshotId?: string;
    }
  >();

  let resumeCount = 0;
  let loseResume = false;
  let loseDelete = false;
  let badResumeSource = false;
  let raceDuringInventory = false;
  const files = new Map<string, Uint8Array>();
  const fsCommands = new Map<string, string>();

  const snapshots = new Map<
    string,
    { id: string; sourceSessionId: string; region: string; status: string; createdAt: number }
  >();

  const requests: Array<{ url: URL; init: RequestInit }> = [];
  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;
  let createStatus = 200;
  let createError: Json = { error: "fixture" };
  let mismatch = false;
  let malformedCreate = false;
  let malformedSnapshot = false;
  let wrongCreateName = false;
  let createPending = false;
  let mutationFailure: { suffix: string; status: number | "lost" } | undefined;
  let loseWait = false;
  let confirmedExit: number | undefined;
  let receiptPath = "/tmp/sandbar-exec-Fixture/receipt.json";
  const json = (value: Json, status = 200) => Response.json(value, { status });

  const factory = (): VercelTransport => ({
    async fetch(url, init) {
      const parsed = new URL(url);
      requests.push({ url: parsed, init });
      expect(parsed.origin).toBe("https://vercel.com");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-token");
      const teamId = parsed.searchParams.get("teamId");
      const route = parsed.pathname;

      if (init.method === "POST" && mutationFailure && route.endsWith(mutationFailure.suffix)) {
        if (mutationFailure.status === "lost") throw new Error("lost native mutation response");

        return json({ error: "injected mutation failure" }, mutationFailure.status);
      }

      if (route.startsWith("/api/v2/teams/")) return json({ id: teamId });

      if (route.startsWith("/api/v2/projects/"))
        return json({ id: route.split("/").at(-1)!, accountId: mismatch ? "wrong-team" : teamId });

      if (route === "/api/v2/sandboxes") {
        const all = [
          ...[...records.values()].map((session) => ({
            ...session,
            name: session.id,
            currentSessionId: session.id,
            persistent: false,
            mounts: {},
            image: `vercel/sandbox/node@sha256:${"a".repeat(64)}`,
          })),
          // Persistent named sandboxes follow their session records.
          ...[...logical.values()].filter((box) => box.persistent),
        ];

        const offset = Number(parsed.searchParams.get("cursor") ?? "0");
        const limit = Number(parsed.searchParams.get("limit") ?? "100");

        return json({
          sandboxes: all.slice(offset, offset + limit),
          pagination: { next: offset + limit < all.length ? String(offset + limit) : null },
        });
      }

      if (route === "/api/v3/sandboxes") {
        effects.create++;

        if (createStatus !== 200) return json(createError, createStatus);
        const input = JSON.parse(String(init.body));
        expect(input).toMatchObject({ projectId: "project-fixture" });
        expect(input.tags.sandbarSubmission).toBeString();

        const session = {
          id: `session-${effects.create}`,
          region: input.region,
          startedAt: Date.now(),
          timeout: input.timeout,
          vcpus: input.resources.vcpus,
          sourceSnapshotId: input.source?.snapshotId,
          status: createPending ? "pending" : "running",
          networkPolicy: input.networkPolicy,
        };

        records.set(session.id, { ...session, status: "running" });
        logical.set(input.name, {
          name: input.name,
          currentSessionId: session.id,
          persistent: input.persistent,
          createdAt: Date.now(),
          tags: input.tags,
          region: input.region,
          status: "running",
          networkPolicy: input.networkPolicy,
          mounts: {},
          image: `${(input.image ?? "vercel/sandbox/node:24").split(":")[0]}@sha256:${"a".repeat(64)}`,
        });

        if (lose) {
          lose = false;
          throw new Error("lost after create effect");
        }

        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }

        if (malformedCreate) return json({ session, sandbox: { malformed: true } });

        return json({
          session,
          routes: input.ports.map((port: number) => ({ port, subdomain: "fixture-preview" })),
          sandbox: {
            image: `${(input.image ?? "vercel/sandbox/node:24").split(":")[0]}@sha256:${"a".repeat(64)}`,
            mounts: {},
            name: wrongCreateName ? "different-sandbox" : input.name,
            currentSessionId: session.id,
            persistent: input.persistent,
            createdAt: logical.get(input.name)!.createdAt,
            tags: input.tags,
            region: input.region,
            status: "running",
            networkPolicy: input.networkPolicy,
          },
        });
      }

      if (route === "/api/v2/sandboxes/sessions")
        return json({ sessions: [...records.values()], pagination: { next: null } });

      if (route === "/api/v2/sandboxes/snapshots") {
        if (raceDuringInventory) {
          raceDuringInventory = false;
          const box = [...logical.values()].find((v) => v.persistent)!;

          const session = {
            ...records.get(box.currentSessionId)!,
            id: "session-raced",
            status: "running",
          };

          records.set(session.id, session);
          box.currentSessionId = session.id;
          box.status = "running";
        }

        return json({ snapshots: [...snapshots.values()], pagination: { next: null } });
      }

      if (route.startsWith("/api/v2/sandboxes/snapshots/")) {
        const snapshot = snapshots.get(route.split("/").at(-1)!);

        if (!snapshot) return json({}, 404);

        if (init.method === "DELETE") snapshot.status = "deleted";

        return json({ snapshot });
      }

      if (/^\/api\/v2\/sandboxes\/[^/]+$/.test(route)) {
        const box = logical.get(route.split("/").at(-1)!);

        if (!box) return json({}, 404);

        if (init.method === "DELETE") {
          logical.delete(box.name);

          if (loseDelete) {
            loseDelete = false;
            records.delete(box.currentSessionId);
            throw new Error("lost delete ACK");
          }

          return json({ sandbox: box });
        }

        let session = records.get(box.currentSessionId)!;

        if (parsed.searchParams.get("resume") === "true") {
          resumeCount++;
          session = {
            ...session,
            id: `session-resumed-${resumeCount}`,
            status: "running",
            sourceSnapshotId: badResumeSource ? "snap-unrelated" : box.currentSnapshotId,
          };
          records.set(session.id, session);
          box.currentSessionId = session.id;
          box.status = "running";

          if (loseResume) {
            loseResume = false;
            throw new Error("lost resume ACK");
          }

          return json({ sandbox: box, session, resumed: true, routes: [] });
        }

        return json({ sandbox: box, session, routes: [] });
      }

      const sessionId = route.split("/")[5]!;
      const session = records.get(sessionId);

      if (!session) return json({ error: "missing" }, 404);

      if (route.endsWith("/snapshot")) {
        const snapshot = {
          id: `snap-${snapshots.size + 1}`,
          sourceSessionId: sessionId,
          region: session.region,
          status: "created",
          createdAt: Date.now(),
        };

        snapshots.set(snapshot.id, snapshot);
        session.status = "stopped";

        return json(malformedSnapshot ? { snapshot: { id: snapshot.id } } : { snapshot, session });
      }

      if (route.endsWith("/extend-timeout")) {
        session.timeout = (session.timeout ?? 0) + JSON.parse(String(init.body)).duration;

        return json({ session });
      }

      if (route.endsWith("/stop")) {
        effects.destroy++;
        session.status = "stopped";
        const box = [...logical.values()].find((v) => v.currentSessionId === session.id);

        if (box?.persistent) {
          box.status = "stopped";

          const snapshot = {
            id: `snap-auto-${snapshots.size + 1}`,
            sourceSessionId: session.id,
            region: session.region,
            status: "created",
            createdAt: Date.now(),
          };

          snapshots.set(snapshot.id, snapshot);
          box.currentSnapshotId = snapshot.id;

          return json({ session, sandbox: box, snapshot });
        }

        return json({});
      }

      if (route.endsWith("/cmd")) {
        const input = JSON.parse(String(init.body));
        expect(input.command).toBe("node");
        expect(input.args.slice(0, 1)).toEqual(["-e"]);

        if (input.args[1]?.includes("const regular = p")) {
          const op = JSON.parse(input.args[2]);
          let value: Json = {};
          let error: string | undefined;

          if (op.op === "publish") {
            if (!op.flag && files.has(op.destination)) error = "CONFLICT";
            else {
              files.set(op.destination, files.get(op.path)!);
              files.delete(op.path);
            }
          } else if (op.op === "remove") files.delete(op.path);
          else if (op.op === "stat") {
            if (!files.has(op.path)) error = "NOT_FOUND";
            else
              value = {
                type: "file",
                sizeBytes: files.get(op.path)!.length,
                modifiedAt: new Date(0).toISOString(),
                mode: 384,
              };
          } else if (op.op === "copy") files.set(op.destination, files.get(op.path)!);
          else if (op.op === "reserve") files.set(op.path, new Uint8Array());
          else if (op.op === "append") {
            files.set(op.path, Buffer.concat([files.get(op.path)!, files.get(op.destination)!]));
            files.delete(op.destination);
          }

          const commandId = `cmd-fs-${fsCommands.size + 1}`;
          fsCommands.set(
            commandId,
            JSON.stringify(
              error ? { ok: false, code: error, effect: "none" } : { ok: true, value },
            ),
          );

          return json({ command: { id: commandId, sessionId, exitCode: null } });
        }

        return json({ command: { id: "cmd-fixture", sessionId, exitCode: null } });
      }

      const fsId = route.split("/")[7]!;

      if (fsCommands.has(fsId) && !route.endsWith("/logs"))
        return json({ command: { id: fsId, sessionId, exitCode: 0 } });

      if (fsCommands.has(fsId) && route.endsWith("/logs"))
        return new Response(
          JSON.stringify({ stream: "stdout", data: fsCommands.get(fsId) + "\n" }) + "\n",
        );

      if (route.endsWith("/cmd/cmd-fixture")) {
        if (loseWait) {
          loseWait = false;
          throw new Error("lost helper completion response");
        }

        return json({ command: { id: "cmd-fixture", sessionId, exitCode: 0 } });
      }

      if (route.endsWith("/logs"))
        return new Response(
          JSON.stringify({
            stream: "stdout",
            data:
              receiptPath +
              "\n" +
              (confirmedExit === undefined
                ? ""
                : JSON.stringify({ sandbarExit: 1, exitCode: confirmedExit }) + "\n"),
          }) + "\n",
        );

      if (route.endsWith("/fs/write")) {
        const cwd = new Headers(init.headers).get("x-cwd");
        const tar = extract();
        tar.on("entry", (header, stream, next) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => {
            if (!(chunk instanceof Uint8Array)) throw new Error("Expected tar bytes");
            chunks.push(Buffer.from(chunk));
          });
          stream.on("end", () => {
            files.set(`${cwd === "/" ? "" : cwd}/${header.name}`, Buffer.concat(chunks));
            next();
          });
        });

        if (!(init.body instanceof Uint8Array))
          throw new Error("Expected compressed archive bytes");
        const bytes = init.body;
        await new Promise<void>((resolve, reject) => {
          tar.on("finish", resolve);
          tar.on("error", reject);
          tar.end(gunzipSync(Buffer.from(bytes)));
        });

        return json({});
      }

      if (route.endsWith("/fs/read")) {
        const input = JSON.parse(String(init.body));

        return new Response(Buffer.from(files.get(input.path) ?? new Uint8Array()), {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      return json({ session, routes: [{ port: 3000, subdomain: "fixture-preview" }] });
    },
    close() {
      effects.release++;
    },
  });

  return {
    adapter: createVercelAdapter(factory),
    effects,
    files,
    logical,
    records,
    get resumeCount() {
      return resumeCount;
    },
    corruptResumeSource() {
      badResumeSource = true;
    },
    resumeDuringNextSnapshotList() {
      raceDuringInventory = true;
    },
    loseNextDeleteResponse() {
      loseDelete = true;
    },
    loseNextResumeResponse() {
      loseResume = true;
    },
    snapshots,
    requests,
    incompleteSnapshotAck() {
      malformedSnapshot = true;
    },
    loseNextCreateResponse() {
      lose = true;
    },
    holdNextCreateResponse() {
      hold = true;
    },
    releaseHeldCreateResponse() {
      if (!resume) throw new Error("Create not held");
      resume();
    },
    setCreateStatus(status: number, body?: Json) {
      createStatus = status;

      if (body !== undefined) createError = body;
    },
    setConfirmedExit(exitCode: number) {
      confirmedExit = exitCode;
    },
    loseNextWaitResponse() {
      loseWait = true;
    },
    setReceiptPath(path: string) {
      receiptPath = path;
    },
    acknowledgePendingCreate() {
      createPending = true;
    },
    corruptCreateName() {
      wrongCreateName = true;
    },
    failMutation(suffix: string, status: number | "lost") {
      mutationFailure = { suffix, status };
    },
    corruptCreateAcknowledgment() {
      malformedCreate = true;
    },
    mismatchIdentity() {
      mismatch = true;
    },
  };
}

const config = {
  teamId: "team-fixture",
  projectId: "project-fixture",
  image: "vercel/sandbox/node:24" as const,
};

const credentials = { token: "fixture-token" };

const createInput = {
  image: { kind: "prepared" as const, value: "vercel/sandbox/node:24" },
  networkPolicy: "blocked",
};

test("Vercel native HTTP boundary passes managed adapter suite", async () => {
  const native = fixture();

  const report = await adapterSuite({
    adapter: native.adapter,
    fixture: {
      config,
      credentials,
      alternate: { config: { ...config, teamId: "team-alternate" }, credentials },
      createInput,
      counters: () => ({ ...native.effects }),
      loseNextCreateResponse: native.loseNextCreateResponse,
      holdNextCreateResponse: native.holdNextCreateResponse,
      releaseHeldCreateResponse: native.releaseHeldCreateResponse,
      assertNativeRetriesDisabled() {
        expect(native.requests).toHaveLength(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 2 });
  expect(report.scenarios).toContain("lost response unknown and observation without replay");
});

test("Vercel files preserve binary bytes and destroy confirms stopped compute", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    expect(await box.inspect()).toMatchObject({ state: "running" });
    const bytes = Uint8Array.from([0, 255, 129, 10]);
    await box.writeFile("/tmp/binary", bytes, { overwrite: true });
    expect(await box.readFile("/tmp/binary")).toEqual(bytes);
    await box.writeFile("/tmp/new", bytes, { overwrite: false });
    await expect(
      box.writeFile("/tmp/new", new Uint8Array([1]), { overwrite: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await box.readFile("/tmp/new")).toEqual(bytes);
    const writes = native.requests.filter((request) => request.url.pathname.endsWith("/fs/write"));
    expect(writes).toHaveLength(3);
    expect(new Headers(writes[0]!.init.headers).get("content-type")).toBe("application/gzip");
    await box.destroy();
    expect(await box.inspect()).toMatchObject({ state: "destroyed" });
    expect(native.effects.destroy).toBe(1);
  } finally {
    await client.close();
  }
});

test("Vercel mutations dispatch once after rate limits and server errors", async () => {
  for (const status of [429, 500, 503]) {
    const native = fixture();
    native.setCreateStatus(status);
    const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

    try {
      const op = await client.sandboxes.submitCreate({
        environment: Image.prepared(createInput.image.value),
        networkPolicy: createInput.networkPolicy,
      });

      await expect(op.wait()).rejects.toThrow();
      expect(native.effects.create).toBe(1);
      await op.observe().catch(() => undefined);
      expect(native.effects.create).toBe(1);
    } finally {
      await client.close();
    }
  }
});

test.each([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [402, "CAPACITY"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [429, "RATE_LIMIT"],
] as const)(
  "Vercel create HTTP %i is a clean %s rejection with the native reason",
  async (status, code) => {
    const native = fixture();
    native.setCreateStatus(status, {
      error: { code: "limit", message: "Concurrent sandbox limit reached\n(fixture-token)" },
    });
    const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

    try {
      const error = await client.sandboxes
        .create({
          environment: Image.prepared(createInput.image.value),
          networkPolicy: createInput.networkPolicy,
        })
        .then(
          () => undefined,
          (failure: Error & { code?: string }) => failure,
        );

      expect(error).toMatchObject({ code });
      expect(error?.message).toContain(
        `Vercel rejected sandbox creation (HTTP ${status}): Concurrent sandbox limit reached ([redacted])`,
      );
      expect(error?.message).not.toContain("fixture-token");
      expect(native.effects.create).toBe(1);
    } finally {
      await client.close();
    }
  },
);

test.each([409, 500, 503])("Vercel create HTTP %i stays an unknown outcome", async (status) => {
  const native = fixture();
  native.setCreateStatus(status, { error: { code: "busy", message: "try later" } });
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    await expect(
      client.sandboxes.create({
        environment: Image.prepared(createInput.image.value),
        networkPolicy: createInput.networkPolicy,
      }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining(`(HTTP ${status}): try later`),
    });
    expect(native.effects.create).toBe(1);
  } finally {
    await client.close();
  }
});

test("failed identity verification releases the native transport once", async () => {
  const native = fixture();
  native.mismatchIdentity();
  await expect(connectAdapter(native.adapter, { config, credentials })).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
  expect(native.effects.release).toBe(1);
  expect(native.effects.create).toBe(0);
});

test("Vercel exec collects binary receipts and recovers acknowledged commands without replay", async () => {
  const native = fixture();
  native.files.set(
    "/tmp/sandbar-exec-Fixture/receipt.json",
    Buffer.from(
      JSON.stringify({
        version: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        failure: false,
        truncated: false,
        stdout: "AP8=",
        stderr: "gQ==",
      }),
    ),
  );
  let client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    const result = await box.exec({
      command: { kind: "argv", argv: ["printf", "literal"] },
      maxOutputBytes: 3,
    });

    expect(result.stdout).toEqual(Uint8Array.from([0, 255]));
    expect(result.stderr).toEqual(Uint8Array.from([129]));
    native.loseNextWaitResponse();

    const op = await box.submitExec({
      command: { kind: "shell", script: "printf shell" },
      maxOutputBytes: 3,
    });

    await expect(op.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const reference = op.reference;
    expect(reference).toMatchObject({
      token: { commandId: "cmd-fixture", sessionId: box.id, maxBytes: 3 },
    });

    const starts = native.requests.filter((request) =>
      request.url.pathname.endsWith("/cmd"),
    ).length;

    await client.close();
    client = await Sandbar.connect({ adapter: native.adapter, config, credentials });
    const recovered = await (await client.recover(reference)).observe();
    expect(recovered).toMatchObject({
      stdout: Uint8Array.from([0, 255]),
      stderr: Uint8Array.from([129]),
    });
    expect(native.requests.filter((request) => request.url.pathname.endsWith("/cmd"))).toHaveLength(
      starts,
    );
    expect(
      native.requests.some((request) => request.url.pathname === "/api/v2/sandboxes/sessions"),
    ).toBe(true);
  } finally {
    await client.close();
  }
});

test("Vercel exec refuses log paths outside the private capture receipt directory", async () => {
  const native = fixture();
  native.setReceiptPath("/tmp/user-selected-file");
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(native.requests.filter((request) => request.url.pathname.endsWith("/cmd"))).toHaveLength(
      1,
    );
    expect(
      native.requests.filter((request) => request.url.pathname.endsWith("/fs/read")),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("malformed acknowledged create preserves session identity without trusting configuration", async () => {
  const native = fixture();
  native.corruptCreateAcknowledgment();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const op = await client.sandboxes.submitCreate({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    await expect(op.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(op.reference).toMatchObject({ token: { sessionId: "session-1", validated: false } });
    await expect(op.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(native.effects.create).toBe(1);
    expect(
      native.requests.filter(
        (request) => request.url.pathname === "/api/v2/sandboxes/sessions/session-1",
      ),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("raw sessions must belong to the verified project before native access", async () => {
  const native = fixture();
  const connection = await connectAdapter(native.adapter, { config, credentials });

  try {
    const inspect = connection.session.inspect;

    if (!inspect) throw new Error("Expected inspect support");
    await expect(
      inspect(
        { id: "foreign-session" },
        { signal: connection.signal, deadline: Date.now() + 1000 },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      native.requests.filter((request) => request.url.pathname.endsWith("/foreign-session")),
    ).toHaveLength(0);
  } finally {
    await connection.close();
  }
});

test("create acknowledgements for another sandbox name retain an unvalidated recovery identity", async () => {
  const native = fixture();
  native.corruptCreateName();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const op = await client.sandboxes.submitCreate({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    await expect(op.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(op.reference).toMatchObject({ token: { sessionId: "session-1", validated: false } });
    await expect(op.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(native.effects.create).toBe(1);
  } finally {
    await client.close();
  }
});

test("invalid execution strings fail before any native command submission", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    const invalid: ExecInput[] = [
      { command: { kind: "argv", argv: [""] } },
      { command: { kind: "argv", argv: ["bad\0executable"] } },
      { command: { kind: "argv", argv: ["printf", "bad\0argument"] } },
      { command: { kind: "shell", script: "printf bad\0script" } },
      { command: { kind: "argv", argv: ["true"] }, cwd: "/bad\0cwd" },
      { command: { kind: "argv", argv: ["true"] }, env: { FIXTURE: "bad\0value" } },
    ];

    for (const input of invalid)
      await expect(box.exec(input)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(native.requests.filter((request) => request.url.pathname.endsWith("/cmd"))).toHaveLength(
      0,
    );
  } finally {
    await client.close();
  }
});

test("uploads, commands and stop each dispatch once on lost responses, rate limits and server failures", async () => {
  for (const suffix of ["/fs/write", "/cmd", "/stop"] as const) {
    for (const status of ["lost", 429, 500, 503] as const) {
      const native = fixture();
      const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

      try {
        const box = await client.sandboxes.create({
          environment: Image.prepared(createInput.image.value),
          networkPolicy: createInput.networkPolicy,
        });

        native.failMutation(suffix, status);

        const mutations = {
          "/fs/write": () =>
            box.writeFile("/tmp/binary", new Uint8Array([255]), { overwrite: true }),
          "/cmd": () => box.exec({ command: { kind: "argv", argv: ["true"] } }),
          "/stop": () => box.destroy(),
        };

        const mutation = mutations[suffix]();

        await expect(mutation).rejects.toThrow();
        expect(
          native.requests.filter(
            (request) => request.url.pathname.endsWith(suffix) && request.init.method === "POST",
          ),
        ).toHaveLength(1);
      } finally {
        await client.close();
      }
    }
  }
});

test("directory file paths fail before upload and native mutations receive cancellation signals", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    for (const path of ["/", "/tmp/", "/tmp/nested/"])
      await expect(
        box.writeFile(path, new Uint8Array([255]), { overwrite: true }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(
      native.requests.filter((request) => request.url.pathname.endsWith("/fs/write")),
    ).toHaveLength(0);
    await box.writeFile("/tmp/binary", new Uint8Array([255]), { overwrite: true });
    await box.destroy();

    for (const suffix of ["/v3/sandboxes", "/fs/write", "/stop"]) {
      const mutation = native.requests.find(
        (request) => request.url.pathname.endsWith(suffix) && request.init.method === "POST",
      );

      expect(mutation?.init.signal).toBeInstanceOf(AbortSignal);
      expect(mutation?.init.signal?.aborted).toBe(false);
    }
  } finally {
    await client.close();
  }
});

test("a fresh OS process reopens the saved SDK reference using current credentials and only session reads", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });
  let saved: string;
  let originalId: string;

  try {
    const creation = await client.sandboxes.submitCreate({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    const box = await creation.wait();
    originalId = box.id;
    expect(box.reference).toMatchObject({ kind: "sandbox", nativeId: box.id, provider: "vercel" });
    saved = JSON.stringify({
      reference: box.reference,
      credentials: { token: "fresh-process-current-token" },
    });
  } finally {
    await client.close();
  }

  const child = Bun.spawnSync({
    cmd: [process.execPath, new URL("./fixtures/reopen.ts", import.meta.url).pathname],
    stdin: Buffer.from(saved),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });

  expect(new TextDecoder().decode(child.stderr)).toBe("");
  expect(child.exitCode).toBe(0);
  const reopened = JSON.parse(new TextDecoder().decode(child.stdout));
  expect(reopened).toMatchObject({ id: originalId, inspection: { state: "running" }, closed: 1 });
  expect(reopened.pid).not.toBe(process.pid);
  expect(reopened.paths).toContain(`/api/v2/sandboxes/sessions/${originalId}`);
  expect(reopened.paths).toContain("/api/v2/sandboxes/sessions");
  expect(reopened.paths.every((path: string) => !path.includes("sandbar-"))).toBe(true);
  expect(native.effects.create).toBe(1);
});

test("acknowledged pending creation reaches readiness through session reads without resubmission", async () => {
  const native = fixture();
  native.acknowledgePendingCreate();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const creation = await client.sandboxes.submitCreate({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    expect(creation.reference).toMatchObject({
      token: { sessionId: "session-1", validated: true },
    });
    expect(await creation.observe()).toBeNull();
    const box = await creation.wait({ pollMs: 50 });
    expect(box).toMatchObject({ id: "session-1" });
    expect(native.effects.create).toBe(1);
    expect(native.requests.filter((request) => request.init.method === "POST")).toHaveLength(1);
    expect(
      native.requests.some((request) => request.url.pathname.endsWith("/sessions/session-1")),
    ).toBe(true);
  } finally {
    await client.close();
  }
});

test("omitted create options use the configured image and network policy defaults", async () => {
  for (const networkPolicy of ["vercel-deny-all", "vercel-allow-all"] as const) {
    const native = fixture();

    const client = await Sandbar.connect({
      adapter: native.adapter,
      config: { teamId: config.teamId, projectId: config.projectId, networkPolicy },
      credentials,
    });

    try {
      const box = await client.sandboxes.create();
      expect(box.reference).toMatchObject({ kind: "sandbox", nativeId: box.id });

      const request = native.requests.find(
        (request) => request.url.pathname === "/api/v3/sandboxes",
      );

      expect(request).toBeDefined();
      // The universal image runs processes and terminals; Node-only images do not.
      expect(JSON.parse(String(request?.init.body))).toMatchObject({
        image: "vercel/sandbox/universal:latest",
        timeout: 900000,
        networkPolicy: { mode: networkPolicy === "vercel-deny-all" ? "deny-all" : "allow-all" },
      });
      expect(native.effects.create).toBe(1);
    } finally {
      await client.close();
    }
  }
});

test("portable network names configure Vercel and deprecated names still resolve", async () => {
  for (const [setup, mode] of [
    [{ network: "internet" }, "allow-all"],
    [{ network: "blocked" }, "deny-all"],
    [{ networkPolicy: "vercel-allow-all" }, "allow-all"],
    [{}, "deny-all"],
  ] as const) {
    const native = fixture();
    const portable = mode === "deny-all" ? "blocked" : "internet";
    const legacy = mode === "deny-all" ? "vercel-deny-all" : "vercel-allow-all";

    const client = await Sandbar.connect({
      adapter: native.adapter,
      config: { ...config, ...setup },
      credentials,
    });

    try {
      expect((await client.capabilities()).network).toEqual([portable]);
      await client.sandboxes.create({ network: portable });
      await client.sandboxes.create({ networkPolicy: legacy });
      await expect(
        client.sandboxes.create({ network: portable === "blocked" ? "internet" : "blocked" }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });

      const bodies = native.requests
        .filter((request) => request.url.pathname === "/api/v3/sandboxes")
        .map((request) => JSON.parse(String(request.init.body)));

      expect(bodies).toHaveLength(2);

      for (const body of bodies) expect(body).toMatchObject({ networkPolicy: { mode } });
    } finally {
      await client.close();
    }
  }

  await expect(
    Sandbar.connect({
      adapter: fixture().adapter,
      config: { ...config, network: "internet", networkPolicy: "vercel-allow-all" },
      credentials,
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("native output-read failures preserve the user exit evidence from helper logs", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(createInput.image.value),
      networkPolicy: createInput.networkPolicy,
    });

    native.setConfirmedExit(23);
    native.failMutation("/fs/read", 503);
    const connection = await connectAdapter(native.adapter, { config, credentials });

    try {
      const exec = connection.session.exec;

      if (!exec) throw new Error("Expected execution support");
      const parts = operationParts(exec);

      const context = createAttemptContext(
        {
          operationId: "operation-fixture",
          submissionId: "submission-fixture",
          invocationKey: "invocation-fixture",
          signal: connection.signal,
        },
        parts.recovery?.token,
      );

      await expect(
        parts.submit(
          {
            sandbox: { id: box.id },
            command: { kind: "argv", argv: ["true"] },
            deadlineSeconds: 1,
            maxOutputBytes: 1024,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "UNAVAILABLE", confirmedExit: { exitCode: 23 } });
      expect(
        native.requests.filter(
          (request) => request.url.pathname.endsWith("/cmd") && request.init.method === "POST",
        ),
      ).toHaveLength(1);
    } finally {
      await connection.close();
    }
  } finally {
    await client.close();
  }
});

test("public exec failures retain confirmed exit evidence in the recovery token without replay", async () => {
  const native = fixture();
  let client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create();
    native.setConfirmedExit(23);
    native.failMutation("/fs/read", 503);
    const execution = await box.submitExec({ command: { kind: "argv", argv: ["true"] } });
    await expect(execution.wait()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reference: { token: { confirmedExit: { exitCode: 23 } } },
    });
    const reference = execution.reference;
    expect(reference).toMatchObject({
      token: { commandId: "cmd-fixture", sessionId: box.id, confirmedExit: { exitCode: 23 } },
    });

    const mutations = native.requests.filter(
      (request) => request.init.method === "POST" && !request.url.pathname.endsWith("/fs/read"),
    ).length;

    await client.close();
    client = await Sandbar.connect({ adapter: native.adapter, config, credentials });
    const recovered = await client.recover(reference);
    await expect(recovered.observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reference: { token: { confirmedExit: { exitCode: 23 } } },
    });
    expect(recovered.reference).toMatchObject({ token: { confirmedExit: { exitCode: 23 } } });
    expect(
      native.requests.filter(
        (request) => request.init.method === "POST" && !request.url.pathname.endsWith("/fs/read"),
      ),
    ).toHaveLength(mutations);
    expect(
      native.requests.filter(
        (request) => request.url.pathname.endsWith("/cmd") && request.init.method === "POST",
      ),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("failed confirmed-exit checkpoint persistence prevents reading the receipt", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create();
    native.setConfirmedExit(23);
    const connection = await connectAdapter(native.adapter, { config, credentials });

    try {
      const exec = connection.session.exec;

      if (!exec) throw new Error("Expected execution support");
      const parts = operationParts(exec);
      const checkpoints: Json[] = [];

      const context = createAttemptContext(
        {
          operationId: "operation-fixture",
          submissionId: "submission-fixture",
          invocationKey: "invocation-fixture",
          signal: connection.signal,
          async onCheckpoint(token) {
            checkpoints.push(token);

            if (checkpoints.length === 2) throw new Error("durable persistence failed");
          },
        },
        parts.recovery?.token,
      );

      await expect(
        parts.submit(
          {
            sandbox: { id: box.id },
            command: { kind: "argv", argv: ["true"] },
            deadlineSeconds: 1,
            maxOutputBytes: 1024,
          },
          context,
        ),
      ).rejects.toBeInstanceOf(AdapterCheckpointError);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[1]).toMatchObject({ confirmedExit: { exitCode: 23 } });
      expect(
        native.requests.filter((request) => request.url.pathname.endsWith("/fs/read")),
      ).toHaveLength(0);
      expect(
        native.requests.filter(
          (request) => request.url.pathname.endsWith("/cmd") && request.init.method === "POST",
        ),
      ).toHaveLength(1);
    } finally {
      await connection.close();
    }
  } finally {
    await client.close();
  }
});

test("Vercel filesystem snapshot capture/restore/delete retains independent exact identities", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const source = await client.sandboxes.create();
    await expect(
      source.snapshot({ requirements: { preserve: "filesystem+memory" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(native.snapshots.size).toBe(0);
    const { snapshot } = await source.snapshot();
    expect((await source.inspect()).state).toBe("destroyed");
    expect((await snapshot.inspect()).restoreExecution).toBe("fresh");
    expect(snapshot.reference.ownership).toBe("verified-created");

    const foreignHistory = await client.snapshots.get({
      ...snapshot.reference,
      history: {
        mountHandling: "none",
        image: "vercel/sandbox/node:24",
        consistency: "caller-quiesced",
        sourceSessionId: "other-session",
      },
    });

    expect(await foreignHistory.inspect()).toMatchObject({
      mountHandling: "unknown",
      consistency: "unknown",
    });
    await expect(foreignHistory.restore()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const inventory = await client.snapshots.list({ limit: 10 });
    const unproven = await client.snapshots.get(inventory.items[0]!.reference);
    await expect(unproven.restore()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(native.effects.create).toBe(1);
    const restored = await snapshot.restore();
    expect(restored.id).not.toBe(source.id);
    expect((await restored.inspect()).state).toBe("running");
    await restored.destroy();
    await snapshot.delete();
    expect([...native.snapshots.values()][0]!.status).toBe("deleted");
    expect(native.requests.filter((r) => r.init.method === "DELETE")).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("Vercel passes the shared snapshot suite", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, snapshots: { preserve: Preserve.FILESYSTEM } },
    credentials,
  });

  try {
    await snapshotSuite({ client, path: "/tmp/sandbar-suite.bin", preserve: Preserve.FILESYSTEM });
  } finally {
    await client.close();
  }
});

test("Vercel snapshot retention sets the native expiration and the retention guarantee", async () => {
  for (const [retentionSeconds, expiration, minimum] of [
    [14 * 86_400, 14 * 86_400_000, 14 * 86_400],
    [0, 0, Number.MAX_SAFE_INTEGER],
  ] as const) {
    const native = fixture();

    const client = await Sandbar.connect({
      adapter: native.adapter,
      config: { ...config, snapshots: { retentionSeconds } },
      credentials,
    });

    try {
      const source = await client.sandboxes.create();
      const check = await source.checkSnapshot({ retention: { minimumSeconds: minimum } });
      expect(check.status).toBe("supported");
      await source.snapshot();
      const capture = native.requests.find((r) => r.url.pathname.endsWith("/snapshot"));
      expect(JSON.parse(String(capture?.init.body))).toEqual({ expiration });
    } finally {
      await client.close();
    }
  }

  const persistent = Sandbar.connect({
    adapter: fixture().adapter,
    config: { ...config, persistent: true, snapshots: { retentionSeconds: 60 } },
    credentials,
  });

  await expect(persistent).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

test("Vercel accepts filesystem-only preserve and rejects memory at connect before any call", async () => {
  const native = fixture();

  const connect = (preserve: Preserve) =>
    Sandbar.connect({
      adapter: native.adapter,
      config: { ...config, snapshots: { preserve } },
      credentials,
    });

  await expect(connect(Preserve.FILESYSTEM_AND_MEMORY)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(native.requests).toHaveLength(0);

  const client = await connect(Preserve.FILESYSTEM);

  try {
    const { capture } = await (await client.sandboxes.create()).snapshot();
    expect(capture.preserve).toBe(Preserve.FILESYSTEM);
  } finally {
    await client.close();
  }
});

test("Vercel scoped configuration, renewal and public previews use original sessions", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, region: "fra1", vcpus: 4, ports: [3000], image: "vercel/sandbox/node:22" },
    credentials,
  });

  try {
    const box = await client.sandboxes.create();
    expect(await box.preview(3000)).toEqual({
      access: "public",
      url: "https://fixture-preview.vercel.run",
    });
    await expect(box.preview(4000)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const renewal = await box.renew({ forSeconds: 61 });
    expect(renewal.acknowledged).toBe(true);
    expect(renewal.observation?.expires.status).toBe("known");
    expect(native.requests.filter((r) => r.url.pathname.endsWith("/extend-timeout"))).toHaveLength(
      1,
    );
    // Pro and Enterprise sessions run up to 24 hours; Vercel enforces lower plan limits.
    expect((await box.renew({ forSeconds: 86_400 })).requested).toEqual({ forSeconds: 86_400 });
    await expect(box.renew({ forSeconds: 86_401 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect((await box.capabilities()).lifecycle?.renew).toMatchObject({
      value: { maxSeconds: 86_400 },
    });
    const creation = native.requests.find((r) => r.url.pathname === "/api/v3/sandboxes")!;
    expect(JSON.parse(String(creation.init.body))).toMatchObject({
      region: "fra1",
      image: "vercel/sandbox/node:22",
      resources: { vcpus: 4 },
      ports: [3000],
      failoverRegions: [],
    });
  } finally {
    await client.close();
  }
});

test("Vercel resources pick the smallest vCPU count and inspect reports the session size", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, resources: { vcpus: 3, memoryMiB: 4096 } },
    credentials,
  });

  try {
    const box = await client.sandboxes.create();
    const creation = native.requests.find((r) => r.url.pathname === "/api/v3/sandboxes")!;
    expect(JSON.parse(String(creation.init.body))).toMatchObject({ resources: { vcpus: 4 } });
    expect((await box.inspect()).resources).toEqual({
      status: "known",
      value: { vcpus: 4, memoryMiB: 8192 },
    });
  } finally {
    await client.close();
  }

  const before = native.requests.length;

  await expect(
    Sandbar.connect({
      adapter: native.adapter,
      config: { ...config, resources: { memoryMiB: 131072 } },
      credentials,
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: expect.stringContaining("largest is 32 vCPU / 65536 MiB"),
  });
  await expect(
    Sandbar.connect({
      adapter: native.adapter,
      config: { ...config, vcpus: 2, resources: { vcpus: 2 } },
      credentials,
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(native.requests).toHaveLength(before);
});

test("Vercel session lifetime comes from lifecycle, the deprecated timeoutSeconds or a per-create override", async () => {
  const timeouts = async (
    setup: { lifecycle?: { lifetimeSeconds: number }; timeoutSeconds?: number },
    ...lifetimes: (number | undefined)[]
  ) => {
    const native = fixture();

    const client = await Sandbar.connect({
      adapter: native.adapter,
      config: { ...config, ...setup },
      credentials,
    });

    try {
      for (const lifetimeSeconds of lifetimes)
        await client.sandboxes.create(
          lifetimeSeconds === undefined ? undefined : { lifecycle: { lifetimeSeconds } },
        );

      return native.requests
        .filter((r) => r.url.pathname === "/api/v3/sandboxes")
        .map((r) => JSON.parse(String(r.init.body)).timeout);
    } finally {
      await client.close();
    }
  };

  expect(await timeouts({}, undefined)).toEqual([900_000]);
  expect(await timeouts({ lifecycle: { lifetimeSeconds: 3600 } }, undefined)).toEqual([3_600_000]);
  expect(await timeouts({ timeoutSeconds: 600 }, undefined)).toEqual([600_000]);
  // Under a minute rounds up to Vercel's minimum session timeout.
  expect(await timeouts({}, 1800, 20)).toEqual([1_800_000, 60_000]);

  await expect(
    Sandbar.connect({
      adapter: fixture().adapter,
      config: { ...config, timeoutSeconds: 600, lifecycle: { lifetimeSeconds: 600 } },
      credentials,
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

  // Resumed persistent sessions are checked against the setup lifetime, so no override.
  const client = await Sandbar.connect({
    adapter: fixture().adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  try {
    expect((await client.capabilities()).lifetime).toBeNull();
  } finally {
    await client.close();
  }
});

test("Vercel incremental writes publish exact bytes once and retain no-clobber collisions", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const box = await client.sandboxes.create();
    const bytes = Uint8Array.from({ length: 180000 }, (_, i) => i % 256);
    await box.writeFileStream(
      "/tmp/stream",
      (async function* () {
        yield bytes;
      })(),
    );
    expect(await box.readFile("/tmp/stream")).toEqual(bytes);
    expect((await box.statFile("/tmp/stream")).sizeBytes).toBe(bytes.length);
    await expect(
      box.writeFileStream(
        "/tmp/stream",
        (async function* () {
          yield new Uint8Array([1]);
        })(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await box.readFile("/tmp/stream")).toEqual(bytes);
    const chunks = [];

    for await (const chunk of box.readFileStream("/tmp/stream")) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  } finally {
    await client.close();
  }
});

test("incomplete snapshot acknowledgements retain owned artifact custody without replay", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const source = await client.sandboxes.create();
    native.incompleteSnapshotAck();
    await expect(source.snapshot()).rejects.toMatchObject({
      outcome: {
        kind: "snapshot_capture",
        status: "unknown",
        snapshot: { nativeId: "snap-1", ownership: "verified-created" },
      },
    });
    expect(native.requests.filter((r) => r.url.pathname.endsWith("/snapshot"))).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("fresh connections require validated creation recovery before capturing reopened sessions", async () => {
  const native = fixture();
  const first = await Sandbar.connect({ adapter: native.adapter, config, credentials });
  const creation = await first.sandboxes.submitCreate();
  const box = await creation.wait();
  const saved = creation.reference;
  const reference = box.reference!;
  await first.close();
  const second = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const reopened = await second.sandboxes.get(reference);
    await expect(reopened.snapshot()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(native.snapshots.size).toBe(0);
    const recovered = await second.recover(saved);
    await recovered.wait();
    const { snapshot } = await reopened.snapshot();
    expect(snapshot.reference.ownership).toBe("verified-created");
    await snapshot.delete();
    expect(native.effects.create).toBe(1);
  } finally {
    await second.close();
  }
});

test("persistent sandbox keeps its identity and files across explicit fresh execution resume", async () => {
  const native = fixture();
  const options = { adapter: native.adapter, config: { ...config, persistent: true }, credentials };
  let client = await Sandbar.connect(options);
  const box = await client.sandboxes.create();
  const ref = box.reference!;
  expect(ref.generation).toBeString();
  expect(box.id).toStartWith("sandbar-");
  const first = await box.inspect();
  await box.writeFile("/saved", new Uint8Array([0, 255, 1]));
  await box.suspend();
  expect((await box.inspect()).state).toBe("suspended");
  await expect(box.readFile("/saved")).rejects.toBeDefined();
  expect(native.resumeCount).toBe(0);
  await client.close();
  client = await Sandbar.connect(options);
  const reopened = await client.sandboxes.get(ref);
  expect((await reopened.inspect()).state).toBe("suspended");
  const result = await reopened.resume();
  expect(result.execution).toBe("fresh");
  expect(reopened.reference).toEqual(ref);
  expect(result.executionIdentity).not.toEqual(first.execution);
  expect(await reopened.readFile("/saved")).toEqual(new Uint8Array([0, 255, 1]));
  expect(native.resumeCount).toBe(1);

  const guestRequests = native.requests.filter(({ url }) =>
    /\/sessions\/.*\/fs\/read$/.test(url.pathname),
  );

  expect(guestRequests.at(-1)!.url.pathname).toContain("session-resumed-1");
  const destroyed = await reopened.destroy();
  expect(destroyed.computeStopped).toBe(true);
  expect(destroyed.retainedResources).toContain("snap-auto-1");
  expect(native.logical.has(ref.nativeId)).toBe(false);
  expect(native.snapshots.size).toBeGreaterThan(0);
  await client.close();
});

test("persistent stale creation references reject a same-name replacement before resume", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  const box = await client.sandboxes.create();
  await box.suspend();
  native.logical.get(box.id)!.tags = { sandbarSubmission: "replacement-submission" };
  await expect(box.resume()).rejects.toBeDefined();
  expect(native.resumeCount).toBe(0);
  await expect(box.inspect()).rejects.toBeDefined();
  await client.close();
});

test("lost persistent resume response is never replayed by recovery or inspection", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  const box = await client.sandboxes.create();
  await box.suspend();
  native.loseNextResumeResponse();
  await expect(box.resume()).rejects.toBeDefined();
  expect(native.resumeCount).toBe(1);
  expect((await box.inspect()).state).toBe("running");
  expect(native.resumeCount).toBe(1);
  await box.destroy();
  await client.close();
});

test("persistent deletion recovery preserves snapshot IDs and confirms absence without replay", async () => {
  const native = fixture();
  const options = { adapter: native.adapter, config: { ...config, persistent: true }, credentials };
  let client = await Sandbar.connect(options);
  const box = await client.sandboxes.create();
  native.snapshots.set("snap-failed", {
    id: "snap-failed",
    sourceSessionId: native.logical.get(box.id)!.currentSessionId,
    region: "iad1",
    status: "failed",
    createdAt: Date.now(),
  });
  native.loseNextDeleteResponse();
  const deletion = await box.submitDestroy();
  await expect(deletion.wait()).rejects.toBeDefined();
  const saved = deletion.reference;
  await client.close();
  client = await Sandbar.connect(options);
  const recovered = await client.recover(saved);
  expect(await recovered.wait()).toMatchObject({
    computeStopped: true,
    retainedResources: ["snap-failed", "snap-auto-2"],
  });
  expect(native.requests.filter(({ init }) => init.method === "DELETE")).toHaveLength(1);
  await client.close();
});

test("lost persistent create acknowledgement recovers its deterministic name without resubmission", async () => {
  const native = fixture();
  const options = { adapter: native.adapter, config: { ...config, persistent: true }, credentials };
  let client = await Sandbar.connect(options);
  native.loseNextCreateResponse();
  const operation = await client.sandboxes.submitCreate();
  const saved = operation.reference;
  await client.close();
  client = await Sandbar.connect(options);
  const recovered = await client.recover(saved);
  const box = await recovered.wait();
  expect(box).toMatchObject({ id: [...native.logical.keys()][0] });
  expect(native.effects.create).toBe(1);
  await client.close();
});

test("persistent inspection and resume reject a stale checkpoint from another execution", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  const box = await client.sandboxes.create();
  await box.suspend();
  native.snapshots.get(native.logical.get(box.id)!.currentSnapshotId!)!.sourceSessionId =
    "session-unrelated";
  expect((await box.inspect()).state).toBe("stopped");
  await expect(box.resume()).rejects.toBeDefined();
  expect(native.resumeCount).toBe(0);
  await box.destroy();
  await client.close();
});

test("persistent resume validates the actual restored checkpoint without replay", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  const box = await client.sandboxes.create();
  await box.suspend();
  native.corruptResumeSource();
  await expect(box.resume()).rejects.toBeDefined();
  expect(native.resumeCount).toBe(1);
  await box.destroy();
  await client.close();
});

test("persistent destroy refuses named deletion if execution changes during snapshot inventory", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  const box = await client.sandboxes.create();
  native.resumeDuringNextSnapshotList();
  await expect(box.destroy()).rejects.toBeDefined();
  expect(native.requests.filter(({ init }) => init.method === "DELETE")).toHaveLength(0);
  expect(native.logical.has(box.id)).toBe(true);
  await box.destroy();
  await client.close();
});

test("persistent references reject unsupported mount changes on the same native generation", async () => {
  const native = fixture();

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config: { ...config, persistent: true },
    credentials,
  });

  const box = await client.sandboxes.create();
  const metadata = native.logical.get(box.id)!;
  Object.assign(metadata.mounts, { "/data": { drive: "outside-drive", mode: "read-write" } });

  await expect(box.inspect()).rejects.toBeDefined();
  await expect(box.readFile("/saved")).rejects.toBeDefined();
  expect(native.resumeCount).toBe(0);
  metadata.mounts = {};

  await box.destroy();
  await client.close();
});

test("session-mode listing pages project sessions with references that reopen", async () => {
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    const boxes = [await client.sandboxes.create(), await client.sandboxes.create()];
    native.records.set("session-elsewhere", {
      id: "session-elsewhere",
      region: "sfo1",
      status: "running",
      networkPolicy: { mode: "deny-all" },
    });
    await boxes[1]!.destroy();
    const before = native.requests.length;

    const first = await client.sandboxes.list({ limit: 1 });
    expect(first.coverage).toBe("provider-scope");
    expect(first.nextCursor).toBe("1");
    expect(first.items).toEqual([
      {
        id: boxes[0]!.id,
        state: "running",
        reference: expect.objectContaining({ nativeId: boxes[0]!.id, ownership: "unknown" }),
        // This fixture's session-mode listing carries no tags or creation time.
        labels: {},
        createdAt: null,
      },
    ]);
    expect(first.items[0]!.reference?.generation).toBeUndefined();

    const rest = await client.sandboxes.list({ cursor: first.nextCursor, limit: 2 });
    // The other-region session fills the page slot but is excluded from this binding's listing.
    expect(rest.items.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: boxes[1]!.id, state: "destroyed" },
    ]);
    expect(rest.nextCursor).toBeUndefined();

    const listings = native.requests
      .slice(before)
      .filter(({ url }) => url.pathname === "/api/v2/sandboxes");

    expect(listings.map(({ url }) => url.searchParams.get("cursor"))).toEqual([null, "1"]);
    expect(native.requests.slice(before)).toHaveLength(2);

    expect((await client.sandboxes.get(first.items[0]!.reference!)).id).toBe(boxes[0]!.id);
    await boxes[0]!.destroy();
  } finally {
    await client.close();
  }
});

test("persistent listing carries native generation evidence and no creation receipt", async () => {
  const native = fixture();
  const options = { adapter: native.adapter, config: { ...config, persistent: true }, credentials };
  const client = await Sandbar.connect(options);

  try {
    const box = await client.sandboxes.create({ labels: { run: "42" } });
    native.logical.set("untagged", {
      ...native.logical.get(box.id)!,
      name: "untagged",
      tags: {},
    });

    const page = await client.sandboxes.list();
    expect(page.coverage).toBe("sandbar-managed");
    expect(page.items.map((item) => item.id)).toEqual([box.id]);
    // Create labels come back from the tags without the adapter's own marker.
    expect(page.items[0]!.labels).toEqual({ run: "42" });
    expect(page.items[0]!.createdAt).toBe(
      new Date(native.logical.get(box.id)!.createdAt!).toISOString(),
    );

    const listed = page.items[0]!.reference!;
    expect(listed.generation).toBe(box.reference!.generation);
    expect(listed.ownership).toBe("unknown");
    expect(listed.receipt).toBeUndefined();

    const reopened = await client.sandboxes.get(listed);
    expect(reopened.id).toBe(box.id);
    expect((await reopened.inspect()).state).toBe("running");
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("Vercel sends create env as native session defaults and never saves or echoes a value", async () => {
  const secret = "CANARY-vercel-env-secret";
  const native = fixture();
  const saved: Json[] = [];

  const client = await Sandbar.connect({
    adapter: native.adapter,
    config,
    credentials,
    onReference(reference) {
      saved.push(structuredClone(reference));
    },
  });

  try {
    expect((await client.capabilities()).createEnv).toBe(true);
    const operation = await client.sandboxes.submitCreate({ env: { API_TOKEN: secret } });
    const box = await operation.wait();
    const creations = native.requests.filter((r) => r.url.pathname === "/api/v3/sandboxes");
    expect(creations).toHaveLength(1);
    expect(JSON.parse(String(creations[0]!.init.body)).env).toEqual({ API_TOKEN: secret });
    expect(JSON.stringify([operation.reference, box.reference, saved])).not.toContain(secret);
    await box.destroy();

    native.setCreateStatus(400, { error: { message: `env API_TOKEN=${secret} is invalid` } });

    const error = await client.sandboxes.create({ env: { API_TOKEN: secret } }).then(
      () => undefined,
      (cause: Error) => cause,
    );

    expect(String(error?.message)).not.toContain(secret);
    expect(String(error?.message)).toContain("API_TOKEN=[redacted]");
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(native.effects.create).toBe(2);
    expect(JSON.stringify(saved)).not.toContain(secret);
  } finally {
    await client.close();
  }
});

test("Vercel redacts multi-line and long create env values before shortening native errors", async () => {
  const multiline = "CANARY-first-line\nCANARY-second-line";
  const long = `CANARY-${"x".repeat(400)}`;
  const native = fixture();
  const client = await Sandbar.connect({ adapter: native.adapter, config, credentials });

  try {
    for (const secret of [multiline, long]) {
      native.setCreateStatus(400, { error: { message: `env API_TOKEN=${secret} is invalid` } });

      const error = await client.sandboxes.create({ env: { API_TOKEN: secret } }).then(
        () => undefined,
        (cause: Error) => cause,
      );

      expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(String(error?.message)).toContain("API_TOKEN=[redacted] is invalid");
      expect(String(error?.message)).not.toContain("CANARY");
    }
  } finally {
    await client.close();
  }
});
