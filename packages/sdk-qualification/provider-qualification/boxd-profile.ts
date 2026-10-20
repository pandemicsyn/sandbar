import { Sandbar } from "sandbar-sdk";
import { boxdAdapter } from "@sandbar-sdk/boxd";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { features, supportMetadataSchema } from "./support";

const Routing = z.object({
  org: z.string().min(1),
  imageId: z.string().min(1),
  networkPolicy: z.literal("internet"),
  nativeLifetimeSeconds: z.literal(900),
  previewAccess: z.enum(["protected", "public"]).default("protected"),
});

const implemented = new Set([
  "lifecycle",
  "execution",
  "finiteStdin",
  "directories",
  "previewPublic",
  "files",
  "suspension",
  "renewal",
  "reopening",
  "volumes",
  "persistence",
  "snapshots",
]);

const notes: Partial<Record<keyof typeof features, string>> = {
  lifecycle:
    "Sandbox lifecycle passed at fcb59d4 on Bun 1.3.14/darwin-arm64, provider-default OCI image, internet policy and 900-second expiry; one owned sandbox destroyed and client closed. Other configurations remain unqualified.",
  execution:
    "Buffered argv/shell and captured nonzero exit passed in the fcb59d4 baseline with confirmed cleanup. Output bounds and other command variants retain deterministic coverage; sustained process IO is unsupported.",
  reopening:
    "Scoped reopening passed in the fcb59d4 baseline with confirmed cleanup. Other configurations remain unqualified.",
  renewal:
    "Native wall-clock expiry reset is implemented with acknowledgement-preserving observations. No live qualification yet.",
  files:
    "Bounded native binary reads/overwrite upload and Python 3 atomic exclusive-create writes. The fcb59d4 baseline passed binary files/overwrite plus then-unsupported no-clobber rejection; it does not qualify the expanded no-clobber/stream behavior. New helpers have offline coverage only.",
  finiteStdin:
    "Native byte frames (at most 64 KiB each), up to 1 MiB input followed by native half-close/EOF. Empty and omitted input close stdin. No seekability or PTY promise. Deterministic protobuf-boundary coverage; live not-run.",
  previewPublic:
    "Explicit preview.access public config creates pinned ports (profile 3000/3001) and disables browser protection after expiry installation. Lookup reads running machine identity and existing pinned routes; never resumes or creates routes. Default protected lookup unsupported. Native inbound access may wake compute later. Offline coverage; live not-run.",
  suspension:
    "Native pause/wake retain filesystem, RAM, processes and sockets. Inspect/reopen use metadata only. Native inbound traffic may wake compute. No live qualification yet.",
  volumes:
    "Independent block disks with configured size (10 GiB by default); create/inspect/list/explicit delete. Lost create acknowledgement without a UUID remains unresolved and requires manual native inventory investigation; never replay or adopt by name. No native disk expiry. No live qualification yet.",
  persistence:
    "Whole-disk create-time read-only/read-write mounts, one machine per disk even read-only. Unknown durability requires explicit allow-unconfirmed cleanup. Native host placement restrictions may reject multi-disk creates. No live qualification yet.",
  snapshots:
    "Native memory + disk capture of a running machine without mounted disks, with a brief pause; the source keeps running. Each capture uses an attempt-derived unique name and the reference pins the captured version, checked before inspect/restore/delete; a restore that boots another version is unknown with the machine identity. Restores resume captured processes in a new machine at the captured size, with no mounts or resizing. Provider-scope list; no scheduled deletion. No live qualification.",
  streaming:
    "Native execution stream cancellation kills the process group; it cannot satisfy Sandbar detach/disconnect. Sustained process/terminal IO unsupported.",
  network:
    "Only internet policy is supported, selected explicitly at setup. Peer/metadata isolation is enabled; this does not block internet egress. Strict blocked and paired network qualification unsupported.",
  oci: "OCI images boot directly; no Sandbar image-build hook or retained image artifact.",
  directories:
    "Native complete bounded readDirectory, plus Python 3 complete list, lstat/stat/exists, recursive-opt-in mkdir/remove, copy and staged 64 KiB streams. Private Linux filesystem with hardlinks; no-clobber move requires renameat2 and cross-filesystem move rejects without copy/delete. Failed transfers retain correlated staging paths; no replay. Walk/text lines compose these hooks. Local Python workflow and protobuf transport coverage are separate; expanded file-directories live not-run.",
};

// SAFETY: These keys are taken from the fixed features literal.
const featureIds = Object.keys(features) as (keyof typeof features)[];

export default defineProviderProfile({
  id: "boxd",
  nativeVersion: "boxd SDK 0.2.15",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["SANDBAR_BOXD_API_KEY"],
  bounds: { nativeLifetimeSeconds: 900, exerciseMs: 240000, cleanupMs: 60000 },
  support: {
    id: "boxd",
    name: "boxd",
    features: supportMetadataSchema.shape.features.parse(
      Object.fromEntries(
        featureIds.map((id) => [
          id,
          {
            support: implemented.has(id) ? "conditional" : "unsupported",
            note:
              notes[id] ??
              (implemented.has(id)
                ? "Implemented with deterministic native-boundary tests; no live qualification yet."
                : "Not implemented by this adapter."),
          },
        ]),
      ),
    ),
  },
  configure(environment, saved) {
    return Routing.parse(
      saved ?? {
        org: environment.SANDBAR_BOXD_ORG,
        imageId: environment.SANDBAR_BOXD_IMAGE ?? "ubuntu:24.04",
        networkPolicy: "internet",
        nativeLifetimeSeconds: 900,
        previewAccess: environment.SANDBAR_BOXD_PREVIEW_ACCESS ?? "protected",
      },
    );
  },
  configuration() {
    return {
      imageClass: "oci",
      fileRoot: "/tmp",
      authorityClass: "verified-organization",
      network: "internet-requested",
      regionClass: "hosted-default",
    };
  },
  connection(routing, credentials) {
    const config = Routing.parse(routing);

    return (onReference, onDiagnostic) =>
      Sandbar.connect({
        adapter: boxdAdapter,
        credentials: { apiKey: credentials.SANDBAR_BOXD_API_KEY },
        config: {
          org: config.org,
          size: 1,
          volumes: { sizeBytes: 1024 ** 3 },
          image: config.imageId,
          networkPolicy: config.networkPolicy,
          lifetimeSeconds: config.nativeLifetimeSeconds,
          preview: { access: config.previewAccess, ports: [3000, 3001] },
        },
        cleanup: { storage: "allow-unconfirmed" },
        onReference,
        onDiagnostic,
      });
  },
});
