import { expect, test } from "bun:test";
import { z } from "zod";
import {
  defineAdapter,
  RecoveryFacts,
  type ResourceReference,
  type SnapshotCaptureValue,
  type SnapshotProfile,
} from "sandbar-adapter";
import { Sandbar, Image, ReferencePersistenceError, type AdapterRecoveryReference } from "./index";
import { bindAdapter } from "./bound";

for (const boundary of [
  "128 result resources",
  "32 prior resources and 16 completed steps",
  "large resource histories",
  "near-limit prior steps",
  "oversized primary resource",
  "failed completion persistence",
  "enriched resource identity",
  "pending after confirmed evidence",
  "maximum escaped resource evidence",
] as const) {
  test(`successful capture remains recoverable with ${boundary}`, async () => {
    const scope = {
      authority: { kind: "account", id: "one" },
      partition:
        boundary === "oversized primary resource"
          ? Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(i), "x".repeat(1800)]))
          : {},
    };

    const resource = (nativeId: string): ResourceReference => ({
      version: 1,
      kind: "volume",
      provider: "fixture.completion",
      scope,
      nativeId,
      ownership: "verified-created",
    });

    const primary: ResourceReference = { ...resource("snapshot"), kind: "snapshot" };

    if (boundary === "near-limit prior steps" || boundary === "oversized primary resource")
      primary.history = "x".repeat(4094);

    if (boundary === "oversized primary resource") primary.receipt = "x".repeat(4096);

    if (
      boundary === "enriched resource identity" ||
      boundary === "pending after confirmed evidence"
    ) {
      primary.history = { revision: "confirmed" };
      primary.receipt = "confirmed-receipt";
    }

    let priorResources: ResourceReference[] = [];

    if (boundary === "32 prior resources and 16 completed steps")
      priorResources = Array.from({ length: 32 }, (_, i) => resource(`prior-${i}`));
    else if (boundary === "enriched resource identity")
      priorResources = [
        { ...primary, history: undefined, receipt: undefined, ownership: "unknown" },
      ];
    else if (boundary === "pending after confirmed evidence") priorResources = [primary];

    const prior: RecoveryFacts = {
      version: 1,
      retainedResources: priorResources,
      completed:
        boundary === "32 prior resources and 16 completed steps" ||
        boundary === "near-limit prior steps"
          ? Array.from({ length: 16 }, (_, i) => ({ step: `prior-${i}` }))
          : [],
      steps:
        boundary === "near-limit prior steps"
          ? Array.from({ length: 14 }, (_, i) => ({
              step: `prior-${i}`,
              status: "completed" as const,
              reason: "x".repeat(1024),
            }))
          : [],
      continuation: { supported: false, status: "unavailable", reason: "Observe only" },
    };

    RecoveryFacts.parse(prior);

    const profile: SnapshotProfile = {
      id: "memory",
      preserve: "filesystem+memory",
      sourceStates: ["running"],
      interruption: "pause",
      sourceAfter: "unchanged",
      consistency: "crash-consistent",
      connections: "dropped",
      mountHandling: "none",
      restoreExecution: "resume",
    };

    let retainedResources: ResourceReference[] = [];

    if (boundary === "128 result resources")
      retainedResources = Array.from({ length: 128 }, (_, i) => resource(`result-${i}`));

    if (boundary === "large resource histories")
      retainedResources = Array.from({ length: 5 }, (_, i) => ({
        ...resource(`result-${i}`),
        history: "x".repeat(4094),
      }));

    if (boundary === "enriched resource identity")
      retainedResources = [
        { ...primary, history: undefined, receipt: undefined, ownership: "unknown" },
      ];

    if (boundary === "maximum escaped resource evidence") {
      const escaped = {
        history: "\0".repeat(682),
        receipt: "\0".repeat(4096),
        generation: "\0".repeat(512),
      };

      Object.assign(primary, escaped);
      retainedResources = Array.from({ length: 128 }, (_, i) => ({
        ...resource(`${i}-${"\0".repeat(500)}`),
        ...escaped,
      }));
    }

    const capture: SnapshotCaptureValue = {
      snapshot: {
        reference: primary,
        preserve: profile.preserve,
        restoreExecution: profile.restoreExecution,
        consistency: profile.consistency,
        source: { id: "box", class: "fixture" },
        state: "ready",
        createdAt: null,
        expiration: "unknown",
        excludedPaths: null,
        mounts: [],
        mountHandling: "none",
        restore: {
          networkPolicies: ["blocked"],
          resources: false,
          mounts: false,
          independentLifecycle: true,
        },
        dependencies: [],
        nativeDependencies: [],
      },
      capture: {
        preserve: profile.preserve,
        interruption: profile.interruption,
        restoreExecution: profile.restoreExecution,
      },
      source: { state: "running", connections: "dropped" },
      retainedResources,
    };

    let submissions = 0;
    let observing = false;
    let observations = 0;
    let saveFails = boundary === "failed completion persistence";
    let saved: AdapterRecoveryReference | undefined;

    const adapter = defineAdapter({
      name: "fixture.completion",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope,
          supports: { images: ["prepared"], network: ["blocked"] },
          async create() {
            return { id: "box", state: "running" as const };
          },
          async inspect() {
            return { id: "box", state: "running" as const };
          },
          async snapshotProfiles() {
            return {
              status: "supported" as const,
              value: { profiles: [profile], defaultProfileId: profile.id },
            };
          },
          snapshotCapture: {
            recovery: {
              version: 1,
              token: z.strictObject({}),
              facts: () =>
                observing && boundary === "pending after confirmed evidence"
                  ? { ...prior, retainedResources: [] }
                  : prior,
            },
            async submit(_input, ctx) {
              submissions++;
              await ctx.checkpoint({});

              return capture;
            },
            async observe(_attempt, ctx) {
              if (boundary === "pending after confirmed evidence" && observations++ === 0)
                return ctx.pending({});

              return boundary === "enriched resource identity"
                ? {
                    ...capture,
                    snapshot: { ...capture.snapshot, reference: retainedResources[0]! },
                  }
                : capture;
            },
          },
        };
      },
    });

    const client = await Sandbar.connect(bindAdapter(adapter, {}, {}), {
      onReference(reference) {
        saved = JSON.parse(JSON.stringify(reference));

        if (saveFails && reference.kind === "snapshot_capture" && reference.completion)
          throw new Error("Store offline");
      },
    });

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await box.submitSnapshot();

      if (saveFails) {
        const error = await operation.wait().catch((error: Error) => error);
        expect(error).toBeInstanceOf(ReferencePersistenceError);

        if (!(error instanceof ReferencePersistenceError))
          throw new Error("Expected persistence failure");
        expect(error).toMatchObject({
          phase: "completion",
          providerOutcome: "completed",
          effect: "applied",
        });
        expect(error.result).toMatchObject({
          capture: capture.capture,
          retainedResources: capture.retainedResources,
        });
        expect(error.reference).toEqual(saved!);
        expect(error.outcome?.retainedResources).toContainEqual(primary);
        expect(operation.outcome.nextAction).toBe("none");
        await expect(operation.continue()).rejects.toMatchObject({ code: "CONFLICT" });
        const freshWhileOffline = await Sandbar.connect(bindAdapter(adapter, {}, {}));

        try {
          await expect(
            (await freshWhileOffline.recover(error.reference)).continue(),
          ).rejects.toMatchObject({ code: "CONFLICT" });
        } finally {
          await freshWhileOffline.close();
        }

        saveFails = false;
      }

      const result = await operation.wait();
      expect(result.snapshot.reference).toEqual(primary);
      expect(result.retainedResources).toEqual(capture.retainedResources);
      expect(operation.outcome.completed).toContainEqual({
        step: "capture",
        capture: capture.capture,
      });
      expect(operation.outcome.continuation.status).toBe("unavailable");
      expect(RecoveryFacts.safeParse(saved?.facts).success).toBe(true);
      expect(operation.reference.facts?.retainedResources.length).toBeLessThanOrEqual(32);

      expect(operation.outcome.retainedResources).toContainEqual(primary);

      for (const retained of [...prior.retainedResources, ...capture.retainedResources])
        expect(operation.outcome.retainedResources).toContainEqual(
          boundary === "enriched resource identity" ? primary : retained,
        );

      if (boundary === "enriched resource identity") {
        expect(operation.outcome.retainedResources).toEqual([primary]);
        expect(operation.reference.completion?.resources).toEqual([
          {
            kind: "snapshot",
            nativeId: "snapshot",
            ownership: "verified-created",
            history: primary.history,
            receipt: primary.receipt,
            generation: undefined,
          },
        ]);
      }

      expect(operation.reference.facts).toEqual({
        ...prior,
        continuation: {
          supported: false,
          status: "unavailable",
          reason: "Explicit continuation is unsupported",
        },
      });
      expect(operation.outcome.completed).toEqual([
        ...prior.completed,
        { step: "capture", capture: capture.capture },
      ]);
      expect(
        operation.reference.completion?.resources.every(
          (resource) => !("provider" in resource) && !("scope" in resource),
        ),
      ).toBe(true);

      observing = true;
      let failPendingSave = boundary === "pending after confirmed evidence";

      const fresh = await Sandbar.connect(bindAdapter(adapter, {}, {}), {
        onReference() {
          if (failPendingSave) {
            failPendingSave = false;
            throw new Error("Store offline during pending observation");
          }
        },
      });

      try {
        const recovered = await fresh.recover(saved!);

        if (recovered.kind !== "snapshot_capture") throw new Error("Expected capture");

        if (boundary === "pending after confirmed evidence") {
          expect(recovered.reference.completion?.resources).toEqual([]);
          const error = await recovered.observe().catch((error: Error) => error);
          expect(error).toBeInstanceOf(ReferencePersistenceError);
          expect(error).toMatchObject({
            phase: "observation",
            providerOutcome: "completed",
            effect: "applied",
          });
          expect(recovered.outcome.retainedResources).toEqual([primary]);
          expect(recovered.reference.facts).toEqual(operation.reference.facts);
        }

        const observed = await recovered.wait();
        expect(observed.snapshot.reference).toEqual(
          boundary === "enriched resource identity" ? retainedResources[0] : primary,
        );
        expect(recovered.outcome.retainedResources).toContainEqual(primary);
        expect(recovered.reference.completion).toEqual(
          JSON.parse(JSON.stringify(operation.reference.completion)),
        );
        expect(observed.retainedResources).toEqual(capture.retainedResources);
        expect(recovered.outcome.completed).toContainEqual({
          step: "capture",
          capture: capture.capture,
        });
        expect(submissions).toBe(1);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  });
}
