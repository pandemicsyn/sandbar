import { afterAll, beforeAll, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { ModalClient } from "modal";
import { noRetryGrpcMiddleware } from "./transport";

const server = new grpc.Server();

const calls = new Map<string, number>();

let port = 0;

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
    sandboxCreateV2: lost(createPath),
    sandboxTerminateV2: lost(terminatePath),
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
    expect(calls.get(path)).toBe(1);
    expect(calls.get(createPath)).toBe(1);
    expect(calls.get(terminatePath)).toBe(1);
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
