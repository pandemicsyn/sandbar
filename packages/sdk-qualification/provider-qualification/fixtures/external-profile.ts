import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar } from "sandbar-sdk";
import { defineProviderProfile } from "../profile";
import { features, supportMetadataSchema } from "../support";

const scope = { authority: { kind: "fixture", id: "external" }, partition: {} };

// Independently authored definition: public imports only; no provider implementation or live IO.
const adapter = defineAdapter({
  name: "external.fixture",
  config: z.strictObject({}),
  credentials: z.strictObject({ token: z.literal("offline") }),
  async connect() {
    let alive = false;

    return {
      scope,
      supports: { images: ["prepared"], network: ["blocked"] },
      async create() {
        alive = true;

        return { id: "fixture", state: "running" };
      },
      async destroy() {
        alive = false;

        return { computeStopped: true, retainedResources: [] };
      },
      async inspect() {
        return alive ? { id: "fixture", state: "running" } : null;
      },
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
