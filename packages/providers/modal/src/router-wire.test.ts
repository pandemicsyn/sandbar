import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
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

let loseOutput = false;

let firstStream: "stdout" | "stderr" | undefined;

let waitReply = message(field(1, 7));

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

      if (holdWait) setTimeout(() => callback(null, waitReply), 100);
      else callback(null, waitReply);
    },
    taskExecStdioRead(call: grpc.ServerWritableStream<Buffer, Buffer>) {
      const descriptor = parse(call.request).get(4);
      expect(descriptor === 1 || descriptor === 2).toBe(true);

      if (loseOutput && descriptor === 2) {
        call.emit(
          "error",
          Object.assign(new Error("output unavailable after exit"), {
            code: grpc.status.UNAVAILABLE,
          }),
        );

        return;
      }

      const emit = () => {
        call.write(
          message(
            field(1, descriptor === 1 ? Uint8Array.from([0, 255, 129]) : Uint8Array.from([42])),
          ),
        );
        call.end();
      };

      if (firstStream) setTimeout(emit, (descriptor === 1) === (firstStream === "stdout") ? 0 : 20);
      else emit();
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

function router(lookups?: { task?: () => Promise<void>; access?: () => Promise<void> }) {
  const previous = process.env.MODAL_SERVER_URL;
  process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;

  const client = new ModalClient({
    tokenId: "ak-fixture",
    tokenSecret: "as-fixture",
    // SAFETY: The fixture supplies only the two control-plane reads exercised by ModalRouterWire.
    cpClient: {
      async sandboxGetTaskIdV2() {
        await lookups?.task?.();

        return { taskId: "ta-fixture" };
      },
      async sandboxGetCommandRouterAccess() {
        await lookups?.access?.();

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

test("optional native exit code accepts explicit zero and rejects missing status without replay", async () => {
  starts = 0;
  const wire = router();

  try {
    await wire.start({
      sandboxId: "sb-fixture",
      execId: "submission-1",
      command: ["true"],
      timeoutSeconds: 5,
    });
    // Modal 0.10.1 encodes optional code=0 as a present varint, not an omitted default.
    waitReply = message(field(1, 0));
    expect((await wire.result("sb-fixture", "submission-1", 4)).exitCode).toBe(0);
    waitReply = message(field(2, 9));
    expect((await wire.result("sb-fixture", "submission-1", 4)).exitCode).toBe(137);
    waitReply = Buffer.alloc(0);
    await expect(wire.result("sb-fixture", "submission-1", 4)).rejects.toThrow("unavailable");
    expect(starts).toBe(1);
  } finally {
    waitReply = message(field(1, 7));
    wire.close();
  }
});

test("stdout-first retention is independent of arrival order with exact combined bounds", async () => {
  starts = 0;
  const wire = router();

  try {
    await wire.start({
      sandboxId: "sb-fixture",
      execId: "submission-1",
      command: ["printf", "fixture"],
      timeoutSeconds: 5,
    });

    for (const order of ["stdout", "stderr"] as const) {
      firstStream = order;

      for (const limit of [0, 2, 3, 4]) {
        const result = await wire.result("sb-fixture", "submission-1", limit);
        expect(result).toEqual({
          exitCode: 7,
          stdout: Uint8Array.from([0, 255, 129].slice(0, limit)),
          stderr: limit === 4 ? Uint8Array.from([42]) : new Uint8Array(),
          truncated: limit < 4,
        });
        expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(limit);
      }
    }

    expect(starts).toBe(1);
  } finally {
    firstStream = undefined;
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

test("abort or close during either control lookup prevents new channels and router requests", async () => {
  starts = 0;
  stdinWrites = 0;
  const channels = spyOn(grpc.credentials, "createInsecure");

  try {
    for (const stage of ["initial", "task", "access"] as const) {
      for (const stop of ["abort", "close"] as const) {
        for (const operation of ["start", "stdin", "result"] as const) {
          let releaseLookup = () => {};

          let enteredLookup = () => {};

          const blocked = new Promise<void>((resolve) => {
            releaseLookup = resolve;
          });

          const entered = new Promise<void>((resolve) => {
            enteredLookup = resolve;
          });

          let taskReads = 0;
          let accessReads = 0;

          const wire = router({
            async task() {
              taskReads++;

              if (stage === "task") {
                enteredLookup();
                await blocked;
              }
            },
            async access() {
              accessReads++;

              if (stage === "access") {
                enteredLookup();
                await blocked;
              }
            },
          });

          channels.mockClear();
          const controller = new AbortController();
          const cancel = () => (stop === "abort" ? controller.abort() : wire.close());

          if (stage === "initial") cancel();

          const operations = {
            start: () =>
              wire.start(
                {
                  sandboxId: "sb-fixture",
                  execId: "submission-1",
                  command: ["cat"],
                  timeoutSeconds: 5,
                },
                controller.signal,
              ),
            stdin: () =>
              wire.stdin(
                "sb-fixture",
                "submission-1",
                Uint8Array.from([0, 255]),
                controller.signal,
              ),
            result: () => wire.result("sb-fixture", "submission-1", 4, controller.signal),
          };

          const pending = operations[operation]();

          // Attach rejection handling before releasing the deferred native lookup.
          const rejected = pending.then(
            () => false,
            () => true,
          );

          if (stage !== "initial") {
            await entered;
            cancel();
            releaseLookup();
          }

          expect(await rejected).toBe(true);
          expect(taskReads).toBe(stage === "initial" ? 0 : 1);
          expect(accessReads).toBe(stage === "access" ? 1 : 0);
          expect(channels).not.toHaveBeenCalled();
          expect(starts).toBe(0);
          expect(stdinWrites).toBe(0);
          wire.close();
        }
      }
    }
  } finally {
    channels.mockRestore();
  }
});

test("local deadline permits later original-ID recovery; exit alone cannot hide output failure", async () => {
  starts = 0;
  const wire = router();

  try {
    await wire.start({
      sandboxId: "sb-fixture",
      execId: "submission-1",
      command: ["true"],
      timeoutSeconds: 7,
    });
    holdWait = true;
    await expect(
      wire.result("sb-fixture", "submission-1", 4, AbortSignal.timeout(10)),
    ).rejects.toThrow();
    holdWait = false;
    waitReply = message(field(1, 0));
    loseOutput = true;
    await expect(wire.result("sb-fixture", "submission-1", 4)).rejects.toThrow();
    loseOutput = false;
    expect(await wire.result("sb-fixture", "submission-1", 4)).toMatchObject({
      exitCode: 0,
      stdout: Uint8Array.from([0, 255, 129]),
      stderr: Uint8Array.from([42]),
    });
    expect(starts).toBe(1);
    expect(parse(seen.at(-1)!).get(6)).toBe(7);
  } finally {
    holdWait = false;
    loseOutput = false;
    waitReply = message(field(1, 7));
    wire.close();
  }
});
