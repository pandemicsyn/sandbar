import { afterAll, beforeAll, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { ModalClient } from "modal";
import { noRetryGrpcMiddleware } from "./transport";

const server = new grpc.Server();
let calls = 0;
let port = 0;
const path = "/modal.client.ModalClient/AppGetOrCreate";
const method: grpc.MethodDefinition<Buffer, Buffer> = {
  path,
  requestStream: false,
  responseStream: false,
  requestSerialize: value => value,
  requestDeserialize: value => value,
  responseSerialize: value => value,
  responseDeserialize: value => value,
};
server.addService({ appGetOrCreate: method, authTokenGet: { ...method, path: "/modal.client.ModalClient/AuthTokenGet" } }, {
  authTokenGet(_call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>) {
    const token = Buffer.from("fixture.token.value");
    callback(null, Buffer.concat([Buffer.from([10, token.length]), token]));
  },
  appGetOrCreate(_call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>) {
    calls++;
    callback(Object.assign(new Error("lost response"), { code: grpc.status.UNAVAILABLE }));
  },
});

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, selected) => error ? reject(error) : resolve(selected)));
});
afterAll(() => { server.forceShutdown(); });

test("pinned SDK's public middleware limits ambiguous control-plane calls to one outbound attempt", async () => {
  const previous = process.env.MODAL_SERVER_URL;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;
  try {
    calls = 0;
    const client = new ModalClient({ tokenId: "ak-fixture", tokenSecret: "as-fixture", maxRetries: 0, maxThrottleWaitSecs: 0, grpcMiddleware: [noRetryGrpcMiddleware] });
    expect(client.version()).toBe("0.10.1");
    await expect(client.apps.fromName("existing", { environment: "main", createIfMissing: false })).rejects.toThrow();
    expect(calls).toBe(1);
    client.close();
  } finally {
    if (previous === undefined) delete process.env.MODAL_SERVER_URL;
    else process.env.MODAL_SERVER_URL = previous;
  }
});
