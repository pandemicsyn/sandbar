import { z } from "zod";
import { Sandbar } from "sandbar-sdk";
import { vercel } from "sandbar-vercel";
import { defineProviderProfile } from "./profile";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const routingSchema = z.strictObject({
  teamId: identifier,
  projectId: identifier,
  region: z.literal("iad1"),
  imageId: z.literal("vercel/sandbox/node:24"),
  networkPolicy: z.enum(["vercel-deny-all", "vercel-allow-all"]),
  nativeLifetimeSeconds: z.literal(300),
});

/** Effect-free external profile; loading it neither authenticates nor allocates. */
export default defineProviderProfile({
  id: "vercel",
  nativeVersion: "REST v3 create v2 sessions",
  credentialVariables: ["VERCEL_TOKEN"],
  bounds: { nativeLifetimeSeconds: 300, exerciseMs: 120000, cleanupMs: 60000 },
  support: {
    id: "vercel",
    name: "Vercel Sandbox",
    features: {
      lifecycle: {
        support: "conditional",
        note: "Immutable nonpersistent session IDs, managed Node 24 in iad1, verified team/project and a five-minute native lifetime. Destroy confirms original-session stop and reports retained named-sandbox metadata; metadata deletion is unsupported. No live qualification.",
      },
      execution: {
        support: "supported",
        note: "Argv and /bin/sh scripts, cwd/env, nonzero exit and binary stdout/stderr through a managed Node capture helper; combined output capped at 1 MiB. No stdin, interactive processes or PTYs. Uncertain commands are never replayed. No live qualification.",
      },
      files: {
        support: "conditional",
        note: "Absolute-path binary reads and gzip/tar writes with overwrite:true, capped at 1 MiB per file. Atomic no-clobber is unsupported and rejects before effects. No live qualification.",
      },
      oci: {
        support: "unsupported",
        note: "Only vercel/sandbox/node:24 is accepted; OCI builds and arbitrary prepared images are unsupported.",
      },
      network: {
        support: "conditional",
        note: "Named vercel-deny-all and vercel-allow-all policies map to native deny-all/allow-all; the configured policy must be repeated at creation. No measured isolation evidence. The existing E2B-only paired network suite cannot qualify this profile.",
      },
      snapshots: {
        support: "unsupported",
        note: "No snapshot capture, memory inclusion, source lifecycle transition or restored execution is exposed; snapshot requirements reject before effects.",
      },
      volumes: {
        support: "unsupported",
        note: "No volume CRUD or retained storage cleanup API is exposed.",
      },
      persistence: {
        support: "unsupported",
        note: "No persistent sandboxes, mounts, subpaths or read-only storage are exposed.",
      },
    },
  },
  configure: (environment, saved) =>
    routingSchema.parse(
      saved ?? {
        teamId: environment.SANDBAR_VERCEL_TEAM_ID,
        projectId: environment.SANDBAR_VERCEL_PROJECT_ID,
        region: "iad1",
        imageId: "vercel/sandbox/node:24",
        networkPolicy: environment.SANDBAR_VERCEL_NETWORK_POLICY ?? "vercel-deny-all",
        nativeLifetimeSeconds: 300,
      },
    ),
  configuration: (routing) => {
    const config = routingSchema.parse(routing);

    return {
      imageClass: "prepared",
      fileRoot: "/tmp",
      authorityClass: "verified-team",
      network: config.networkPolicy,
      regionClass: config.region,
    };
  },
  connection: (routing, credentials) => {
    const config = routingSchema.parse(routing);

    return (onReference, onDiagnostic) =>
      Sandbar.connect({
        adapter: vercel,
        config: {
          teamId: config.teamId,
          projectId: config.projectId,
          region: config.region,
          timeoutSeconds: config.nativeLifetimeSeconds,
          networkPolicy: config.networkPolicy,
        },
        credentials: { token: credentials.VERCEL_TOKEN },
        onReference,
        onDiagnostic,
      });
  },
});
