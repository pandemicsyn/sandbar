import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@sandbar-sdk/adapter";
import { z } from "zod";

/**
 * Deterministic Boat Public API v1 stand-in behind the SDK's `fetchApi` hook. The real
 * generated client builds every request; this fixture only answers them. Commands run
 * through the local `sh` so the guest wrapper is exercised byte for byte.
 */

type FixtureSandbox = {
  id: string;
  name: string;
  state: string;
  type: string;
  ttlSeconds: number | null;
  createdById: string;
  from?: string;
  noEnv?: boolean;
  environment?: string;
  polls: number;
  files: Map<string, Uint8Array>;
  stop?: { id: string; status: string };
};

type Call = { method: string; path: string; headers: Headers; body?: Json };

/** Request fields this fixture reads; the recorded call keeps the full JSON body. */
const Body = z
  .object({
    type: z.string().optional(),
    ttlSeconds: z.number().nullable().optional(),
    from: z.string().optional(),
    noEnv: z.boolean().optional(),
    environment: z.string().optional(),
    path: z.string().default(""),
    content: z.string().default(""),
    encoding: z.string().optional(),
    command: z.string().default(""),
  })
  .default({ path: "", content: "", command: "" });

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated?: boolean;
};

const accounts = new Map([
  ["fixture-main", "acct_main"],
  ["fixture-alt", "acct_alt"],
]);

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string, extra: { [key: string]: Json } = {}): Response {
  return json(status, {
    ok: false,
    type: "sandbox.error",
    status,
    code,
    message: `${code} happened`,
    requestId: "req_fixture",
    error: { code, message: `${code} happened`, status },
    ...extra,
  });
}

/** Sizes from docs.boat.dev/pricing, as the API reports them. */
const SIZES = new Map([
  ["small", { vcpu: 2, memoryGB: 4 }],
  ["default", { vcpu: 4, memoryGB: 8 }],
  ["large", { vcpu: 8, memoryGB: 16 }],
  ["xlarge", { vcpu: 16, memoryGB: 32 }],
]);

function view(box: FixtureSandbox) {
  return {
    id: box.id,
    name: box.name,
    state: box.state,
    type: box.type,
    ...SIZES.get(box.type),
    ttlSeconds: box.ttlSeconds,
    archiveAfter:
      box.ttlSeconds === null
        ? null
        : new Date(Date.UTC(2030, 0, 1, 0, 0, box.ttlSeconds)).toISOString(),
    desktopAvailable: false,
    snapshotAvailable: true,
    snapshots: true,
    createdById: box.createdById,
    stop: box.stop
      ? { ...box.stop, requestedAt: null, lastAttemptAt: null, error: null, endedAt: null }
      : null,
  };
}

export function boatFixture() {
  const sandboxes = new Map<string, FixtureSandbox>();
  const idempotency = new Map<string, { id: string; body: string }>();
  const deletions = new Map<string, { targetId: string; polls: number }>();
  const calls: Call[] = [];
  const effects = { create: 0, destroy: 0, release: 0 };
  const commands: string[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "sandbar-boat-fixture-"));
  let sequence = 0;
  let loseNextCreate = false;
  let holdNextCreate = false;
  let releaseHeld: (() => void) | undefined;
  let held: Promise<void> | undefined;
  let commandFault: Response | "lost" | undefined;
  let commandOverride: ((command: string) => CommandResult) | undefined;
  /** Polls a sandbox needs before it reports `ready`. */
  let provisioningPolls = 1;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const text = z.string().optional().parse(init?.body);
    const raw = text === undefined ? undefined : z.json().parse(JSON.parse(text));
    const body = Body.parse(raw);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push({ method, path, headers, body: raw });

    if (url.origin !== "https://boat.dev" || init?.redirect !== "error")
      throw new Error(`Fixture refused ${url.origin} without redirect: error`);
    const account = accounts.get(headers.get("authorization")?.replace("Bearer ", "") ?? "");

    if (!account) return error(401, "unauthorized");
    init?.signal?.throwIfAborted();

    if (method === "GET" && path === "/me")
      return json(200, { ok: true, type: "user", user: { id: account, login: account } });

    if (method === "POST" && path === "/sandboxes") {
      const key = headers.get("idempotency-key") ?? "";
      const sent = JSON.stringify(raw ?? {});
      const prior = idempotency.get(`${account}:${key}`);

      if (prior && prior.body !== sent) return error(409, "idempotency_key_reused");
      let box = prior ? sandboxes.get(prior.id) : undefined;

      if (!box) {
        effects.create++;
        box = {
          id: `bx_${++sequence}`,
          name: `sandbox-${sequence}`,
          state: "provisioning",
          type: body.type ?? "default",
          ttlSeconds: body.ttlSeconds ?? 3600,
          createdById: account,
          from: body.from,
          noEnv: body.noEnv,
          environment: body.environment,
          polls: 0,
          files: new Map(),
        };
        sandboxes.set(box.id, box);

        if (key) idempotency.set(`${account}:${key}`, { id: box.id, body: sent });
      }

      if (loseNextCreate) {
        loseNextCreate = false;
        throw new TypeError("fetch failed");
      }

      if (holdNextCreate) {
        holdNextCreate = false;
        await held;
      }

      return json(202, {
        ok: true,
        type: "sandbox.create",
        status: "provisioning",
        ttlSeconds: box.ttlSeconds,
        sandbox: view(box),
      });
    }

    if (method === "GET" && path === "/sandboxes") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const all = [...sandboxes.values()].filter((box) => box.createdById === account);
      const page = all.slice(cursor, cursor + limit);

      return json(200, {
        ok: true,
        type: "sandbox.list",
        sandboxes: page.map(view),
        pageInfo: {
          nextCursor: cursor + limit < all.length ? String(cursor + limit) : null,
          hasMore: cursor + limit < all.length,
          limit,
        },
      });
    }

    const deletion = /^\/deletion-operations\/([^/]+)$/.exec(path);

    if (deletion && method === "GET") {
      const operation = deletions.get(deletion[1] ?? "");

      if (!operation) return error(404, "not_found");
      operation.polls++;

      return json(200, {
        ok: true,
        type: "deletion.operation",
        operation: {
          id: deletion[1],
          kind: "sandbox",
          targetId: operation.targetId,
          reason: "explicit",
          status: operation.polls > 1 ? "completed" : "processing",
          stage: operation.polls > 1 ? "completed" : "removing",
          attemptCount: 1,
          requestedAt: new Date(0).toISOString(),
          completedAt: null,
        },
      });
    }

    const match = /^\/sandboxes\/([^/]+)(?:\/(.+))?$/.exec(path);

    if (!match) return error(404, "not_found");
    const [, id = "", rest] = match;
    const box = sandboxes.get(id);

    if (!box || box.createdById !== account) return error(404, "sandbox_not_found");

    if (method === "GET" && rest === undefined) {
      box.polls++;

      if (box.state === "provisioning" && box.polls >= provisioningPolls) box.state = "ready";

      if (box.state === "archiving" && box.polls >= provisioningPolls) box.state = "archived";

      return json(200, { ok: true, type: "sandbox", sandbox: view(box) });
    }

    if (method === "DELETE" && rest === undefined) {
      if (headers.get("x-ascii-confirm-delete") !== id)
        return error(409, "confirm_delete_mismatch");
      effects.destroy++;
      sandboxes.delete(id);
      const operation = `bdop_${++sequence}`;
      deletions.set(operation, { targetId: id, polls: 0 });

      return json(202, {
        ok: true,
        type: "deletion.operation",
        operation: {
          id: operation,
          kind: "sandbox",
          targetId: id,
          reason: "explicit",
          status: "pending",
          stage: "removing",
          attemptCount: 0,
          requestedAt: new Date(0).toISOString(),
          completedAt: null,
        },
      });
    }

    if (method === "PATCH" && rest === undefined) {
      if (body.ttlSeconds !== undefined) box.ttlSeconds = body.ttlSeconds;

      return json(200, { ok: true, type: "sandbox", sandbox: view(box) });
    }

    if (method === "POST" && rest === "stop") {
      box.state = "archiving";
      box.polls = 0;
      box.stop = { id: `stop_${++sequence}`, status: "pending" };

      return json(202, {
        ok: true,
        type: "sandbox.stop",
        id,
        status: "archiving",
        sandbox: view(box),
      });
    }

    if (method === "POST" && rest === "resume") {
      if (box.state !== "archived") return error(409, "sandbox_not_archived");
      box.state = "provisioning";
      box.polls = 0;
      box.ttlSeconds = body.ttlSeconds === undefined ? box.ttlSeconds : body.ttlSeconds;

      return json(202, {
        ok: true,
        type: "sandbox.resume",
        id,
        status: "provisioning",
        sandbox: view(box),
      });
    }

    if (rest === "files" && method === "PUT") {
      const bytes = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");

      if (!/^\/(home\/user|tmp)\//.test(body.path)) return error(400, "invalid_path");
      box.files.set(body.path, new Uint8Array(bytes));

      // Stdin files are read by the locally executed wrapper.
      if (body.path.startsWith("/tmp/sandbar-stdin-")) writeFileSync(body.path, bytes);

      return json(200, {
        ok: true,
        type: "file.write",
        success: true,
        path: body.path,
        encoding: body.encoding ?? "utf8",
        size: bytes.length,
      });
    }

    if (rest === "files" && method === "GET") {
      const file = box.files.get(url.searchParams.get("path") ?? "");

      if (!file) return error(404, "file_not_found");

      return json(200, {
        ok: true,
        type: "file.read",
        success: true,
        path: url.searchParams.get("path"),
        encoding: url.searchParams.get("encoding") ?? "utf8",
        size: file.length,
        content: Buffer.from(file).toString(
          url.searchParams.get("encoding") === "base64" ? "base64" : "utf8",
        ),
      });
    }

    if (rest === "commands" && method === "POST") {
      if (!["ready", "idle", "running"].includes(box.state)) return error(409, "sandbox_not_ready");
      const fault = commandFault;
      commandFault = undefined;

      if (fault instanceof Response) return fault;
      commands.push(body.command);
      const override = commandOverride?.(body.command);
      let result: CommandResult;

      if (override) result = override;
      else {
        const run = Bun.spawnSync(["sh", "-c", body.command], { cwd: workdir });
        result = {
          exitCode: run.exitCode,
          stdout: new TextDecoder().decode(run.stdout),
          stderr: new TextDecoder().decode(run.stderr),
          timedOut: false,
        };
      }

      if (fault === "lost") throw new TypeError("fetch failed");

      return json(200, {
        ok: true,
        type: "command",
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated ?? false,
        stderrTruncated: false,
        timedOut: result.timedOut,
      });
    }

    return error(404, "not_found");
  };

  return {
    fetch,
    calls,
    effects,
    commands,
    sandboxes,
    workdir,
    count: (method: string, pattern: RegExp) =>
      calls.filter((call) => call.method === method && pattern.test(call.path)).length,
    setProvisioningPolls(value: number) {
      provisioningPolls = value;
    },
    failNextCommand(response: Response | "lost") {
      commandFault = response;
    },
    overrideCommands(handler: ((command: string) => CommandResult) | undefined) {
      commandOverride = handler;
    },
    loseNextCreateResponse() {
      loseNextCreate = true;
    },
    holdNextCreateResponse() {
      holdNextCreate = true;
      held = new Promise((resolve) => {
        releaseHeld = resolve;
      });
    },
    releaseHeldCreateResponse() {
      releaseHeld?.();
    },
    error,
    close() {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
