import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { z } from "zod";
import { EventEmitter } from "node:events";
import {
  Client,
  Server,
  ServerCredentials,
  credentials,
  status,
  type MethodDefinition,
  type UntypedServiceImplementation,
  type ServerDuplexStream,
  type ServerWritableStream,
  type ServerUnaryCall,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { AccountNamespace, Disks, Machines, Orgs, Snapshots } from "@boxd-sh/sdk";
import { createNativeClient, type CallContext } from "./transport";

type Transport = ConstructorParameters<typeof Machines>[0];

const Request = z.object({
  vmId: z.string().default(""),
  vm: z.string().default(""),
  snapshot: z.string().default(""),
  enabled: z.boolean().default(false),
  diskId: z.string().default(""),
  name: z.string().default(""),
  path: z.string().default(""),
  imageRef: z.string().default(""),
  isolated: z.boolean().default(false),
  deleteAfterSecs: z.number().default(0),
  sizeBytes: z.number().default(0),
  data: z.instanceof(Uint8Array).default(() => new Uint8Array()),
  config: z
    .object({
      vcpu: z.number().default(0),
      network: z
        .object({ proxies: z.array(z.object({ name: z.string(), port: z.number() })).default([]) })
        .optional(),
      volumes: z
        .array(z.object({ diskId: z.string(), mountPath: z.string(), readOnly: z.boolean() }))
        .default([]),
    })
    .optional(),
});

type MachineRecord = {
  vmId: string;
  name: string;
  status: string;
  imageRef: string;
  vcpu: number;
  memoryBytes: number;
  billingOrgId: string;
  billingOrg: string;
  isolated: boolean;
  deleteAtMs: number;
  botProtection: boolean;
  proxies: { name: string; port: number }[];
  sourceInfo?: { kind: string; name: string; version: number; id: string };
};

type SnapshotRecord = {
  snapshotId: string;
  name: string;
  /** Latest ready version; 0 before the first capture lands. */
  version: number;
  status: string;
  capturing: number;
  pendingReads: number;
  billingOrgId: string;
  vcpu: number;
  memoryBytes: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  useCount: number;
};

type DiskRecord = {
  diskId: string;
  name: string;
  status: string;
  sizeBytes: number;
  attachments: { vmId: string; mountPath: string; mountMode: string }[];
};

// oxlint-disable-next-line anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- Test wire codecs accept untrusted protobuf values; public native codecs perform serialization/decoding.
type Codec = { path: string; request(bytes: Buffer): unknown; response(value: unknown): Buffer };

/** Test-only: obtain method codecs through the same public constructors as production. */
async function methods() {
  const codecs = new Map<string, Codec>();

  const capture: Transport = {
    supportsInteractiveExec: false,
    async consoleOrigin() {
      return "https://app.boxd.sh";
    },
    close() {},
    async unary(method) {
      codecs.set(method.name, {
        path: `/boxd.api.v1.BoxdApi/${method.name}`,
        request: (bytes) => method.requestType.decode(bytes),
        response: (value) =>
          Buffer.from(method.responseType.encode(method.responseType.fromJSON(value)).finish()),
      });

      return method.responseType.fromJSON({});
    },
    serverStream(method) {
      codecs.set(method.name, {
        path: `/boxd.api.v1.BoxdApi/${method.name}`,
        request: (bytes) => method.requestType.decode(bytes),
        response: (value) =>
          Buffer.from(method.responseType.encode(method.responseType.fromJSON(value)).finish()),
      });
      const events = new EventEmitter();
      queueMicrotask(() => events.emit("end"));

      return {
        on(event, listener) {
          events.on(event, listener);
        },
      };
    },
    duplex(method) {
      codecs.set(method.name, {
        path: `/boxd.api.v1.BoxdApi/${method.name}`,
        request: (bytes) => method.requestType.decode(bytes),
        response: (value) =>
          Buffer.from(method.responseType.encode(method.responseType.fromJSON(value)).finish()),
      });
      const events = new EventEmitter();

      return {
        on(event, listener) {
          events.on(event, listener);
        },
        write() {},
        end() {
          queueMicrotask(() => events.emit("end"));
        },
        cancel() {},
      };
    },
    clientStream() {
      throw Error("Unexpected streaming upload");
    },
  };

  const machines = new Machines(capture),
    disks = new Disks(capture),
    account = new AccountNamespace(capture),
    orgs = new Orgs(capture),
    snapshots = new Snapshots(capture);

  await Promise.allSettled([
    account.get(),
    account.config(),
    orgs.list(),
    machines.create({ image: "ubuntu:24.04" }),
    machines.create({ fromSnapshot: "snapshot" }),
    snapshots.create("id", "snapshot"),
    snapshots.get("snapshot"),
    snapshots.list(),
    snapshots.delete("snapshot"),
    machines.get("id"),
    machines.list(),
    machines.delete("id"),
    machines.pause("id"),
    machines.setBotProtection("id", false),
    machines.proxies.list("id"),
    machines.wake("id"),
    machines.setDeleteAfter("id", 900),
    disks.create("disk", 1024 ** 3),
    disks.list(),
    disks.delete("id"),
    machines.files.upload("id", "/file", new Uint8Array()),
    machines.files.download("id", "/file"),
    machines.files.listDir("id", "/"),
    machines.files.mkdir("id", "/dir"),
    machines.files.delete("id", "/dir"),
    machines.exec("id", { command: ["true"], encoding: "buffer" }),
  ]);

  return codecs;
}

export async function boxdFixture() {
  const effects = { create: 0, destroy: 0, release: 0 };
  const calls: Array<{ method: string; request: unknown }> = [];
  const machines = new Map<string, MachineRecord>();
  const disks = new Map<string, DiskRecord>();
  const snapshots = new Map<string, SnapshotRecord>();
  let snapshotPendingReads = 0;
  let snapshotFailure: "lose" | "fail" | undefined;
  let restoreLaterVersion = false;
  const files = new Map<string, Uint8Array>();
  const observedStates: string[] = [];

  let loseCreate = false,
    holdCreate = false;

  let releaseHeld: (() => void) | undefined;

  let failExpiry = false,
    uploadCount: number | undefined,
    badOrg = false,
    truncatedListing = false;

  let execFrames: { data: Uint8Array; exitCode: number; isStderr?: boolean }[] = [
    { data: Uint8Array.of(0, 255, 128), exitCode: 0 },
  ];

  let omitExit = false;
  let holdExec = false;
  let releaseExec: (() => void) | undefined;
  let execCancelled = 0;
  let localFilesystem = false;
  let lostHelper = "";
  let execFailures = 0;
  let machineStates: string[] = [];
  let tokenResponse: Record<string, string | number | boolean | null> | undefined;
  let failNextGet = false;
  let rejectCreate: { code: number; message: string } | undefined;
  let wrongGetId = false;
  let failLifecycleRead = false;
  let downloadChunks: Uint8Array[] | undefined;
  const definition: Record<string, MethodDefinition<unknown, unknown>> = {};
  const implementation: UntypedServiceImplementation = {};

  for (const [name, codec] of await methods()) {
    const stream = name === "Exec" || name === "DownloadFileStream";
    definition[name] = {
      path: codec.path,
      requestStream: name === "Exec",
      responseStream: stream,
      requestSerialize: (value) => Buffer.from(JSON.stringify(value)),
      requestDeserialize: codec.request,
      responseSerialize: codec.response,
      responseDeserialize: (bytes) => bytes,
    };

    if (name === "Exec") {
      implementation[name] = (call: ServerDuplexStream<unknown, object>) => {
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Capture decoded native frames for assertions without interpreting command contents.
        call.on("data", (request: unknown) => {
          calls.push({ method: name, request });
        });
        call.on("end", () => {
          if (execFailures > 0) {
            execFailures--;
            call.emit("error", { code: status.UNAVAILABLE, details: "guest agent unavailable" });

            return;
          }

          for (const frame of execFrames) call.write(frame);

          const finish = () => {
            if (!omitExit)
              call.write({ data: new Uint8Array(), exitCode: execFrames.at(-1)?.exitCode ?? 0 });
            call.end();
          };

          if (!holdExec) {
            finish();

            return;
          }

          // A held command runs until released or until the client cancels the call.
          releaseExec = finish;
          call.on("cancelled", () => {
            execCancelled++;
            releaseExec = undefined;
          });
        });
      };
    } else if (name === "DownloadFileStream") {
      implementation[name] = (call: ServerWritableStream<unknown, object>) => {
        const request = Request.parse(call.request);
        calls.push({ method: name, request: call.request });
        const chunks = downloadChunks ?? [files.get(request.path) ?? new Uint8Array()];
        const totalSize = chunks.reduce((sum, bytes) => sum + bytes.length, 0);

        for (const [index, data] of chunks.entries())
          call.write({ data, totalSize: index === 0 ? totalSize : 0 });
        call.end();
      };
    } else {
      implementation[name] = (
        call: ServerUnaryCall<unknown, object>,
        callback: sendUnaryData<object>,
      ) => {
        calls.push({ method: name, request: call.request });
        const req = Request.parse(call.request);
        const key = String(call.metadata.get("authorization")[0] ?? "");
        const alternate = key.includes("alternate");
        const org = alternate ? "org-alternate" : "org-main";
        const ok = (value = {}) => callback(null, value);
        const missing = () => callback({ code: status.NOT_FOUND, message: "absent" });

        switch (name) {
          case "Whoami":
            ok({ userId: "user-fixture" });
            break;
          case "GetConfig":
            ok({ defaultImage: "ubuntu:24.04", zone: "boxd.sh" });
            break;
          case "ListOrgs":
            ok({
              orgs: [{ id: org, slug: alternate ? "alternate" : "main", name: org }],
              defaultOrgId: org,
            });
            break;
          case "CreateVm": {
            if (rejectCreate) {
              callback(rejectCreate);
              rejectCreate = undefined;
              break;
            }

            effects.create++;
            const id = crypto.randomUUID();
            machines.set(id, {
              vmId: id,
              name: req.name,
              status: "running",
              imageRef: req.imageRef,
              // Unset vCPU takes the native default size class.
              vcpu: req.config?.vcpu || 2,
              memoryBytes: (req.config?.vcpu || 2) * 4 * 1024 ** 3,
              billingOrgId: org,
              billingOrg: org,
              isolated: req.isolated,
              deleteAtMs: 0,
              botProtection: true,
              proxies: req.config?.network?.proxies ?? [],
            });

            for (const volume of req.config?.volumes ?? []) {
              const disk = disks.get(volume.diskId);

              if (disk)
                disk.attachments = [
                  {
                    vmId: id,
                    mountPath: volume.mountPath,
                    mountMode: volume.readOnly ? "ro" : "rw",
                  },
                ];
            }

            if (loseCreate) {
              loseCreate = false;
              callback({ code: status.UNAVAILABLE, message: "lost after effect" });
            } else if (holdCreate) {
              holdCreate = false;
              releaseHeld = () =>
                ok({ vmId: id, name: req.name, status: "running", image: req.imageRef });
            } else ok({ vmId: id, name: req.name, status: "running", image: req.imageRef });
            break;
          }

          case "CreateSnapshot": {
            const machine = machines.get(req.vm);

            if (!machine) {
              missing();
              break;
            }

            if (machine.status !== "running") {
              callback({ code: status.FAILED_PRECONDITION, message: "machine is not running" });
              break;
            }

            const existing = [...snapshots.values()].find((value) => value.name === req.name);

            const record: SnapshotRecord = existing ?? {
              snapshotId: crypto.randomUUID(),
              name: req.name,
              version: 0,
              status: "pending",
              capturing: 0,
              pendingReads: 0,
              billingOrgId: machine.billingOrgId,
              vcpu: machine.vcpu,
              memoryBytes: machine.memoryBytes,
              sizeBytes: 5 * 1024 ** 3,
              createdAt: Date.now(),
              updatedAt: 0,
              useCount: 0,
            };

            record.capturing = record.version + 1;
            record.status = snapshotFailure === "fail" ? "failed" : "pending";
            record.pendingReads = snapshotPendingReads;
            snapshots.set(record.snapshotId, record);

            if (snapshotFailure === "lose") {
              snapshotFailure = undefined;
              callback({ code: status.UNAVAILABLE, message: "lost after effect" });
              break;
            }

            snapshotFailure = undefined;
            ok({
              snapshotId: record.snapshotId,
              name: record.name,
              version: record.capturing,
              status: "pending",
            });
            break;
          }

          case "GetSnapshot": {
            const record = [...snapshots.values()].find(
              (value) =>
                (value.snapshotId === req.name || value.name === req.name) &&
                value.billingOrgId === org,
            );

            if (!record) {
              missing();
              break;
            }

            if (record.status === "pending" && record.pendingReads-- <= 0) {
              record.status = "ready";
              record.version = record.capturing;
              record.updatedAt = Date.now();
            }

            ok({ snapshot: record });
            break;
          }

          case "ListSnapshots":
            ok({
              snapshots: [...snapshots.values()].filter((value) => value.billingOrgId === org),
            });
            break;
          case "DeleteSnapshot": {
            const record = [...snapshots.values()].find(
              (value) => value.snapshotId === req.name || value.name === req.name,
            );

            if (!record) missing();
            else {
              snapshots.delete(record.snapshotId);
              ok();
            }

            break;
          }

          case "CreateVmFromSnapshot": {
            const record = [...snapshots.values()].find(
              (value) =>
                (value.snapshotId === req.snapshot || value.name === req.snapshot) &&
                value.billingOrgId === org,
            );

            if (!record) {
              missing();
              break;
            }

            if (record.version === 0) {
              callback({ code: status.FAILED_PRECONDITION, message: "snapshot is not ready" });
              break;
            }

            effects.create++;
            record.useCount++;
            const id = crypto.randomUUID();
            machines.set(id, {
              vmId: id,
              name: req.name,
              status: "running",
              imageRef: "",
              vcpu: record.vcpu,
              memoryBytes: record.memoryBytes,
              billingOrgId: org,
              billingOrg: org,
              isolated: req.isolated,
              deleteAtMs: 0,
              botProtection: true,
              proxies: req.config?.network?.proxies ?? [],
              sourceInfo: {
                kind: "snapshot",
                name: record.name,
                // A name saved again between check and restore boots its newer version.
                version: record.version + (restoreLaterVersion ? 1 : 0),
                id: record.snapshotId,
              },
            });
            restoreLaterVersion = false;
            ok({ vmId: id, name: req.name, status: "running" });
            break;
          }

          case "GetVm": {
            if (failNextGet) {
              failNextGet = false;
              callback({ code: status.UNAVAILABLE, message: "lost metadata" });
              break;
            }

            const machine = machines.get(req.vmId);

            if (!machine) missing();
            else {
              machine.status = machineStates.shift() ?? machine.status;
              observedStates.push(machine.status);
              ok({
                ...machine,
                vmId: wrongGetId ? crypto.randomUUID() : machine.vmId,
                billingOrgId: badOrg ? "org-other" : machine.billingOrgId,
              });
            }

            break;
          }

          case "SetBotProtection": {
            const machine = machines.get(req.vmId);

            if (!machine) missing();
            else {
              machine.botProtection = req.enabled;
              ok();
            }

            break;
          }

          case "ListProxies": {
            const machine = machines.get(req.vm);

            if (!machine) missing();
            else
              ok({
                proxies: machine.proxies.map((proxy) => ({
                  name: proxy.name,
                  vmId: machine.vmId,
                  vmName: machine.name,
                  domain: `${proxy.name}.${machine.name}.boxd.sh`,
                  port: proxy.port,
                  effectivePort: proxy.port,
                  portMode: "locked",
                })),
              });
            break;
          }

          case "ListVms":
            ok({ vms: [...machines.values()].filter((machine) => machine.billingOrgId === org) });
            break;
          case "SetDeleteAfter": {
            if (failExpiry) {
              callback({ code: status.UNAVAILABLE, message: "lost expiry" });
              break;
            }

            const machine = machines.get(req.vmId);

            if (!machine) {
              missing();
              break;
            }

            machine.deleteAtMs = Date.now() + req.deleteAfterSecs * 1000;
            ok({ deleteAtMs: machine.deleteAtMs });
            break;
          }

          case "DestroyVm":
            effects.destroy++;
            machines.delete(req.vmId);

            for (const disk of disks.values())
              disk.attachments = disk.attachments.filter(
                (attachment) => attachment.vmId !== req.vmId,
              );
            ok();
            break;
          case "SuspendVm": {
            const machine = machines.get(req.vmId);

            if (!machine) missing();
            else {
              machine.status = "suspended";
              failNextGet = failLifecycleRead;
              ok();
            }

            break;
          }

          case "WakeVm": {
            const machine = machines.get(req.vmId);

            if (!machine) missing();
            else {
              machine.status = "running";
              failNextGet = failLifecycleRead;
              ok();
            }

            break;
          }

          case "CreateDisk": {
            const id = crypto.randomUUID();

            const disk = {
              diskId: id,
              name: req.name,
              status: "ready",
              sizeBytes: req.sizeBytes,
              attachments: [],
            };

            disks.set(id, disk);
            ok(disk);
            break;
          }

          case "ListDisks":
            ok({ disks: [...disks.values()] });
            break;
          case "DestroyDisk":
            disks.delete(req.diskId);
            ok();
            break;
          case "UploadFile":
            files.set(req.path, req.data);
            ok({ bytesWritten: uploadCount ?? req.data.length });
            break;
          case "ListDir":
            ok({
              entries: [{ name: "file", sizeBytes: 3, permissions: "-rw-r--r--" }],
              truncated: truncatedListing,
            });
            break;
          default:
            ok();
        }
      };
    }
  }

  const server = new Server();
  server.addService(definition, implementation);

  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );

  const factory = (apiKey: string) => {
    const native = createNativeClient(apiKey, {
      channel: new Client(`127.0.0.1:${port}`, credentials.createInsecure(), {
        "grpc.enable_retries": 0,
      }),
      exchange: async (_url, options) =>
        new Response(
          JSON.stringify(
            tokenResponse ?? {
              token: JSON.parse(String(options?.body)).api_key,
              expires_at: Date.now() / 1000 + 3600,
              user_id: "user-fixture",
              future_field: true,
            },
          ),
        ),
    });

    const localContext = new AsyncLocalStorage<CallContext>();
    const exec = native.machines.exec.bind(native.machines);
    // Test-only local guest execution complements the real protobuf transport
    // fixture. It avoids depending on Bun's loopback server for long workflows.
    // SAFETY: The adapter always requests buffer encoding for helper commands.
    native.machines.exec = (async (id, params) => {
      if (!localFilesystem || !Array.isArray(params.command) || params.command[0] !== "python3")
        return exec(id, params);
      calls.push({ method: "LocalHelper", request: { id, command: params.command } });
      const ctx = localContext.getStore();

      if (!ctx) throw Error("Missing local helper context");
      const command = params.command;

      return new Promise<import("@boxd-sh/sdk").ExecBytesResult>((resolve, reject) => {
        const child = execFile(
          command[0]!,
          command.slice(1),
          { encoding: "buffer", maxBuffer: 1048576, timeout: 5000, signal: ctx.signal },
          (error, stdout, stderr) => {
            if (error) {
              reject(error);

              return;
            }

            if (lostHelper === command[3]) {
              lostHelper = "";
              reject(Error("Lost local helper response after effect"));

              return;
            }

            ctx.confirmedExit = 0;
            resolve({ stdout, stderr, exitCode: 0, success: true });
          },
        );

        child.stdin?.end(ctx.stdin);
      });
    }) as typeof native.machines.exec;

    return {
      ...native,
      run<T>(ctx: CallContext, action: () => Promise<T>) {
        return localContext.run(ctx, () => native.run(ctx, action));
      },
      close() {
        effects.release++;
        native.close();
      },
    };
  };

  return {
    factory,
    loseLocalHelperResponse(op: string) {
      lostHelper = op;
    },
    localFilesystem() {
      localFilesystem = true;
    },
    calls,
    effects,
    machines,
    disks,
    snapshots,
    snapshotPendingReads(value: number) {
      snapshotPendingReads = value;
    },
    loseNextSnapshotResponse() {
      snapshotFailure = "lose";
    },
    restoreNextFromLaterVersion() {
      restoreLaterVersion = true;
    },
    failNextSnapshot() {
      snapshotFailure = "fail";
    },
    /** Save the snapshot under its own name again, outside Sandbar. */
    resaveSnapshot(id: string) {
      const record = snapshots.get(id);

      if (!record) throw Error("No snapshot");
      record.version++;
      record.capturing = record.version;
      record.updatedAt = Date.now();
    },
    files,
    observedStates,
    tokenResponse(value: Record<string, string | number | boolean | null>) {
      tokenResponse = { ...value };
    },
    machineStates(value: string[]) {
      machineStates = [...value];
    },
    execFailures(value: number) {
      execFailures = value;
    },
    loseNextCreateResponse() {
      loseCreate = true;
    },
    rejectNextCreate(code: number, message: string) {
      rejectCreate = { code, message };
    },
    holdNextCreateResponse() {
      holdCreate = true;
    },
    releaseHeldCreateResponse() {
      if (!releaseHeld) throw Error("No held create");
      releaseHeld();
    },
    failExpiry(value = true) {
      failExpiry = value;
    },
    uploadCount(value: number) {
      uploadCount = value;
    },
    badOrg(value = true) {
      badOrg = value;
    },
    truncateListing() {
      truncatedListing = true;
    },
    failNextGet() {
      failNextGet = true;
    },
    wrongGetId(value = true) {
      wrongGetId = value;
    },
    failLifecycleRead(value = true) {
      failLifecycleRead = value;
    },
    omitExit() {
      omitExit = true;
    },
    holdExec() {
      holdExec = true;
    },
    releaseExec() {
      if (!releaseExec) throw Error("No held exec");
      releaseExec();
      releaseExec = undefined;
    },
    get execCancelled() {
      return execCancelled;
    },
    execFrames(value: typeof execFrames) {
      execFrames = value;
    },
    downloadChunks(value: Uint8Array[]) {
      downloadChunks = value;
    },
    close() {
      server.forceShutdown();
    },
  };
}
