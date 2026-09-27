import { afterAll, beforeAll, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { ModalClient } from "modal";
import { field, message, ModalRouterWire, parse } from "./router-wire";

const server = new grpc.Server();

const base = "/modal.task_command_router.TaskCommandRouter";

const unary = (name: string): grpc.MethodDefinition<Buffer, Buffer> => ({
  path: `${base}/${name}`,
  requestStream: false,
  responseStream: false,
  requestSerialize: (value) => value,
  requestDeserialize: (value) => value,
  responseSerialize: (value) => value,
  responseDeserialize: (value) => value,
});

const stream: grpc.MethodDefinition<Buffer, Buffer> = {
  ...unary("TaskExecStdioRead"),
  responseStream: true,
};

let port = 0;

let starts = 0;

let stdinWrites = 0;

let loseStart = false;

let holdWait = false;

let loseStdin = false;

const seen: Buffer[] = [];

server.addService(
  {
    taskExecStart: unary("TaskExecStart"),
    taskExecStdinWrite: unary("TaskExecStdinWrite"),
    taskExecWait: unary("TaskExecWait"),
    taskExecStdioRead: stream,
  },
  {
    taskExecStart(
      call: grpc.ServerUnaryCall<Buffer, Buffer>,
      callback: grpc.sendUnaryData<Buffer>,
    ) {
      starts++;
      seen.push(call.request);
      expect(call.metadata.get("authorization")[0]).toBe("Bearer fixture-jwt");

      if (loseStart)
        callback(Object.assign(new Error("lost after effect"), { code: grpc.status.UNAVAILABLE }));
      else callback(null, Buffer.alloc(0));
    },
    taskExecStdinWrite(
      call: grpc.ServerUnaryCall<Buffer, Buffer>,
      callback: grpc.sendUnaryData<Buffer>,
    ) {
      stdinWrites++;
      seen.push(call.request);

      if (loseStdin)
        callback(
          Object.assign(new Error("lost stdin acknowledgement"), { code: grpc.status.UNAVAILABLE }),
        );
      else callback(null, Buffer.alloc(0));
    },
    taskExecWait(call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>) {
      const id = parse(call.request).get(2);

      expect(id).toBeInstanceOf(Uint8Array);
      // SAFETY: The fixture asserted the protobuf exec ID field is bytes.
      expect(new TextDecoder().decode(id as Uint8Array)).toBe("submission-1");

      if (holdWait) setTimeout(() => callback(null, message(field(1, 7))), 100);
      else callback(null, message(field(1, 7)));
    },
    taskExecStdioRead(call: grpc.ServerWritableStream<Buffer, Buffer>) {
      const descriptor = parse(call.request).get(4);
      call.write(
        message(
          field(1, descriptor === 0 ? Uint8Array.from([0, 255, 129]) : Uint8Array.from([42])),
        ),
      );
      call.end();
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

afterAll(() => server.forceShutdown());

function router() {
  const previous = process.env.MODAL_SERVER_URL;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;

  const client = new ModalClient({
    tokenId: "ak-fixture",
    tokenSecret: "as-fixture",
    // SAFETY: The fixture supplies only the two control-plane reads exercised by ModalRouterWire.
    cpClient: {
      async sandboxGetTaskIdV2() {
        return { taskId: "ta-fixture" };
      },
      async sandboxGetCommandRouterAccess() {
        return { url: `http://127.0.0.1:${port}`, jwt: "fixture-jwt" };
      },
    } as never,
  });

  if (previous === undefined) delete process.env.MODAL_SERVER_URL;
  else process.env.MODAL_SERVER_URL = previous;

  return new ModalRouterWire(client);
}

test("one native start on lost response; original ID observes binary output without replay", async () => {
  starts = 0;
  seen.length = 0;
  loseStart = true;
  const wire = router();

  try {
    await expect(
      wire.start({
        sandboxId: "sb-fixture",
        execId: "submission-1",
        command: ["printf", "%s", "hi"],
        cwd: "/tmp",
        env: { KEY: "VALUE" },
        timeoutSeconds: 5,
      }),
    ).rejects.toThrow();
    expect(starts).toBe(1);
    expect(seen[0]?.includes(Buffer.from("/tmp"))).toBe(true);
    expect(seen[0]?.includes(Buffer.from("KEY"))).toBe(true);
    expect(parse(seen[0]!).get(6)).toBe(5);
    const result = await wire.result("sb-fixture", "submission-1", 4);
    expect(result).toEqual({
      exitCode: 7,
      stdout: Uint8Array.from([0, 255, 129]),
      stderr: Uint8Array.from([42]),
      truncated: false,
    });
    expect(starts).toBe(1);
  } finally {
    wire.close();
    loseStart = false;
  }
});

test("binary stdin uses exact offsets and bounded output truncates", async () => {
  starts = 0;
  stdinWrites = 0;
  seen.length = 0;
  const wire = router();

  try {
    await wire.start({
      sandboxId: "sb-fixture",
      execId: "submission-1",
      command: ["cat"],
      timeoutSeconds: 5,
    });
    await wire.stdin("sb-fixture", "submission-1", Uint8Array.from([0, 255, 129]));
    expect(stdinWrites).toBe(2);
    expect(seen[1]?.includes(Buffer.from([0, 255, 129]))).toBe(true);
    expect(parse(seen[2]!).get(3)).toBe(3);
    expect(parse(seen[2]!).get(5)).toBe(1);
    const result = await wire.result("sb-fixture", "submission-1", 2);
    expect(result.stdout.length + result.stderr.length).toBe(2);
    expect(result.truncated).toBe(true);
  } finally {
    wire.close();
  }
});

test("abort stops local wait and close rejects new work without replaying start", async () => {
  starts = 0;
  holdWait = true;
  const wire = router();

  try {
    await wire.start({
      sandboxId: "sb-fixture",
      execId: "submission-1",
      command: ["sleep", "1"],
      timeoutSeconds: 5,
    });
    const controller = new AbortController();
    const wait = wire.result("sb-fixture", "submission-1", 4, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(wait).rejects.toThrow();
    expect(starts).toBe(1);
    holdWait = false;
    expect((await wire.result("sb-fixture", "submission-1", 4)).exitCode).toBe(7);
    wire.close();
    await expect(wire.result("sb-fixture", "submission-1", 4)).rejects.toThrow("closed");
    expect(starts).toBe(1);
  } finally {
    holdWait = false;
    wire.close();
  }
});

test("lost binary stdin acknowledgement is not retried and observation never starts again", async () => {
  starts = 0;
  stdinWrites = 0;
  loseStdin = true;
  const wire = router();

  try {
    await wire.start({
      sandboxId: "sb-fixture",
      execId: "submission-1",
      command: ["cat"],
      timeoutSeconds: 5,
    });
    await expect(
      wire.stdin("sb-fixture", "submission-1", Uint8Array.from([0, 255])),
    ).rejects.toThrow();
    expect(stdinWrites).toBe(1);
    expect(starts).toBe(1);
    loseStdin = false;
    expect((await wire.result("sb-fixture", "submission-1", 4)).exitCode).toBe(7);
    expect(starts).toBe(1);
  } finally {
    loseStdin = false;
    wire.close();
  }
});
