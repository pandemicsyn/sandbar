import { afterEach, expect, test } from "bun:test";
import { adapterSuite } from "@sandbar-sdk/adapter/testing";
import { Sandbar, OutcomeUnknownError } from "sandbar-sdk";
import { createBoxdAdapter } from "./adapter";
import { boxdFixture } from "./fixture.test-support";

const fixtures: Awaited<ReturnType<typeof boxdFixture>>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = await boxdFixture();
  fixtures.push(fixture);
  const adapter = createBoxdAdapter(fixture.factory);

  const connect = () =>
    Sandbar.connect({
      adapter,
      config: { org: "main", networkPolicy: "internet" },
      credentials: { apiKey: "fixture-main" },
    });

  return { fixture, adapter, connect };
}

test("boxd setup takes network internet once, under either name", async () => {
  const { adapter } = await setup();

  const client = await Sandbar.connect({
    adapter,
    config: { org: "main", network: "internet" },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    expect((await client.capabilities()).network).toEqual(["internet"]);
  } finally {
    await client.close();
  }

  for (const config of [
    { org: "main" },
    { org: "main", network: "internet", networkPolicy: "internet" },
  ] as const)
    await expect(
      Sandbar.connect({ adapter, config, credentials: { apiKey: "fixture-main" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("native token exchange accepts user_id and additive response fields", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    expect(fixture.calls.filter((call) => call.method === "Whoami")).toHaveLength(1);
    expect(fixture.effects.create).toBe(0);
  } finally {
    await client.close();
  }
});

test.each([
  "missing-token",
  "invalid-token",
  "empty-token",
  "missing-expiry",
  "invalid-expiry",
  "nonpositive-expiry",
  "expired-token",
] as const)("native token exchange rejects %s before authenticated RPCs", async (fault) => {
  const { fixture, connect } = await setup();

  const envelope: Parameters<typeof fixture.tokenResponse>[0] = {
    token: "fixture-main",
    expires_at: Date.now() / 1000 + 3600,
    user_id: "user-fixture",
    future_field: true,
  };

  switch (fault) {
    case "missing-token":
      delete envelope.token;
      break;
    case "invalid-token":
      envelope.token = 123;
      break;
    case "empty-token":
      envelope.token = "";
      break;
    case "missing-expiry":
      delete envelope.expires_at;
      break;
    case "invalid-expiry":
      envelope.expires_at = "later";
      break;
    case "nonpositive-expiry":
      envelope.expires_at = 0;
      break;
    case "expired-token":
      envelope.expires_at = Date.now() / 1000 - 60;
      break;
  }

  fixture.tokenResponse(envelope);
  await expect(connect()).rejects.toThrow();
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.effects).toEqual({ create: 0, destroy: 0, release: 1 });
});

test("boxd conformance exercises real protobuf RPCs, one-attempt faults and distinct orgs", async () => {
  const { fixture, adapter } = await setup();

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { org: "main", networkPolicy: "internet" },
      credentials: { apiKey: "fixture-main" },
      alternate: {
        config: { org: "alternate", networkPolicy: "internet" },
        credentials: { apiKey: "fixture-alternate" },
      },
      createInput: { image: { kind: "oci", value: "ubuntu:24.04" }, networkPolicy: "internet" },
      counters: () => ({ ...fixture.effects }),
      loseNextCreateResponse: fixture.loseNextCreateResponse,
      holdNextCreateResponse: fixture.holdNextCreateResponse,
      releaseHeldCreateResponse: fixture.releaseHeldCreateResponse,
      assertNativeRetriesDisabled() {
        expect(fixture.calls.filter((call) => call.method === "CreateVm")).toHaveLength(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 2 });
  expect(fixture.calls.filter((call) => call.method === "CreateVm")).toHaveLength(3);
});

test("setup default policy and image produce an ordinary create; explicit blocked and snapshots reject before effects", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    expect((await client.checkCreate()).status).toBe("supported");
    const box = await client.sandboxes.create();
    expect(fixture.calls.find((call) => call.method === "CreateVm")?.request).toMatchObject({
      imageRef: "ubuntu:24.04",
      org: "main",
      isolated: true,
    });
    await expect(client.sandboxes.create({ networkPolicy: "blocked" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(box.snapshot()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.effects.create).toBe(1);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("byte fidelity, bounded exec collection and raw upload acknowledgement", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.execFrames([
      { data: Uint8Array.of(0, 255, 128, 3), exitCode: 0 },
      { data: Uint8Array.of(7, 8), exitCode: 0 },
    ]);

    const result = await box.exec({
      command: { kind: "argv", argv: ["printf", "with spaces", "$(false)"] },
      maxOutputBytes: 3,
    });

    expect(result.stdout).toEqual(Uint8Array.of(0, 255, 128));
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(fixture.calls.filter((call) => call.method === "Exec").at(-1)?.request).toMatchObject({
      command: "printf 'with spaces' '$(false)'",
    });
    const bytes = Uint8Array.of(0, 255, 128);
    await box.writeFile("/file", bytes, { overwrite: true });
    expect(await box.readFile("/file")).toEqual(bytes);
    await box.writeFile("/empty", new Uint8Array(), { overwrite: true });
    expect(await box.readFile("/empty")).toEqual(new Uint8Array());
    fixture.uploadCount(0);
    await expect(box.writeFile("/file", bytes, { overwrite: true })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    fixture.downloadChunks([Uint8Array.of(0, 255), Uint8Array.of(128), Uint8Array.of(3, 7)]);
    expect(await box.readFile("/file")).toEqual(Uint8Array.of(0, 255, 128, 3, 7));
    fixture.downloadChunks([new Uint8Array(700000), new Uint8Array(700000)]);
    await expect(box.readFile("/file")).rejects.toMatchObject({ code: "CAPACITY" });
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("independent block disks mount exclusively, survive destroy and can be explicitly deleted", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    const volume = await client.volumes.create({ name: "workspace" });
    expect((await volume.inspect()).filesystem).toBe("block-backed");
    const box = await client.sandboxes.create({ mounts: [volume.at("/workspace")] });
    await expect(volume.delete()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.sandboxes.create({ mounts: [volume.at("/other")] })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fixture.effects.create).toBe(1);
    await expect(box.destroy()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const cleanup = await box.destroy({ storage: "allow-unconfirmed" });
    expect(cleanup.retainedResources).toContain(volume.reference.nativeId);
    expect((await volume.inspect()).state).toBe("ready");
    await volume.delete();
    expect(fixture.disks.size).toBe(0);
  } finally {
    await client.close();
  }
});

test("fresh credentials reopen saved references; warm lifecycle and renewal report native effects", async () => {
  const { connect } = await setup();
  let client = await connect();

  try {
    const box = await client.sandboxes.create();
    const reference = JSON.parse(JSON.stringify(box.reference));
    await client.close();
    client = await connect();
    const reopened = await client.sandboxes.get(reference);
    expect((await reopened.suspend()).connections).toBe("preserved");
    expect((await reopened.inspect()).state).toBe("suspended");
    const resume = await reopened.resume();
    expect(resume.execution).toBe("resumed");
    expect(resume.connections).toBe("preserved");
    expect((await reopened.renew({ forSeconds: 61 })).observation?.expires.status).toBe("known");
    await reopened.destroy();
  } finally {
    await client.close();
  }
});

test("expiry failure preserves an acknowledged UUID and observation never creates or renews again", async () => {
  const { fixture } = await setup();
  const refs: unknown[] = [];

  const client = await Sandbar.connect({
    adapter: createBoxdAdapter(fixture.factory),
    config: { org: "main", networkPolicy: "internet" },
    credentials: { apiKey: "fixture-main" },
    onReference: (ref) => {
      refs.push(ref);
    },
  });

  try {
    fixture.failExpiry();
    const operation = await client.sandboxes.submitCreate();
    const before = fixture.calls.filter((call) => call.method === "SetDeleteAfter").length;
    expect(JSON.stringify(refs)).toContain([...fixture.machines.keys()][0]);
    let saved: import("@sandbar-sdk/adapter").ResourceReference<"sandbox"> | undefined;

    try {
      await operation.observe();
      throw Error("Expected unconfirmed setup");
    } catch (error) {
      expect(error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: {
          kind: "create",
          status: "partial",
          sandbox: { nativeId: [...fixture.machines.keys()][0] },
        },
      });

      if (error instanceof OutcomeUnknownError) {
        const outcome = (await import("@sandbar-sdk/adapter")).OperationOutcome.parse(
          error.outcome,
        );

        if (outcome.kind === "create") saved = outcome.sandbox;
      }
    }

    const readsBefore = fixture.calls.filter((call) => call.method === "GetVm").length;
    const probesBefore = fixture.calls.filter((call) => call.method === "Exec").length;

    await expect((await client.recover(operation.reference)).observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      outcome: { kind: "create", status: "partial", sandbox: saved },
    });
    expect(fixture.calls.filter((call) => call.method === "GetVm")).toHaveLength(readsBefore + 1);
    fixture.failNextGet();
    await expect((await client.recover(operation.reference)).observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      outcome: { kind: "create", status: "partial", sandbox: saved },
    });
    expect(fixture.calls.filter((call) => call.method === "GetVm")).toHaveLength(readsBefore + 2);
    expect(fixture.calls.filter((call) => call.method === "Exec")).toHaveLength(probesBefore);
    expect(fixture.effects.create).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "SetDeleteAfter")).toHaveLength(before);
    fixture.failExpiry(false);

    if (!saved) throw Error("Known sandbox reference missing");
    const known = await client.sandboxes.get(saved);
    expect((await known.inspect()).state).toBe("running");
    await known.destroy();
    expect(fixture.effects.create).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "SetDeleteAfter")).toHaveLength(before);
  } finally {
    await client.close();
  }
});

test("foreign native orgs and truncated directories fail rather than fabricating safe observations", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.truncateListing();
    await expect(box.readDirectory("/")).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
    fixture.badOrg();
    await expect(box.inspect()).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await client.close();
  }
});

test("native exec without an exit receipt is unknown", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.omitExit();
    await expect(
      box.exec({ command: { kind: "argv", argv: ["true"] }, deadlineSeconds: 1 }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("native empty final exec frame confirms a zero exit without output", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.execFrames([]);

    const result = await box.exec({
      command: { kind: "argv", argv: ["true"] },
      deadlineSeconds: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(new Uint8Array());
    expect(result.stderr).toEqual(new Uint8Array());
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("checkpoint failure exposes the known sandbox and stops before expiry installation", async () => {
  const { fixture, adapter } = await setup();

  const client = await Sandbar.connect({
    adapter,
    config: { org: "main", networkPolicy: "internet" },
    credentials: { apiKey: "fixture-main" },
    onReference(ref) {
      if (ref.token !== undefined) throw Error("storage unavailable");
    },
  });

  try {
    let saved: import("@sandbar-sdk/adapter").ResourceReference<"sandbox"> | undefined;

    try {
      await client.sandboxes.create();
      throw Error("Expected persistence failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "REFERENCE_SAVE_FAILED",
        outcome: {
          kind: "create",
          status: "partial",
          setup: { expiry: "unconfirmed", readiness: "unconfirmed" },
        },
      });

      if (error instanceof Error && "outcome" in error) {
        const outcome = (await import("@sandbar-sdk/adapter")).OperationOutcome.parse(
          error.outcome,
        );

        if (outcome.kind === "create") saved = outcome.sandbox;
      }
    }

    expect(saved?.nativeId).toBe([...fixture.machines.keys()][0]);
    expect(fixture.calls.some((call) => call.method === "SetDeleteAfter")).toBe(false);

    // Reopen with a fresh persistence path; cleanup uses the normal SDK handle.
    const fresh = await Sandbar.connect({
      adapter,
      config: { org: "main", networkPolicy: "internet" },
      credentials: { apiKey: "fixture-main" },
    });

    try {
      if (!saved) throw Error("Known sandbox reference missing");
      await (await fresh.sandboxes.get(saved)).destroy();
    } finally {
      await fresh.close();
    }
  } finally {
    await client.close();
  }
});

test.each(["unavailable", "wrong-org", "wrong-id"] as const)(
  "create metadata %s preserves the acknowledged identity before further effects",
  async (fault) => {
    const { fixture, connect } = await setup();
    const client = await connect();

    try {
      if (fault === "unavailable") fixture.failNextGet();
      else if (fault === "wrong-org") fixture.badOrg();
      else fixture.wrongGetId();
      let saved: import("@sandbar-sdk/adapter").ResourceReference<"sandbox"> | undefined;

      try {
        await client.sandboxes.create();
        throw Error("Expected unconfirmed setup");
      } catch (error) {
        expect(error).toBeInstanceOf(OutcomeUnknownError);

        if (error instanceof OutcomeUnknownError) {
          const outcome = (await import("@sandbar-sdk/adapter")).OperationOutcome.parse(
            error.outcome,
          );

          if (outcome.kind === "create") saved = outcome.sandbox;
        }
      }

      expect(saved?.nativeId).toBe([...fixture.machines.keys()][0]);
      expect(fixture.effects.create).toBe(1);
      expect(fixture.calls.some((call) => call.method === "SetDeleteAfter")).toBe(false);
      expect(fixture.calls.some((call) => call.method === "Exec")).toBe(false);
      fixture.badOrg(false);
      fixture.wrongGetId(false);

      if (!saved) throw Error("Known sandbox reference missing");
      await (await client.sandboxes.get(saved)).destroy();
    } finally {
      await client.close();
    }
  },
);

test("confirmed pause and wake acknowledgements survive failed observations without replay", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.failLifecycleRead();
    await expect(box.suspend()).rejects.toMatchObject({
      outcome: { kind: "sandbox_suspend", status: "partial", acknowledged: true },
    });
    expect((await box.inspect()).state).toBe("suspended");
    await expect(box.resume()).rejects.toMatchObject({
      outcome: { kind: "sandbox_resume", status: "partial", acknowledged: true },
    });
    expect((await box.inspect()).state).toBe("running");
    expect(fixture.calls.filter((call) => call.method === "SuspendVm")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === "WakeVm")).toHaveLength(1);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("native terminal readiness failure retains expiry acknowledgement and normal cleanup identity", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    fixture.machineStates(["pending", "pending", "failed"]);
    const operation = await client.sandboxes.submitCreate();
    let saved: import("@sandbar-sdk/adapter").ResourceReference<"sandbox"> | undefined;

    try {
      await operation.observe();
      throw Error("Expected readiness failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: {
          kind: "create",
          status: "partial",
          setup: { expiry: "acknowledged", readiness: "unconfirmed" },
        },
      });

      if (error instanceof OutcomeUnknownError) {
        const outcome = (await import("@sandbar-sdk/adapter")).OperationOutcome.parse(
          error.outcome,
        );

        if (outcome.kind === "create") saved = outcome.sandbox;
      }
    }

    expect(fixture.observedStates).toEqual(["pending", "pending", "failed"]);
    await expect((await client.recover(operation.reference)).observe()).rejects.toMatchObject({
      outcome: { kind: "create", status: "partial", sandbox: saved },
    });
    expect(fixture.effects.create).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "SetDeleteAfter")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === "Exec")).toHaveLength(0);

    if (!saved) throw Error("Known sandbox reference missing");
    await (await client.sandboxes.get(saved)).destroy();
  } finally {
    await client.close();
  }
});

test("native readiness polls pending and starting before probing a running guest", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    fixture.machineStates(["pending", "pending", "pending", "starting", "running"]);
    const box = await client.sandboxes.create();
    expect(fixture.observedStates).toEqual([
      "pending",
      "pending",
      "pending",
      "starting",
      "running",
      "running",
    ]);
    expect(fixture.calls.filter((call) => call.method === "Exec")).toHaveLength(1);
    expect(fixture.calls.find((call) => call.method === "Exec")?.request).toMatchObject({
      command: "true",
    });
    expect(fixture.effects.create).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "SetDeleteAfter")).toHaveLength(1);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("native readiness retries a failed true probe while preserving the created machine", async () => {
  const { fixture, connect } = await setup();
  const client = await connect();

  try {
    fixture.execFailures(1);
    const box = await client.sandboxes.create();
    expect(fixture.calls.filter((call) => call.method === "Exec")).toHaveLength(2);
    expect(
      fixture.calls.filter((call) => call.method === "Exec").map((call) => call.request),
    ).toMatchObject([
      { command: "true", vmId: box.id },
      { command: "true", vmId: box.id },
    ]);
    expect(fixture.effects.create).toBe(1);
    expect(fixture.calls.filter((call) => call.method === "SetDeleteAfter")).toHaveLength(1);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("public preview pins configured routes at create, verifies identity and never mutates on lookup", async () => {
  const { fixture, adapter, connect } = await setup();
  const defaults = await connect();

  try {
    const box = await defaults.sandboxes.create();
    const before = fixture.calls.length;
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.calls).toHaveLength(before);
    await box.destroy();
  } finally {
    await defaults.close();
  }

  const client = await Sandbar.connect({
    adapter,
    config: {
      org: "main",
      networkPolicy: "internet",
      size: 1,
      preview: { access: "public", ports: [3000, 8080] },
    },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    const box = await client.sandboxes.create();
    expect(
      fixture.calls.filter((call) => call.method === "CreateVm").at(-1)?.request,
    ).toMatchObject({
      config: {
        vcpu: 1,
        network: {
          proxies: [
            { name: "sandbar-3000", port: 3000 },
            { name: "sandbar-8080", port: 8080 },
          ],
        },
      },
    });
    const before = fixture.calls.length;
    expect(await box.preview(3000)).toMatchObject({
      access: "public",
      url: expect.stringContaining("https://sandbar-3000."),
    });
    expect(fixture.calls.slice(before).map((call) => call.method)).toEqual([
      "GetVm",
      "ListProxies",
    ]);
    fixture.machines.get(box.id)?.proxies.push({ name: "sandbar-9000", port: 9000 });
    const unconfigured = fixture.calls.length;
    await expect(box.preview(9000)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.calls).toHaveLength(unconfigured);
    await box.suspend();
    const sleeping = fixture.calls.length;
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.calls.slice(sleeping).map((call) => call.method)).toEqual(["GetVm"]);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("read-only disk mounts are exact and reusable after fresh-client cleanup; hibernation wakes once", async () => {
  const { fixture, connect } = await setup();
  let client = await connect();

  try {
    const disk = await client.volumes.create({ name: "readonly" });
    const diskRef = JSON.parse(JSON.stringify(disk.reference));

    const box = await client.sandboxes.create({
      mounts: [disk.at("/data", { access: "read-only" })],
    });

    expect(
      fixture.calls.filter((call) => call.method === "CreateVm").at(-1)?.request,
    ).toMatchObject({
      config: {
        volumes: [{ diskId: disk.reference.nativeId, mountPath: "/data", readOnly: true }],
      },
    });
    const machine = fixture.machines.get(box.id)!;
    machine.status = "hibernated";
    expect((await box.resume()).execution).toBe("resumed");
    expect(fixture.calls.filter((call) => call.method === "WakeVm")).toHaveLength(1);
    const reference = box.reference;

    if (!reference) throw Error("Missing sandbox reference");
    await client.close();
    client = await connect();
    const reopened = await client.sandboxes.get(reference);
    const cleanup = await reopened.destroy({ storage: "allow-unconfirmed" });
    expect(cleanup.mountDurability).toMatchObject([{ path: "/data", status: "unconfirmed" }]);
    const borrowed = await client.volumes.get(diskRef);
    await borrowed.delete();
    expect(fixture.disks.size).toBe(0);
  } finally {
    await client.close();
  }
});

test("public preview rejects empty/duplicate ports before connecting", async () => {
  const { adapter, fixture } = await setup();

  for (const ports of [[], [3000, 3000]])
    await expect(
      Sandbar.connect({
        adapter,
        config: { org: "main", networkPolicy: "internet", preview: { access: "public", ports } },
        credentials: { apiKey: "fixture-main" },
      }),
    ).rejects.toBeDefined();
  expect(fixture.calls).toHaveLength(0);
});

test("exec retains confirmed exit and captured bytes after a transport failure", async () => {
  const { fixture } = await setup();

  const adapter = createBoxdAdapter((key) => {
    const native = fixture.factory(key);

    return {
      ...native,
      run(ctx, action) {
        if (ctx.output) {
          ctx.output.stdout.push(Uint8Array.of(0, 255));
          ctx.output.stderr.push(Uint8Array.of(128));
          ctx.confirmedExit = 7;

          return Promise.reject(Error("transport failed after terminal receipt"));
        }

        return native.run(ctx, action);
      },
    };
  });

  const client = await Sandbar.connect({
    adapter,
    config: { org: "main", networkPolicy: "internet" },
    credentials: { apiKey: "fixture-main" },
  });

  try {
    const box = await client.sandboxes.create();

    await expect(box.exec({ command: { kind: "argv", argv: ["false"] } })).rejects.toMatchObject({
      code: "NONZERO_EXIT",
      result: {
        exitCode: 7,
        truncated: true,
        stdout: Uint8Array.of(0, 255),
        stderr: Uint8Array.of(128),
      },
    });
  } finally {
    await client.close();
  }
});
