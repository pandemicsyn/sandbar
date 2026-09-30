import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, disposeFixtures } from "./offline";
import { TestResources } from "./resources";
import { snapshotRoundtrip } from "../snapshots.test";
import { cleanupOwned } from "./cleanup";

async function resources(f: Awaited<ReturnType<typeof fixture>>, exerciseMs = 5000) {
  const t = new TestResources(f.connect, f.ledger, "base", "blocked", {
    compute: 3,
    snapshots: 1,
    volumes: 1,
    exerciseMs,
    cleanupMs: 1000,
  });

  await t.open();

  return t;
}

afterEach(disposeFixtures);

const reopen = async () => {};

test("Bun snapshot body retains isolation, fresh execution, reopen and independent owned cleanup", async () => {
  const f = await fixture();
  const t = await resources(f);
  let reopened = 0;

  try {
    await snapshotRoundtrip(t, async (ref) => {
      const client = await f.connect(async () => {
        throw Error("Read-only reopen must not mutate");
      });

      try {
        expect((await (await client.snapshots.get(ref)).inspect()).state).toBe("ready");
        reopened++;
      } finally {
        await client.close();
      }
    });
  } finally {
    await t.close();
  }

  expect(reopened).toBe(1);
  expect(f.calls).toMatchObject({ create: 1, capture: 1, restore: 2, peak: 2 });
  expect([f.boxes.size, f.snapshots.size]).toEqual([0, 0]);
  expect((await f.ledger.read()).cleanup).toBe("confirmed");
});

test.each(["source", "restored", "aliased"] as const)(
  "snapshot body rejects %s filesystem isolation failure and cleans owned resources",
  async (kind) => {
    const f = await fixture({
      dropSourceChange: kind === "source",
      dropRestoredChange: kind === "restored",
      aliasRestoredFilesystem: kind === "aliased",
    });

    const t = await resources(f);

    try {
      await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow();
    } finally {
      await t.close();
    }

    expect([f.boxes.size, f.snapshots.size]).toEqual([0, 0]);
  },
);

test("snapshot setup failure retains its creator reference for explicit reconciliation", async () => {
  const f = await fixture({ failCreate: true });
  const t = await resources(f);
  await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow();
  await expect(t.close()).rejects.toThrow("unresolved");
  expect((await f.ledger.read()).stateMutations?.some((entry) => entry.creation)).toBe(true);
  expect(f.calls.create).toBe(1);
});

test("saved-reference reopen failure fails the body without losing owned teardown", async () => {
  const f = await fixture();
  const t = await resources(f);

  try {
    await expect(
      snapshotRoundtrip(t, async () => {
        throw Error("Reopen failed");
      }),
    ).rejects.toThrow("Reopen failed");
  } finally {
    await t.close();
  }

  expect([f.boxes.size, f.snapshots.size]).toEqual([0, 0]);
  expect(f.calls.restore).toBe(1);
});

test("teardown failure remains unsuccessful and durably blocks same-provider admission", async () => {
  const f = await fixture({ failDelete: true });
  const t = await resources(f);
  await t.create("snapshot/source");
  await expect(t.close()).rejects.toThrow("unresolved");
  expect((await f.ledger.read()).cleanup).toBe("unresolved");
  await expect(f.ledger.requirePreviousCleanup("daytona")).rejects.toThrow("unresolved");
});

test("exercise cancellation cannot authorize late allocation and cleanup has its own signal", async () => {
  const f = await fixture();
  const t = await resources(f);
  await t.create("snapshot/source");
  t.controller.abort("Bun timeout");
  await expect(t.create("late")).rejects.toThrow();
  await t.close();
  expect(f.calls.create).toBe(1);
  expect(f.boxes.size).toBe(0);
});

test("unknown snapshot capture preserves source evidence and never repeats creation during cleanup", async () => {
  const f = await fixture({ loseCapture: true });
  const t = await resources(f);
  await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow();
  await expect(t.close()).rejects.toThrow("unresolved");
  const client = await f.connect((reference) => f.ledger.saveStateReference(reference));

  try {
    await expect(cleanupOwned(client, f.ledger, 1000)).rejects.toThrow("unresolved");
  } finally {
    await client.close();
  }

  expect(f.calls.capture).toBe(1);
  expect(f.boxes.size).toBe(1);
});

test.each(["snapshot", "failed-snapshot", "volume"] as const)(
  "compact %s acknowledged custody stays owned after a lost result",
  async (compactCustody) => {
    const f = await fixture({ compactCustody });
    const t = await resources(f);

    if (compactCustody === "volume") await expect(t.volume()).rejects.toThrow();
    else await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow();
    // The original body failed, but acknowledged partial identities permit owned teardown.
    await t.close();
    const state = await f.ledger.read();
    expect(state.stateMutations?.some((entry) => !!entry.resource)).toBe(true);
    expect(f.calls.capture + f.calls.volumeCreate).toBe(1);
  },
);

test("fixture checkpoint failure prevents native allocation", async () => {
  const f = await fixture({ checkpointFailure: true });
  const t = await resources(f);
  await expect(t.create("snapshot/source")).rejects.toThrow();
  await expect(t.close()).rejects.toThrow();
  expect(f.calls.create).toBe(0);
});

test("unsupported restore fails before allocating compute or capture", async () => {
  const f = await fixture({ restoreUnsupported: true });
  const t = await resources(f);

  try {
    await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow("Immutable restore unavailable");
  } finally {
    await t.close();
  }

  expect(f.calls).toMatchObject({ create: 0, capture: 0, restore: 0 });
});

test("stopped source profile fails before snapshot capture", async () => {
  const f = await fixture({ stoppedSource: true });
  const t = await resources(f);

  try {
    await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow();
  } finally {
    await t.close();
  }

  expect(f.calls.capture).toBe(0);
  expect(f.boxes.size).toBe(0);
});

test("filesystem clone cannot satisfy RAM nonce/counter assertions", async () => {
  const f = await fixture({ memory: true });
  const t = await resources(f);

  try {
    await expect(snapshotRoundtrip(t, reopen)).rejects.toThrow();
  } finally {
    await t.close();
  }

  expect(f.calls.capture).toBe(1);
});

test("per-fixture compute and concurrency limits remain pre-dispatch checks", async () => {
  const f = await fixture();
  const t = await resources(f);

  try {
    await t.create("one");
    await t.create("two");
    await expect(t.create("three")).rejects.toThrow("budget");
  } finally {
    await t.close();
  }

  expect(f.calls.create).toBe(2);
  expect(f.boxes.size).toBe(0);
});

test.each(["setup", "test"] as const)(
  "actual Bun %s timeout still runs bounded owned cleanup",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "sandbar-bun-timeout-"));
    const child = join(directory, "timeout.test.ts");
    const summary = join(directory, "summary.json");
    const resourcesPath = fileURLToPath(new URL("./resources.ts", import.meta.url));
    const fixturePath = fileURLToPath(new URL("./offline.ts", import.meta.url));
    await writeFile(
      child,
      `
import {beforeAll,afterAll,test} from "bun:test";
import {writeFile,access} from "node:fs/promises";
import {dirname,join} from "node:path";
import {TestResources} from ${JSON.stringify(resourcesPath)};
import {fixture} from ${JSON.stringify(fixturePath)};
let t,f;
beforeAll(async()=>{
 f=await fixture();
 const factory=${phase === "setup" ? "async (hook)=>{await new Promise(r=>setTimeout(r,100));return f.connect(hook);}" : "f.connect"};
 t=new TestResources(factory,f.ledger,"base","blocked",{compute:1,snapshots:0,volumes:0,exerciseMs:500,cleanupMs:500});
 await t.open();
 if(${JSON.stringify(phase)}==="test")await t.create("sandbox/source");
},${phase === "setup" ? 20 : 500});
afterAll(async()=>{
 await t.close();
 let unlocked=false;try{await access(join(dirname(f.ledger.path),".admission.lock"));}catch(error){if(error.code!=="ENOENT")throw error;unlocked=true;}
 await writeFile(${JSON.stringify(summary)},JSON.stringify({cleanup:(await f.ledger.read()).cleanup,boxes:f.boxes.size,unlocked}));
},6000);
test("snapshot-roundtrip",async()=>{await new Promise(()=>{});},20);
`,
    );

    try {
      const childProcess = Bun.spawn(
        [
          process.execPath,
          "test",
          child,
          "--reporter=junit",
          `--reporter-outfile=${join(directory, "junit.xml")}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const [exit, xml] = await Promise.all([
        childProcess.exited,
        new Response(childProcess.stderr).text(),
      ]);

      expect(exit).not.toBe(0);
      expect(xml.toLowerCase()).toMatch(/timeout|timed out/);
      expect(JSON.parse(await readFile(summary, "utf8"))).toMatchObject({
        boxes: 0,
        unlocked: true,
        cleanup: phase === "setup" ? "not-required" : "confirmed",
      });
      expect(await readFile(join(directory, "junit.xml"), "utf8")).toContain("<failure");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);

test("failed read-only connection and pre-open cancellation allocate nothing and release admission", async () => {
  const f = await fixture();
  let calls = 0;

  const t = new TestResources(
    async () => {
      calls++;
      throw Error("connection failed");
    },
    f.ledger,
    "base",
    "blocked",
    { compute: 1, snapshots: 0, volumes: 0, exerciseMs: 5000, cleanupMs: 1000 },
  );

  try {
    await expect(t.open()).rejects.toThrow("connection failed");
  } finally {
    await t.close();
  }

  expect(calls).toBe(1);
  expect((await f.ledger.read()).cleanup).toBe("not-required");

  const cancelled = new TestResources(f.connect, f.ledger, "base", "blocked", {
    compute: 1,
    snapshots: 0,
    volumes: 0,
    exerciseMs: 5000,
    cleanupMs: 1000,
  });

  cancelled.controller.abort();

  try {
    await expect(cancelled.open()).rejects.toThrow();
  } finally {
    await cancelled.close();
  }

  expect(f.calls.create).toBe(0);
});

test("independent fixtures contend on the shared directory admission lock", async () => {
  const f = await fixture();
  const first = await resources(f);

  const second = new TestResources(f.connect, f.ledger, "base", "blocked", {
    compute: 1,
    snapshots: 0,
    volumes: 0,
    exerciseMs: 5000,
    cleanupMs: 1000,
  });

  try {
    await expect(second.open()).rejects.toMatchObject({ code: "EEXIST" });
  } finally {
    await second.close();
    await first.close();
  }
});

for (const option of ["partialReferenceCapture", "pendingNativeCapture"] as const)
  test(`snapshot ${option} retains partial custody through failed body and explicit cleanup`, async () => {
    const f = await fixture({ [option]: true });
    const t = await resources(f);
    await expect(snapshotRoundtrip(t, async () => {})).rejects.toThrow();

    if (option === "pendingNativeCapture") {
      await expect(t.close()).rejects.toThrow();
      expect(f.boxes.size).toBe(1);
      expect((await f.ledger.read()).cleanup).toBe("unresolved");
    } else {
      await t.close();
      expect(f.boxes.size).toBe(0);
      expect(f.snapshots.size).toBe(0);
      expect((await f.ledger.read()).cleanup).toBe("confirmed");
    }

    expect(f.calls.capture).toBe(1);
  });

test("snapshot profile metadata remains available when reopening later fails", async () => {
  const f = await fixture();
  const t = await resources(f);
  let observed: import("sandbar-adapter").SnapshotProfile | undefined;

  try {
    await expect(
      snapshotRoundtrip(
        t,
        async () => {
          throw Error("reopen failure");
        },
        "/tmp/profile.bin",
        (profile) => {
          observed = profile;
        },
      ),
    ).rejects.toThrow("reopen failure");
  } finally {
    await t.close();
  }

  expect(observed).toMatchObject({
    preserve: "filesystem",
    restoreExecution: "fresh",
    sourceAfter: "unchanged",
  });
});
