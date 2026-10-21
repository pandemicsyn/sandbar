import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@sandbar-sdk/adapter";
import { z } from "zod";

/**
 * Deterministic Runloop API v1 stand-in behind the adapter's `fetch` hook. The real
 * client builds every request; this fixture only answers them. Commands run through
 * the local `sh` so the guest wrapper is exercised byte for byte, and `/tmp` paths
 * are real local files so stdin uploads and downloaded output use the same bytes.
 */

type FixtureDevbox = {
  id: string;
  account: string;
  status: string;
  polls: number;
  createTime: number;
  body: CreateBody;
  files: Map<string, Uint8Array>;
};

type FixtureExecution = {
  id: string;
  devbox: string;
  command: string;
  waits: number;
  result: CommandResult;
};

type FixtureSnapshot = {
  id: string;
  account: string;
  source: string;
  status: "in_progress" | "complete" | "error" | "deleted";
  polls: number;
  metadata: Record<string, string>;
  /** The source disk at capture; a Devbox created from the snapshot starts with these files. */
  files: Map<string, Uint8Array>;
};

type FixturePolicy = {
  id: string;
  account: string;
  name: string;
  egress: {
    allow_all: boolean;
    allowed_hostnames: string[];
    allowed_cidrs: string[];
    allow_devbox_to_devbox: boolean;
    allow_agent_gateway: boolean;
    allow_mcp_gateway: boolean;
    allow_runloop_mirrors: boolean;
  };
};

type Call = { method: string; path: string; query: URLSearchParams; body?: Json };

const CreateBody = z
  .object({
    blueprint_id: z.string().optional(),
    blueprint_name: z.string().optional(),
    snapshot_id: z.string().optional(),
    metadata: z.record(z.string(), z.string()).default({}),
    launch_parameters: z
      .object({
        network_policy_id: z.string().optional(),
        resource_size_request: z.string().optional(),
        custom_cpu_cores: z.number().optional(),
        custom_gb_memory: z.number().optional(),
        keep_alive_time_seconds: z.number().optional(),
        lifecycle: z.json().optional(),
      })
      .default({}),
    tunnel: z.object({ auth_mode: z.enum(["open", "authenticated"]) }).optional(),
    environment_variables: z.record(z.string(), z.string()).optional(),
  })
  .default({ metadata: {}, launch_parameters: {} });

type CreateBody = z.infer<typeof CreateBody>;

const Execute = z.object({
  command: z.string(),
  command_id: z.string(),
  optimistic_timeout: z.number().optional(),
});

const Policy = z.object({
  name: z.string(),
  allow_all: z.boolean().default(false),
  allowed_hostnames: z.array(z.string()).default([]),
  allowed_cidrs: z.array(z.string()).default([]),
  allow_devbox_to_devbox: z.boolean().default(false),
  allow_agent_gateway: z.boolean().default(false),
  allow_mcp_gateway: z.boolean().default(false),
  allow_runloop_mirrors: z.boolean().default(false),
});

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
};

const accounts = new Map([
  ["fixture-main", { id: "acct_main", status: "ACCOUNT_STATUS_ENABLED" }],
  ["fixture-alt", { id: "acct_alt", status: "ACCOUNT_STATUS_ENABLED" }],
  ["fixture-disabled", { id: "acct_off", status: "ACCOUNT_STATUS_DISABLED_BY_ADMIN" }],
]);

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, message = `fixture error ${status}`): Response {
  return json(status, { message });
}

function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  const trailing = text.endsWith("\n");
  const body = trailing ? lines.slice(0, -1) : lines;

  return body.slice(-count).join("\n") + (trailing ? "\n" : "");
}

export function runloopFixture() {
  const devboxes = new Map<string, FixtureDevbox>();
  const executions = new Map<string, FixtureExecution>();
  const snapshots = new Map<string, FixtureSnapshot>();
  const policies = new Map<string, FixturePolicy>();
  const calls: Call[] = [];
  const effects = { create: 0, destroy: 0, release: 0 };
  const commands: string[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "sandbar-runloop-fixture-"));
  let sequence = 0;
  let loseNextCreate = false;
  let holdNextCreate = false;
  /** Start the next devbox without the network policy its create requested. */
  let dropNextPolicy = false;
  let releaseHeld: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const logQueries: string[] = [];
  let nextFault: { pattern: RegExp; response: Response | "lost" } | undefined;
  let commandOverride: ((command: string) => CommandResult | undefined) | undefined;
  /** Polls a devbox needs before it reports its next settled state. */
  let settlePolls = 1;
  /** Long-poll windows a command stays running for. */
  let commandWaits = 0;
  /** Waits answered with 408 before the next real answer. */
  let timeouts = 0;

  const view = (box: FixtureDevbox) => ({
    id: box.id,
    status: box.status,
    capabilities: [],
    create_time_ms: box.createTime,
    end_time_ms: box.status === "shutdown" ? box.createTime + 1000 : null,
    launch_parameters: box.body.launch_parameters,
    metadata: box.body.metadata,
    state_transitions: [],
    blueprint_id: box.body.blueprint_id ?? null,
    snapshot_id: box.body.snapshot_id ?? null,
    tunnel: box.body.tunnel
      ? {
          auth_mode: box.body.tunnel.auth_mode,
          create_time_ms: box.createTime,
          http_keep_alive: true,
          wake_on_http: false,
          tunnel_key: `key${box.id.replace(/[^A-Za-z0-9]/g, "")}`,
          auth_token: box.body.tunnel.auth_mode === "authenticated" ? `token-${box.id}` : null,
        }
      : null,
  });

  const snapshotView = (snapshot: FixtureSnapshot) => ({
    id: snapshot.id,
    create_time_ms: 1_800_000_000_000,
    metadata: snapshot.metadata,
    source_devbox_id: snapshot.source,
    name: null,
  });

  const executionView = (execution: FixtureExecution, lastN: number): Json =>
    execution.waits > 0
      ? { devbox_id: execution.devbox, execution_id: execution.id, status: "running" }
      : {
          devbox_id: execution.devbox,
          execution_id: execution.id,
          status: "completed",
          exit_status: execution.result.exitCode,
          stdout: lastLines(execution.result.stdout, lastN),
          stderr: lastLines(execution.result.stderr, lastN),
          stdout_truncated: execution.result.stdoutTruncated ?? false,
          stderr_truncated: false,
        };

  const run = (command: string): CommandResult => {
    const override = commandOverride?.(command);

    if (override) return override;
    const result = Bun.spawnSync(["sh", "-c", command], { cwd: workdir });

    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };

  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    let raw: Json | undefined;
    let form: FormData | undefined;

    if (init.body instanceof FormData) form = init.body;
    else if (init.body !== undefined && init.body !== null)
      raw = z.json().parse(JSON.parse(z.string().parse(init.body)));

    const path = url.pathname;
    calls.push({ method, path, query: url.searchParams, body: raw });

    if (url.origin !== "https://api.runloop.ai" || init.redirect !== "error")
      throw new Error(`Fixture refused ${url.origin} without redirect: error`);
    const account = accounts.get(headers.get("authorization")?.replace("Bearer ", "") ?? "");

    if (!account) return error(401, "invalid API key");
    init.signal?.throwIfAborted();

    if (nextFault && nextFault.pattern.test(`${method} ${path}`)) {
      const fault = nextFault.response;
      nextFault = undefined;

      if (fault === "lost") throw new TypeError("fetch failed");

      return fault;
    }

    if (method === "GET" && path === "/v1/accounts/me")
      return json(200, {
        id: account.id,
        account_status: account.status,
        name: account.id,
        tier: "ACCOUNT_TIER_BASIC",
        created_at: "2026-01-01T00:00:00Z",
        billing: { account_billing_type: "STRIPE" },
      });

    if (method === "POST" && path === "/v1/devboxes") {
      effects.create++;

      const box: FixtureDevbox = {
        id: `dbx_${++sequence}`,
        account: account.id,
        status: "provisioning",
        polls: 0,
        createTime: 1_800_000_000_000,
        body: CreateBody.parse(raw),
        files: new Map(),
      };

      const from = box.body.snapshot_id ? snapshots.get(box.body.snapshot_id) : undefined;

      if (from) box.files = new Map(from.files);

      if (dropNextPolicy) {
        dropNextPolicy = false;
        delete box.body.launch_parameters?.network_policy_id;
      }

      devboxes.set(box.id, box);

      if (loseNextCreate) {
        loseNextCreate = false;
        throw new TypeError("fetch failed");
      }

      if (holdNextCreate) {
        holdNextCreate = false;
        await held;
      }

      return json(200, view(box));
    }

    if (method === "GET" && path === "/v1/devboxes") {
      const all = [...devboxes.values()].filter((box) => box.account === account.id);
      const after = url.searchParams.get("starting_after");
      const start = after ? all.findIndex((box) => box.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const page = all.slice(start, start + limit);

      return json(200, { devboxes: page.map(view), has_more: start + limit < all.length });
    }

    if (method === "GET" && path === "/v1/network-policies") {
      const name = url.searchParams.get("name") ?? "";

      const listed = [...policies.values()].filter(
        (policy) => policy.account === account.id && policy.name.includes(name),
      );

      return json(200, {
        network_policies: listed.map(({ id, name, egress }) => ({ id, name, egress })),
        has_more: false,
      });
    }

    if (method === "POST" && path === "/v1/network-policies") {
      const body = Policy.parse(raw);

      const policy: FixturePolicy = {
        id: `np_${++sequence}`,
        account: account.id,
        name: body.name,
        egress: {
          allow_all: body.allow_all,
          allowed_hostnames: body.allowed_hostnames,
          allowed_cidrs: body.allowed_cidrs,
          allow_devbox_to_devbox: body.allow_devbox_to_devbox,
          allow_agent_gateway: body.allow_agent_gateway,
          allow_mcp_gateway: body.allow_mcp_gateway,
          allow_runloop_mirrors: body.allow_runloop_mirrors,
        },
      };

      policies.set(policy.id, policy);

      return json(200, { id: policy.id, name: policy.name, egress: policy.egress });
    }

    const policyMatch = /^\/v1\/network-policies\/([^/]+)$/.exec(path);

    if (policyMatch && method === "GET") {
      const policy = policies.get(policyMatch[1] ?? "");

      if (!policy || policy.account !== account.id) return error(404);

      return json(200, { id: policy.id, name: policy.name, egress: policy.egress });
    }

    const blueprint = /^\/v1\/blueprints\/([^/]+)$/.exec(path);

    if (blueprint && method === "GET")
      return blueprint[1] === "bpt_known"
        ? json(200, {
            id: "bpt_known",
            name: "known",
            state: "created",
            status: "build_complete",
          })
        : error(404, "blueprint not found");

    if (method === "GET" && path === "/v1/devboxes/disk_snapshots") {
      const devbox = url.searchParams.get("devbox_id");
      const submission = url.searchParams.get("metadata[sandbar_submission]");

      const listed = [...snapshots.values()].filter(
        (snapshot) =>
          snapshot.account === account.id &&
          snapshot.status !== "deleted" &&
          (!devbox || snapshot.source === devbox) &&
          (!submission || snapshot.metadata.sandbar_submission === submission),
      );

      return json(200, { snapshots: listed.map(snapshotView), has_more: false });
    }

    const snapshotMatch = /^\/v1\/devboxes\/disk_snapshots\/([^/]+)\/(status|delete)$/.exec(path);

    if (snapshotMatch) {
      const snapshot = snapshots.get(snapshotMatch[1] ?? "");

      if (!snapshot || snapshot.account !== account.id) return error(404);

      if (snapshotMatch[2] === "delete" && method === "POST") {
        snapshot.status = "deleted";

        return json(200, {});
      }

      snapshot.polls++;

      if (snapshot.status === "in_progress" && snapshot.polls >= settlePolls)
        snapshot.status = "complete";

      return json(200, {
        status: snapshot.status,
        error_message: snapshot.status === "error" ? "disk full" : null,
        snapshot: snapshot.status === "complete" ? snapshotView(snapshot) : null,
      });
    }

    const match = /^\/v1\/devboxes\/([^/]+)(?:\/(.+))?$/.exec(path);

    if (!match) return error(404);
    const [, id = "", rest] = match;
    const box = devboxes.get(id);

    if (!box || box.account !== account.id) return error(404, "devbox not found");

    if (method === "GET" && rest === undefined) {
      box.polls++;

      if (box.polls >= settlePolls) {
        if (box.status === "provisioning") box.status = "running";

        if (box.status === "suspending") box.status = "suspended";

        if (box.status === "resuming") box.status = "running";
      }

      return json(200, view(box));
    }

    if (method === "POST" && rest === "shutdown") {
      if (box.status === "shutdown") return error(400, "devbox already shut down");

      if ([...snapshots.values()].some((s) => s.source === id && s.status === "in_progress"))
        return error(409, "snapshot in progress");
      effects.destroy++;
      box.status = "shutdown";

      return json(200, view(box));
    }

    if (method === "POST" && rest === "suspend") {
      if (box.status !== "running") return error(400, "devbox not running");
      box.status = "suspending";
      box.polls = 0;

      return json(200, view(box));
    }

    if (method === "POST" && rest === "resume") {
      if (box.status !== "suspended") return error(400, "devbox not suspended");
      box.status = "resuming";
      box.polls = 0;

      return json(200, view(box));
    }

    if (method === "POST" && rest === "snapshot_disk_async") {
      if (box.status !== "running") return error(400, "devbox not running");

      const snapshot: FixtureSnapshot = {
        id: `snp_${++sequence}`,
        account: account.id,
        source: id,
        status: "in_progress",
        polls: 0,
        metadata: z
          .object({ metadata: z.record(z.string(), z.string()).default({}) })
          .parse(raw ?? {}).metadata,
        files: new Map(box.files),
      };

      snapshots.set(snapshot.id, snapshot);

      return json(200, snapshotView(snapshot));
    }

    if (method === "POST" && rest === "execute") {
      if (box.status !== "running") return error(400, "devbox not running");
      const body = Execute.parse(raw);
      commands.push(body.command);

      const execution: FixtureExecution = {
        id: `exe_${++sequence}`,
        devbox: id,
        command: body.command,
        waits: commandWaits,
        result: run(body.command),
      };

      executions.set(execution.id, execution);

      return json(200, executionView(execution, Number(url.searchParams.get("last_n") ?? 100)));
    }

    const logMatch = /^executions\/([^/]+)\/stream_(stdout|stderr)_updates$/.exec(rest ?? "");

    if (logMatch && method === "GET") {
      const execution = executions.get(logMatch[1] ?? "");

      if (!execution || execution.devbox !== id) return error(404);
      const stream = logMatch[2] === "stderr" ? "stderr" : "stdout";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      logQueries.push(`${stream}@${offset}`);

      // Everything the command will write is visible at once; the stream then closes.
      const bytes = new TextEncoder().encode(execution.result[stream]).subarray(offset);

      const event = bytes.length
        ? `data: ${JSON.stringify({ offset, output: new TextDecoder().decode(bytes) })}\n\n`
        : "";

      return new Response(event, { headers: { "content-type": "text/event-stream" } });
    }

    const executionMatch = /^executions\/([^/]+)\/(wait_for_status|kill)$/.exec(rest ?? "");

    if (executionMatch && method === "POST") {
      const execution = executions.get(executionMatch[1] ?? "");

      if (!execution || execution.devbox !== id) return error(404);

      if (executionMatch[2] === "kill") {
        execution.waits = 0;
        execution.result = { exitCode: 137, stdout: "", stderr: "" };

        return json(200, executionView(execution, 100));
      }

      if (timeouts > 0) {
        timeouts--;

        return error(408, "wait timed out");
      }

      if (execution.waits > 0) execution.waits--;

      return json(200, executionView(execution, Number(url.searchParams.get("last_n") ?? 100)));
    }

    if (method === "POST" && rest === "upload_file") {
      if (!form) return error(400, "multipart body required");
      const target = z.string().parse(form.get("path"));
      const file = form.get("file");

      if (!(file instanceof Blob)) return error(400, "file required");
      const bytes = new Uint8Array(await file.arrayBuffer());

      if (target.startsWith("/tmp/")) writeFileSync(target, bytes);
      else box.files.set(target, bytes);

      return json(200, {});
    }

    if (method === "POST" && rest === "download_file") {
      const target = z.object({ path: z.string() }).parse(raw).path;
      let bytes: Uint8Array | undefined;

      if (target.startsWith("/tmp/")) {
        if (existsSync(target)) bytes = new Uint8Array(readFileSync(target));
      } else bytes = box.files.get(target);

      if (!bytes) return error(404, "file not found");

      return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    return error(404);
  };

  return {
    fetch,
    calls,
    effects,
    commands,
    devboxes,
    snapshots,
    policies,
    workdir,
    logQueries,
    count: (method: string, pattern: RegExp) =>
      calls.filter((call) => call.method === method && pattern.test(call.path)).length,
    setSettlePolls(value: number) {
      settlePolls = value;
    },
    setCommandWaits(value: number) {
      commandWaits = value;
    },
    timeoutNextWaits(value: number) {
      timeouts = value;
    },
    /** Answer the next request matching `METHOD /path` with a fault instead. */
    failNext(pattern: RegExp, response: Response | "lost") {
      nextFault = { pattern, response };
    },
    overrideCommands(handler: ((command: string) => CommandResult | undefined) | undefined) {
      commandOverride = handler;
    },
    addPolicy(name: string, allowAll: boolean, accountId = "acct_main") {
      const policy: FixturePolicy = {
        id: `np_${++sequence}`,
        account: accountId,
        name,
        egress: {
          allow_all: allowAll,
          allowed_hostnames: [],
          allowed_cidrs: [],
          allow_devbox_to_devbox: false,
          allow_agent_gateway: false,
          allow_mcp_gateway: false,
          allow_runloop_mirrors: false,
        },
      };

      policies.set(policy.id, policy);

      return policy;
    },
    dropPolicyOnNextCreate() {
      dropNextPolicy = true;
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
