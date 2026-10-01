import { z } from "zod";
import {
  defineAdapter,
  sandboxReference,
  assertSandboxReference,
  unknownSandboxFacts,
} from "sandbar-adapter";
import { Sandbar } from "sandbar-sdk";
import { defineProviderProfile } from "../profile";
import { features, supportMetadataSchema } from "../support";

const scope = { authority: { kind: "fixture", id: "external" }, partition: {} };

const savedSandbox = sandboxReference("external.fixture", scope, "fixture", {
  operation: "fixture-operation",
  submission: "fixture-submission",
});

// Independently authored definition: public imports only; no provider implementation or live IO.
const adapter = defineAdapter({
  name: "external.fixture",
  config: z.strictObject({}),
  credentials: z.strictObject({ token: z.literal("offline") }),
  async connect() {
    return {
      scope,
      supports: {
        images: ["prepared"],
        network: ["blocked"],
        exec: { commands: ["argv"], maxOutputBytes: 1_048_576 },
      },
      async create() {
        return { id: "fixture", state: "running" };
      },
      async destroy() {
        return { computeStopped: true, retainedResources: [] };
      },
      async inspect() {
        return {
          ...unknownSandboxFacts(),
          reference: savedSandbox,
          id: "fixture",
          state: "running",
          nativeState: "fixture-running",
        };
      },
      async reopen(reference) {
        assertSandboxReference(savedSandbox, reference);

        return {
          ...unknownSandboxFacts(),
          reference: savedSandbox,
          state: "running",
          nativeState: "fixture-running",
          observedAt: new Date().toISOString(),
        };
      },
      files: {
        maxBytes: 100,
        async read() {
          return new Uint8Array([0, 255, 31, 128]);
        },
      },
      exec: async () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode("sandbox-reopen"),
        stderr: new Uint8Array(),
        truncated: false,
      }),
      async snapshotInspect(reference) {
        return {
          reference,
          preserve: "filesystem",
          consistency: "unknown",
          restoreExecution: "fresh",
          source: null,
          state: "ready",
          createdAt: null,
          expiration: "unknown",
          excludedPaths: [],
          mounts: [],
          mountHandling: "none",
          restore: {
            networkPolicies: ["blocked"],
            resources: false,
            mounts: false,
            independentLifecycle: true,
          },
          dependencies: [],
          nativeDependencies: null,
        };
      },
    };
  },
});

export default defineProviderProfile({
  id: "external.fixture",
  nativeVersion: "fixture 1",
  credentialVariables: ["SANDBAR_EXTERNAL_FIXTURE_TOKEN"],
  bounds: { nativeLifetimeSeconds: 300, exerciseMs: 5000, cleanupMs: 1000 },
  support: {
    id: "external.fixture",
    name: "External fixture",
    features: supportMetadataSchema.shape.features.parse(
      Object.fromEntries(
        Object.keys(features).map((id) => [
          id,
          { support: "unsupported", note: "Offline fixture only; no live guarantees." },
        ]),
      ),
    ),
  },
  configure: (_environment, saved) =>
    saved ?? { imageId: "fixture", networkPolicy: "blocked", nativeLifetimeSeconds: 300 },
  configuration: () => ({
    imageClass: "prepared",
    network: "blocked-requested",
    regionClass: "fixture",
  }),
  connection: (_routing, credentials) => (onReference, onDiagnostic) =>
    Sandbar.connect({
      adapter,
      config: {},
      credentials: { token: credentials.SANDBAR_EXTERNAL_FIXTURE_TOKEN },
      onReference,
      onDiagnostic,
    }),
});
