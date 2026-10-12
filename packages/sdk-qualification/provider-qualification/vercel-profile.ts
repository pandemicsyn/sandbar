import { z } from "zod";
import { Sandbar } from "sandbar-sdk";
import { vercel } from "@sandbar-sdk/vercel";
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
  imageId: z.literal("vercel/sandbox/universal:latest"),
  networkPolicy: z.enum(["vercel-deny-all", "vercel-allow-all"]),
  nativeLifetimeSeconds: z.literal(300),
});

/** Effect-free external profile; loading it neither authenticates nor allocates. */
export default defineProviderProfile({
  id: "vercel",
  nativeVersion: "REST v3 create v2 sessions audited SDK 3.6.1",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["VERCEL_TOKEN"],
  bounds: { nativeLifetimeSeconds: 300, exerciseMs: 120000, cleanupMs: 60000 },
  support: {
    id: "vercel",
    name: "Vercel Sandbox",
    features: {
      suspension: {
        support: "conditional",
        note: "Opt-in persistent mode supports filesystem suspension, terminated processes and explicit fresh execution resume under one logical creation-checked reference. The committed live profile remains disposable; persistent live qualification needs a separately approved storage budget/profile. No live qualification.",
      },
      previewProtected: {
        support: "unsupported",
        note: "No protected preview routes or access credentials are exposed; sessions have no configured ports.",
      },
      previewPublic: {
        support: "conditional",
        note: "Explicit config.ports exposes public HTTPS services. Default ports remain empty; lookup is read-only and validates original running session. Profile exposes no ports by default; a separately approved preview profile is needed. No live qualification.",
      },
      termination: {
        support: "supported",
        note: "Universal-image supervisor targets its retained child with SIGTERM/SIGKILL; acknowledgement and independent confirmed exit are separate. No automatic escalation or compute stop fallback; no live qualification.",
      },
      renewal: {
        support: "supported",
        note: "Single additive original-session timeout extension, 1–300 seconds per requested window; account cumulative-runtime limits apply. ACK and native expiry observations remain separate; lost responses are never replayed. No live qualification.",
      },
      reopening: {
        support: "conditional",
        note: "Disposable references bind the original session; opt-in persistent references bind generated name plus native creation timestamp/tag and inspect the current execution with resume=false. Both verify team/project/region with current credentials. Reopening does not allocate, resume or renew. No live qualification.",
      },
      streaming: {
        support: "supported",
        note: "Universal image supplies Python3 for the adapter-owned bounded Unix-socket supervisor; sustained text/byte output, incremental stdin/EOF, status, PTYs and leased process reopening. Local detach never certifies exit. No live qualification.",
      },
      finiteStdin: {
        support: "supported",
        note: "Adapter-owned bounded binary staging sends up to 1 MiB followed by EOF; no upstream-only native stdin dependency. Interrupted stages remain until compute teardown. No live qualification.",
      },
      directories: {
        support: "supported",
        note: "Bounded complete list/readDirectory, lstat/stat, dangling-link existence, mkdir/remove, staged no-clobber files/copy and same-filesystem moves. No-clobber moves require Python3/Linux renameat2 (universal image). Incremental streams stage 64 KiB chunks. No live qualification.",
      },
      storageComposition: {
        support: "unsupported",
        note: "Filesystem snapshots restore independently, but drives/mounts lack generation-safe mutation selectors; mounted snapshot composition is unsupported.",
      },
      lifecycle: {
        support: "conditional",
        note: "Committed live profile uses disposable immutable sessions, universal image in iad1 and five-minute timeout; destroy confirms original-session stop and retains named metadata. Opt-in persistent mode instead retains a logical reference across filesystem suspension/fresh resume; destroy deletes creation-checked named metadata and reports independently retained snapshot IDs. No live qualification.",
      },
      execution: {
        support: "supported",
        note: "Literal argv/shell, cwd/env, finite byte stdin, bounded original stdout/stderr, confirmed exit retained separately from output retrieval. Universal-image bounded supervisor adds sustained binary/text processes, stdin, EOF, signals, PTYs and leased reopening. Single-attempt mutation transport; no live qualification.",
      },
      files: {
        support: "supported",
        note: "Binary bounded read/write with staged race-safe no-clobber publish, metadata/directories/copy/move and incremental streams. Node managed image prerequisites; Python3/Linux renameat2 for no-clobber moves. Partial transfers retain known stages; no live qualification.",
      },
      oci: {
        support: "unsupported",
        note: "Managed Node 22/24/26 and universal images are accepted; OCI builds and arbitrary prepared images are unsupported.",
      },
      network: {
        support: "conditional",
        note: "Named vercel-deny-all and vercel-allow-all policies map to native deny-all/allow-all; omitted create environment/policy use adapter defaults, and explicit values must match the configured policy. No measured isolation evidence. The existing E2B-only paired network suite cannot qualify this profile.",
      },
      snapshots: {
        support: "supported",
        note: "Filesystem-only native capture terminates the original disposable session, drops connections and restores fresh independent compute. No RAM capture, restart or replacement of the source. Exact artifact-ID inspect/list/delete; region and project verified. Retention consistency unknown; no minimum-retention guarantee. No live qualification.",
      },
      volumes: {
        support: "unsupported",
        note: "Published drive creation is name-based get-or-create; deletion and mount selection have no established immutable generation predicate. No safe exact-identity mutation mapping is established.",
      },
      persistence: {
        support: "unsupported",
        note: "Mounted drive persistence is unsupported. Opt-in persistent sandbox filesystem suspension/fresh resume is declared separately under suspension; it does not provide volume or mount APIs.",
      },
    },
  },
  configure: (environment, saved) =>
    routingSchema.parse(
      saved ?? {
        teamId: environment.SANDBAR_VERCEL_TEAM_ID,
        projectId: environment.SANDBAR_VERCEL_PROJECT_ID,
        region: "iad1",
        imageId: "vercel/sandbox/universal:latest",
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
          image: config.imageId,
          timeoutSeconds: config.nativeLifetimeSeconds,
          networkPolicy: config.networkPolicy,
        },
        credentials: { token: credentials.VERCEL_TOKEN },
        onReference,
        onDiagnostic,
      });
  },
});
