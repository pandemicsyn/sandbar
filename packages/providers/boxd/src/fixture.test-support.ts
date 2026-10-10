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
import { AccountNamespace, Disks, Machines, Orgs } from "@boxd-sh/sdk";
import { createNativeClient } from "./transport";

type Transport = ConstructorParameters<typeof Machines>[0];

const Request = z.object({
  vmId: z.string().default(""),
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
  billingOrgId: string;
  billingOrg: string;
  isolated: boolean;
  deleteAtMs: number;
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
    orgs = new Orgs(capture);

  await Promise.allSettled([
    account.get(),
    account.config(),
    orgs.list(),
    machines.create({ image: "ubuntu:24.04" }),
    machines.get("id"),
    machines.list(),
    machines.delete("id"),
    machines.pause("id"),
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
  const files = new Map<string, Uint8Array>();

  let loseCreate = false,
    holdCreate = false;

  let releaseHeld: (() => void) | undefined;

  let failExpiry = false,
    uploadCount: number | undefined,
    badOrg = false,
    truncatedListing = false;

  let execFrames = [{ data: Uint8Array.of(0, 255, 128), exitCode: 0 }];
  let omitExit = false;
  let failNextGet = false;
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
        call.on("data", (request: unknown) => calls.push({ method: name, request }));
        call.on("end", () => {
          for (const frame of execFrames) call.write(frame);
          call.write(
            omitExit
              ? { data: new Uint8Array(), windowChange: true }
              : { data: new Uint8Array(), exitCode: execFrames.at(-1)?.exitCode ?? 0 },
          );
          call.end();
        });
      };
    } else if (name === "DownloadFileStream") {
      implementation[name] = (call: ServerWritableStream<unknown, object>) => {
        const request = Request.parse(call.request);
        calls.push({ method: name, request: call.request });
        const chunks = downloadChunks ?? [files.get(request.path) ?? new Uint8Array()];
        const totalSize = chunks.reduce((sum, bytes) => sum + bytes.length, 0);

        for (const data of chunks) call.write({ data, totalSize });
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
            effects.create++;
            const id = crypto.randomUUID();
            machines.set(id, {
              vmId: id,
              name: req.name,
              status: "running",
              imageRef: req.imageRef,
              billingOrgId: org,
              billingOrg: org,
              isolated: req.isolated,
              deleteAtMs: 0,
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

          case "GetVm": {
            if (failNextGet) {
              failNextGet = false;
              callback({ code: status.UNAVAILABLE, message: "lost metadata" });
              break;
            }

            const machine = machines.get(req.vmId);

            if (!machine) missing();
            else
              ok({
                ...machine,
                vmId: wrongGetId ? crypto.randomUUID() : machine.vmId,
                billingOrgId: badOrg ? "org-other" : machine.billingOrgId,
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
          JSON.stringify({
            token: JSON.parse(String(options?.body)).api_key,
            expires_at: Date.now() / 1000 + 3600,
          }),
        ),
    });

    return {
      ...native,
      close() {
        effects.release++;
        native.close();
      },
    };
  };

  return {
    factory,
    calls,
    effects,
    machines,
    disks,
    files,
    loseNextCreateResponse() {
      loseCreate = true;
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
