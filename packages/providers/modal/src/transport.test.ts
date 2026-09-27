import { afterAll, beforeAll, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { ModalClient } from "modal";
import { noRetryGrpcMiddleware, readBoundedStream, readModalFile } from "./transport";
import { field, message } from "./router-wire";

const server = new grpc.Server();

const calls = new Map<string, number>();

let port = 0;

let imageSuccess = false;

let createSuccess = false;

const path = "/modal.client.ModalClient/AppGetOrCreate";

const method: grpc.MethodDefinition<Buffer, Buffer> = {
  path,
  requestStream: false,
  responseStream: false,
  requestSerialize: (value) => value,
  requestDeserialize: (value) => value,
  responseSerialize: (value) => value,
  responseDeserialize: (value) => value,
};

const createPath = "/modal.client.ModalClient/SandboxCreateV2";

const terminatePath = "/modal.client.ModalClient/SandboxTerminateV2";

const imagePath = "/modal.client.ModalClient/ImageGetOrCreate";

function lost(requestPath: string): grpc.handleUnaryCall<Buffer, Buffer> {
  return (_call, callback) => {
    calls.set(requestPath, (calls.get(requestPath) ?? 0) + 1);
    callback(Object.assign(new Error("lost response"), { code: grpc.status.UNAVAILABLE }));
  };
}

server.addService(
  {
    appGetOrCreate: method,
    sandboxCreateV2: { ...method, path: createPath },
    sandboxTerminateV2: { ...method, path: terminatePath },
    imageGetOrCreate: { ...method, path: imagePath },
    authTokenGet: { ...method, path: "/modal.client.ModalClient/AuthTokenGet" },
  },
  {
    authTokenGet(
      _call: grpc.ServerUnaryCall<Buffer, Buffer>,
      callback: grpc.sendUnaryData<Buffer>,
    ) {
      const token = Buffer.from("fixture.token.value");
      callback(null, Buffer.concat([Buffer.from([10, token.length]), token]));
    },
    appGetOrCreate: lost(path),
    sandboxCreateV2(
      _call: grpc.ServerUnaryCall<Buffer, Buffer>,
      callback: grpc.sendUnaryData<Buffer>,
    ) {
      calls.set(createPath, (calls.get(createPath) ?? 0) + 1);

      if (createSuccess) callback(null, message(field(1, "sb-oci"), field(3, "ta-fixture")));
      else callback(Object.assign(new Error("lost response"), { code: grpc.status.UNAVAILABLE }));
    },
    sandboxTerminateV2: lost(terminatePath),
    imageGetOrCreate(
      _call: grpc.ServerUnaryCall<Buffer, Buffer>,
      callback: grpc.sendUnaryData<Buffer>,
    ) {
      calls.set(imagePath, (calls.get(imagePath) ?? 0) + 1);

      if (imageSuccess) callback(null, message(field(1, "im-oci"), field(2, field(1, 1))));
      else callback(Object.assign(new Error("lost response"), { code: grpc.status.UNAVAILABLE }));
    },
  },
);

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, selected) =>
      error ? reject(error) : resolve(selected),
    ),
  );
});

afterAll(() => {
  server.forceShutdown();
});

test("bounded file stream stops when a file grows after stat", async () => {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([0, 255]));
      controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readBoundedStream(stream, 4)).rejects.toThrow("bounded read size");
  expect(cancelled).toBe(true);

  const exact = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([0, 255, 129]));
      controller.close();
    },
  });

  expect(await readBoundedStream(exact, 3)).toEqual(Uint8Array.from([0, 255, 129]));
});

test("pinned Modal read command preserves binary bytes and checks process exit", async () => {
  const commands: Array<{ command: string[]; mode: string }> = [];
  let exitCode = 0;

  const sandbox = {
    filesystem: {
      async stat() {
        return { type: "file", size: 3 };
      },
    },
    async exec(command: string[], options: { mode: "binary" }) {
      commands.push({ command, mode: options.mode });

      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([0, 255, 129]));
            controller.close();
          },
        }),
        async wait() {
          return exitCode;
        },
      };
    },
  };

  expect(await readModalFile(sandbox, "/tmp/data.bin", 4)).toEqual(Uint8Array.from([0, 255, 129]));
  expect(commands).toEqual([
    {
      command: ["/__modal/.bin/modal-sandbox-fs-tools", '{"ReadFile":{"path":"/tmp/data.bin"}}'],
      mode: "binary",
    },
  ]);

  exitCode = 1;
  await expect(readModalFile(sandbox, "/tmp/data.bin", 4)).rejects.toThrow("read failed");
});

test("pinned Modal read command cancels when the file grows after stat", async () => {
  let cancelled = false;

  const sandbox = {
    filesystem: {
      async stat() {
        return { type: "file", size: 1 };
      },
    },
    async exec(_command: string[], _options: { mode: "binary" }) {
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        async wait() {
          return 0;
        },
      };
    },
  };

  await expect(readModalFile(sandbox, "/tmp/growing.bin", 4)).rejects.toThrow("bounded read size");
  expect(cancelled).toBe(true);
});

test("pinned SDK's public middleware limits ambiguous control-plane calls to one outbound attempt", async () => {
  const previous = process.env.MODAL_SERVER_URL;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;

  try {
    calls.clear();

    const client = new ModalClient({
      tokenId: "ak-fixture",
      tokenSecret: "as-fixture",
      maxRetries: 0,
      maxThrottleWaitSecs: 0,
      grpcMiddleware: [noRetryGrpcMiddleware],
    });

    expect(client.version()).toBe("0.10.1");
    await expect(
      client.apps.fromName("existing", { environment: "main", createIfMissing: false }),
    ).rejects.toThrow();
    await expect(client.cpClient.sandboxCreateV2({ appId: "ap-fixture" })).rejects.toThrow();
    await expect(client.cpClient.sandboxTerminateV2({ sandboxId: "sb-fixture" })).rejects.toThrow();
    await expect(client.cpClient.imageGetOrCreate({ appId: "ap-fixture" })).rejects.toThrow();
    expect(calls.get(path)).toBe(1);
    expect(calls.get(createPath)).toBe(1);
    expect(calls.get(terminatePath)).toBe(1);
    expect(calls.get(imagePath)).toBe(1);
    client.close();
  } finally {
    if (previous === undefined) delete process.env.MODAL_SERVER_URL;
    else process.env.MODAL_SERVER_URL = previous;
  }
});

test("the SDK constructor maxRetries option alone does not disable automatic replay", async () => {
  const previous = process.env.MODAL_SERVER_URL;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;

  try {
    calls.clear();

    const client = new ModalClient({
      tokenId: "ak-fixture",
      tokenSecret: "as-fixture",
      maxRetries: 0,
      maxThrottleWaitSecs: 0,
    });

    await expect(client.cpClient.sandboxCreateV2({ appId: "ap-fixture" })).rejects.toThrow();
    expect(calls.get(createPath)).toBe(4);
    client.close();
  } finally {
    if (previous === undefined) delete process.env.MODAL_SERVER_URL;
    else process.env.MODAL_SERVER_URL = previous;
  }
});

test("fromRegistry is IO-free and pinned OCI build sends one image mutation on lost response", async () => {
  const previousUrl = process.env.MODAL_SERVER_URL;
  const previousBuilder = process.env.MODAL_IMAGE_BUILDER_VERSION;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;
  process.env.MODAL_IMAGE_BUILDER_VERSION = "fixture-builder";

  try {
    calls.clear();

    const client = new ModalClient({
      tokenId: "ak-fixture",
      tokenSecret: "as-fixture",
      maxThrottleWaitSecs: 0,
      grpcMiddleware: [noRetryGrpcMiddleware],
    });

    const image = client.images.fromRegistry("python:3.12-slim");
    expect(image.imageId).toBe("");
    expect(calls.get(imagePath)).toBeUndefined();
    // SAFETY: Image.build only reads appId and environmentName from the fixture App.
    await expect(
      image.build({ appId: "ap-fixture", environmentName: "main" } as never),
    ).rejects.toThrow();
    expect(calls.get(imagePath)).toBe(1);
    client.close();
  } finally {
    if (previousUrl === undefined) delete process.env.MODAL_SERVER_URL;
    else process.env.MODAL_SERVER_URL = previousUrl;

    if (previousBuilder === undefined) delete process.env.MODAL_IMAGE_BUILDER_VERSION;
    else process.env.MODAL_IMAGE_BUILDER_VERSION = previousBuilder;
  }
});

test("pinned OCI path builds once and creates one V2 sandbox in the same submit", async () => {
  const previousUrl = process.env.MODAL_SERVER_URL;
  const previousBuilder = process.env.MODAL_IMAGE_BUILDER_VERSION;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;
  process.env.MODAL_IMAGE_BUILDER_VERSION = "fixture-builder";
  imageSuccess = true;
  createSuccess = true;

  try {
    calls.clear();

    const client = new ModalClient({
      tokenId: "ak-fixture",
      tokenSecret: "as-fixture",
      maxThrottleWaitSecs: 0,
      grpcMiddleware: [noRetryGrpcMiddleware],
    });

    const image = client.images.fromRegistry("python:3.12-slim");
    expect(calls.get(imagePath)).toBeUndefined();

    // SAFETY: The pinned native method only reads these two App fields in this no-secrets fixture.
    const sandbox = await client.sandboxes.experimentalCreate(
      { appId: "ap-fixture", environmentName: "main" } as never,
      image,
      { name: "sub-fixture", blockNetwork: true },
    );

    expect(sandbox.sandboxId).toBe("sb-oci");
    expect(image.imageId).toBe("im-oci");
    expect(calls.get(imagePath)).toBe(1);
    expect(calls.get(createPath)).toBe(1);
    sandbox.detach();
    client.close();
  } finally {
    imageSuccess = false;
    createSuccess = false;

    if (previousUrl === undefined) delete process.env.MODAL_SERVER_URL;
    else process.env.MODAL_SERVER_URL = previousUrl;

    if (previousBuilder === undefined) delete process.env.MODAL_IMAGE_BUILDER_VERSION;
    else process.env.MODAL_IMAGE_BUILDER_VERSION = previousBuilder;
  }
});
