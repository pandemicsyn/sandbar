import { Sandbar } from "sandbar-sdk";
import { boxdAdapter } from "sandbar-boxd";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { features, supportMetadataSchema } from "./support";

const Routing = z.object({
  org: z.string().min(1),
  imageId: z.string().min(1),
  networkPolicy: z.literal("internet"),
  nativeLifetimeSeconds: z.literal(900),
});

const implemented = new Set([
  "lifecycle",
  "execution",
  "files",
  "suspension",
  "renewal",
  "reopening",
  "volumes",
  "persistence",
]);

const notes: Partial<Record<keyof typeof features, string>> = {
  files:
    "Bounded binary read and overwrite upload; native byte-count acknowledgement required. Atomic no-clobber is unsupported and the shared suite must assert rejection with unchanged data. No large-file/staged stream transfer guarantee.",
  suspension:
    "Native pause/wake retain filesystem, RAM, processes and sockets. Inspect/reopen use metadata only. Native inbound traffic may wake compute. No live qualification yet.",
  volumes:
    "Independent block disks with configured size (10 GiB by default); create/inspect/list/explicit delete. Lost create acknowledgement without a UUID remains unresolved and requires manual native inventory investigation; never replay or adopt by name. No native disk expiry. No live qualification yet.",
  persistence:
    "Whole-disk create-time read-only/read-write mounts, one machine per disk even read-only. Unknown durability requires explicit allow-unconfirmed cleanup. Native host placement restrictions may reject multi-disk creates. No live qualification yet.",
  snapshots:
    "Native capture is memory + disk, versioned latest-only. Exact immutable generation targeting for restore/delete is not established; the complete Sandbar snapshot workflow is unsupported. No capture-only allocation.",
  streaming:
    "Native execution stream cancellation kills the process group; it cannot satisfy Sandbar detach/disconnect. Sustained process/terminal IO unsupported.",
  network:
    "Only internet policy is supported, selected explicitly at setup. Peer/metadata isolation is enabled; this does not block internet egress. Strict blocked and paired network qualification unsupported.",
  oci: "OCI images boot directly; no Sandbar image-build hook or retained image artifact.",
  directories:
    "Native complete bounded readDirectory and nonrecursive mkdir / explicitly recursive remove only. Stat, existence, safe copy/move and staged streaming transfers unsupported; the full directory workflow is not qualified.",
};

// SAFETY: These keys are taken from the fixed features literal.
const featureIds = Object.keys(features) as (keyof typeof features)[];

export default defineProviderProfile({
  id: "boxd",
  nativeVersion: "boxd SDK 0.2.15",
  configuredEnvironment: true,
  fileNoClobber: false,
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
          image: config.imageId,
          networkPolicy: config.networkPolicy,
          lifetimeSeconds: config.nativeLifetimeSeconds,
        },
        cleanup: { storage: "allow-unconfirmed" },
        onReference,
        onDiagnostic,
      });
  },
});
