import { z } from "zod";
import {
  markdownTable,
  parseReport,
  type QualificationReport,
  type QualificationRecord,
  type Scenario,
} from "./report";

export const features = {
  lifecycle: {
    label: "Sandbox lifecycle",
    workflow: "sandbox-lifecycle",
    scenarios: [
      "connect",
      "create-prepared",
      "inspect",
      "inventory",
      "destroy",
      "confirm-cleanup",
      "close",
    ],
  },
  suspension: { label: "Native sandbox suspend/resume", scenarios: ["lifecycle-suspend-resume"] },
  previewProtected: { label: "Protected HTTP preview", scenarios: ["preview-protected"] },
  previewPublic: { label: "Public HTTP preview", scenarios: ["preview-public"] },
  termination: { label: "Local-handle process termination", scenarios: ["execution-termination"] },
  renewal: { label: "Configured lifetime renewal", scenarios: ["lifecycle-renew"] },
  reopening: { label: "Scoped sandbox reopening", scenarios: ["lifecycle-reopen"] },
  execution: {
    label: "Execution and captured output",
    workflow: "execution",
    scenarios: ["exec-argv", "exec-shell", "exec-nonzero"],
  },
  streaming: { label: "Process streams and terminals", scenarios: ["execution-streaming"] },
  finiteStdin: { label: "Finite execution input", scenarios: ["execution-stdin"] },
  files: {
    label: "Binary files and overwrite",
    workflow: "files",
    scenarios: ["file-binary", "file-overwrite", "file-no-clobber"],
  },
  directories: { label: "Directory primitives", scenarios: ["file-directories"] },
  oci: { label: "OCI image builds", scenarios: ["build-oci"] },
  network: {
    label: "Measured network controls",
    workflow: "network-controls",
    scenarios: ["network-internet", "network-blocked"],
  },
  storageComposition: {
    label: "Cold snapshot with selected storage",
    scenarios: ["storage-composition"],
  },
  snapshots: { label: "Snapshot roundtrip", scenarios: ["snapshot-roundtrip"] },
  volumes: { label: "Volume CRUD", scenarios: ["volume-crud"] },
  persistence: { label: "Mounted persistence", scenarios: ["volume-persistence"] },
} satisfies Record<string, { label: string; scenarios: Scenario[]; workflow?: Scenario }>;

// SAFETY: features is a fixed nonempty literal; its own keys form this enum.
const featureKeys = Object.keys(features) as [keyof typeof features, ...(keyof typeof features)[]];

export const supportMetadataSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
  name: z.string().min(1).max(80),
  features: z.record(
    z.enum(featureKeys),
    z.strictObject({
      support: z.enum(["supported", "unsupported", "conditional"]),
      note: z.string().min(1).max(1200),
    }),
  ),
});

export type SupportMetadata = z.infer<typeof supportMetadataSchema>;

export const officialSupport: SupportMetadata[] = [
  {
    id: "daytona",
    name: "Daytona",
    features: {
      storageComposition: {
        support: "conditional",
        note: "Implemented exact-volume-ID mounts on known mount-free filesystem/fresh restore with explicit daytona-default. Blocked mounted restore, mounted capture and memory composition unsupported. Native fixtures/packed compatibility are separate from first-action acceptance. The bounded case at 824946d passed A startup evidence, then failed a harness snapshot-name/ID assertion before B; native selector resolution was corrected. The full workflow passed at 5911ccc on Bun 1.3.14, us, daytona-default with the pinned first-action image: selected A data, empty B, captured private state, exact native identities and fresh-client reopening. All owned compute, volumes, capture and temporary import were cleaned up.",
      },
      suspension: {
        support: "conditional",
        note: "Known unmounted Daytona containers retain files and end processes with auto-delete disabled; start from stopped/archived preserves UUID and reports fresh execution. Hard TTL keeps ticking. Bun lifecycle-suspend-resume passed at 6796b30 with confirmed owned cleanup.",
      },
      termination: {
        support: "conditional",
        note: "Process-scoped Python 3 supervisor retains child identity and requests SIGTERM/SIGKILL for the retained child; no descendant cleanup or sandbox-destruction fallback. Independent wait/status preserve confirmed exit. The maintained execution-termination workflow passed at ecc73de on borrowed Linux/us/daytona-default with confirmed owned destruction and client close; this does not qualify descendant cleanup or other images.",
      },
      previewProtected: {
        support: "conditional",
        note: "Daytona protected header access only; standard token grants sandbox-wide command/file authority. Public setup unsupported. Native lookup can activate a route; no server start/resume or readiness claim. Bun preview-protected passed at 3188e33 in us with authenticated HTTP and denied missing/invalid headers; owned cleanup confirmed.",
      },
      previewPublic: {
        support: "unsupported",
        note: "Daytona's native public setting would publish every port on the sandbox, so the adapter supports protected previews only.",
      },
      directories: {
        support: "conditional",
        note: "Complete listFiles/readDirectory, statFile, existence and recursive-opt-in mkdir/remove use a bounded Python3 helper on private Linux filesystems. Dangling links remain entries; nonrecursive remove uses rmdir/unlink. Copy and move use native race-safe publication; no-clobber rename needs Linux renameat2. Mounted destinations are unsupported for staged transfer mutations. Expanded file-directories passed at 2f6afe8 on borrowed Linux container/us/daytona-default: complete browsing/metadata, recursive-opt-in mutation, copy/move and the shared compiled artifact recipe with a 32 MiB hash-checked stream roundtrip. Sandbox destruction/client close confirmed. Earlier mkdir rejection failures at cd89f31 and 6d7ddc7 remain recorded with confirmed cleanup. F4 walkFiles/readTextLines compose these hooks and have fixture/packed coverage; the 2f6afe8 pass predates them and does not qualify F4. F4 traversal and UTF-8/CRLF text lines passed through the shared recipe at e91f2d5 with confirmed sandbox destruction/client close. Other images/mounts are unqualified.",
      },
      renewal: {
        support: "conditional",
        note: "Running scoped compute; configured lifetime defaults, bounded native reset, ACK-preserving metadata and read-only no-replay recovery. Bun lifecycle-renew passed at 3188e33 with deadline observation and confirmed owned cleanup; other configurations remain unqualified.",
      },
      reopening: {
        support: "conditional",
        note: "Scoped Sandbar-created compute only; fresh connection/process reopen, state/deadlines and running guest exec/files. Bun lifecycle-reopen passed at 3188e33 with fresh-process scoped attachment, guest exec/files and confirmed owned cleanup; other configurations remain unqualified.",
      },
      lifecycle: {
        support: "supported",
        note: "The immediate-inventory assertion failed at 1505ee0. A diagnostic reproduced native list-index lag. The Bun lifecycle test passed at 8449def in us with daytona-default after allowing a 30-second read-only convergence window; owned teardown and client close were confirmed. Other images/regions are unverified. The current suite omits the create environment to exercise adapter defaults; historical baseline passes do not qualify that newer path.",
      },
      streaming: {
        support: "conditional",
        note: "Finite and explicit sustained text streaming, exact-byte incremental stdin/EOF and status use a private Python 3 supervisor and Unix socket on writable /tmp. Queue 64 KiB/256 chunks, frames 16 KiB; no cumulative transcript. Pipe reads pause while full. Explicit PTYs combine bytes and support resize. Generation/lease-bound references reopen live output after disconnect (or 30s lease expiry), with an explicit gap and no replay. Disconnect preserves stdin; detach closes it. Helper removal follows child exit or owned sandbox destruction; abandonment markers remain until sandbox destruction. These P4 guarantees have deterministic coverage and separate live evidence. The maintained compiled >32 MiB build and incremental text/binary input/EOF workflow passed at ecc73de on borrowed Linux/us/daytona-default with confirmed sandbox destruction and client close; other images are unqualified.",
      },
      execution: {
        support: "supported",
        note: "Argv/shell, cwd/env, binary output and nonzero exit use the prepared baseline configuration.",
      },
      finiteStdin: {
        support: "conditional",
        note: "Finite exec accepts up to 1 MiB of UTF-8 text or exact bytes followed by EOF. The adapter reserves a private directory, uploads and verifies the payload, then redirects command input from that regular file; omitted input reads /dev/null. Requires writable unmounted /tmp and the existing capture utilities. Input is seekable; no pipe, PTY or incremental-write guarantee. Uncertain staging/dispatch is never replayed; temporary input may remain after interruption until owned sandbox cleanup. Deterministic native-boundary and local wrapper tests are separate from live acceptance. The maintained execution-stdin case has not run live; older captured-output passes do not qualify finite input.",
      },
      files: {
        support: "conditional",
        note: "Bun files passed at 3188e33 in /tmp with signal-bearing binary reads, overwrite/no-clobber and confirmed owned cleanup; required GNU shell utilities remain a prerequisite. Custom image filesystem behavior is unverified. UTF-8 readTextFile/writeTextFile wrap these byte operations; local encoding has deterministic/packed coverage and needs no separate live qualification.",
      },
      oci: {
        support: "conditional",
        note: "Implemented; retained image ownership/cleanup and a separately authorized build budget are prerequisites. images.get/list/delete map native snapshots; delete refuses general, captured-sandbox and warm-pool-dependent snapshots before one unreplayed DELETE, with deterministic native-boundary coverage only. No live build or image-deletion acceptance.",
      },
      network: {
        support: "conditional",
        note: "daytona-default permits essential services and is not strict blocked egress. Tier-dependent strict blocking has no maintained positive-control qualification profile.",
      },
      snapshots: {
        support: "conditional",
        note: "Eligible containers only: stop/cold filesystem capture/restart, fresh restored execution; no RAM. The Bun roundtrip passed at 1505ee0 in us with daytona-default, including two-way filesystem isolation, separate-process reference reopen, source deletion, second restore and confirmed owned cleanup.",
      },
      volumes: {
        support: "supported",
        note: "The Bun native create/readiness/inspect/delete test passed at 1505ee0 in us with daytona-default. CRUD is independent of mounts; owned deletion was confirmed.",
      },
      persistence: {
        support: "conditional",
        note: "Writable create-time mounts/subpaths; read-only unsupported. The Bun producer write/flush/readback, producer destruction, independent consumer remount/readback and owned deletion passed at 1505ee0 in us with daytona-default.",
      },
    },
  },
  {
    id: "e2b",
    name: "E2B",
    features: {
      storageComposition: {
        support: "unsupported",
        note: "The Sandbar adapter does not qualify filesystem/fresh restore with selected native volume IDs; memory composition and name-only mount selection remain unsupported.",
      },
      suspension: {
        support: "conditional",
        note: "E2B memory pause preserves private filesystem/RAM under the same ID; known native mounts are unsupported, missing mount metadata stays unknown, and external-storage durability/consistency is excluded; explicit resume uses configured initial session lifetime and reports execution unknown. Paused retention is indefinite and requires explicit owned cleanup. Live case failed before pause at cb39884 because native mount facts were unavailable; owned cleanup confirmed. Initial guest-routing failure at 6796b30 is retained; Revised private-state lifecycle case passed at 26f516d with confirmed owned cleanup, fresh-process inactive reopening, same files/identity and RAM nonce/counter continuity; prior failures remain recorded.",
      },
      previewPublic: {
        support: "conditional",
        note: "E2B public access, the default, with observed native visibility and auto-resume off. Protected setup disables public traffic on create and restore; fresh protected token lookup unsupported. Bun preview-public passed at 3188e33 with observed public visibility, HTTP content and confirmed owned cleanup. Protected-mode ingress denial remains unqualified.",
      },
      termination: {
        support: "conditional",
        note: "Active handles now use random scoped tag selectors for SIGTERM/SIGKILL; tags are not immutable native generations and other native clients can reuse them. Lost observation disables controls; no descendant cleanup guarantee. Historical PID-selected evidence follows. Calls share/cache acknowledgement or uncertainty without replay. Exit remains independently observed, including native -1. Bounded Bun live case passed at 131a8c6 with borrowed base on darwin-arm64/Bun 1.3.14 after the fixed-default routing correction: ready output, request acknowledgement/reuse, independently observed nonzero terminal result, owned cleanup and client close. The prior 4cc6a20 attachment failure remains recorded. Other images/platforms and signal delivery races are unqualified.",
      },
      previewProtected: {
        support: "unsupported",
        note: "Fresh traffic-token retrieval is absent from the pinned read-only detail API. Native connect may resume compute; protected preview rejects without calling it. Protected setup creates and restores private compute.",
      },
      directories: {
        support: "conditional",
        note: "Complete listFiles/readDirectory and statFile use a bounded Python3 helper; native lstat existence preserves dangling links. Recursive native primitives and race-safe helper nonrecursive mkdir/remove preserve opt-in. Parent links follow; recursive removal does not walk links. Copy/file stream publication uses same-directory staging and hardlinks; move no-clobber needs Linux renameat2. Stream upload requires envd >=0.5.7 to prevent native whole-file buffering. Original recursive-directory case passed at 3188e33 with owned cleanup; it does not qualify the expanded directory/32 MiB transfer/artifact workflow. Expanded file-directories passed at 2f6afe8 on borrowed base/Bun 1.3.14: complete browsing/metadata, recursive-opt-in mutations, copy/move and the shared compiled recipe with 32 MiB hash-checked byte streams. Owned sandbox destruction/client close confirmed. F4 walkFiles/readTextLines compose these hooks and have fixture/packed coverage; the 2f6afe8 pass predates them and does not qualify F4. F4 traversal and UTF-8/CRLF text lines passed through the shared recipe at e91f2d5 with confirmed sandbox destruction/client close. Other templates/guest versions remain unqualified.",
      },
      renewal: {
        support: "conditional",
        note: "Running scoped compute; configured lifetime defaults, bounded native reset, ACK-preserving metadata and read-only no-replay recovery. Bun lifecycle-renew passed at 3188e33 with deadline observation and confirmed owned cleanup; other configurations remain unqualified.",
      },
      reopening: {
        support: "conditional",
        note: "Scoped Sandbar-created compute only; fresh connection/process reopen, state/deadlines and running guest exec/files. Bun lifecycle-reopen passed at 3188e33 with fresh-process scoped attachment, guest exec/files and confirmed owned cleanup; other configurations remain unqualified.",
      },
      lifecycle: {
        support: "supported",
        note: "The ordinary Bun base baseline passed at 8449def with API-key authority in the default region, requested blocked internet and five-minute native lifetime; compute cleanup and client close were confirmed. The current suite omits the create environment to exercise the configured template default; historical baseline passes do not qualify that newer path or private inbound defaults.",
      },
      streaming: {
        support: "conditional",
        note: "Finite legacy streaming plus explicit sustained public envd RPC text streaming, exact-byte incremental stdin/EOF (envd >=0.5.2), status and bounded byte capture for exec callbacks. No cumulative transcript in sustained mode. PID presence proves running; absence without EndEvent is unknown. RPC loss may lose exit observation. Initial sustained streaming failed at 37dd9c2 on coalesced-frame queue overflow; termination passed and cleanup was confirmed. After bounded fair delivery, >32 MiB build and exact text/binary input/EOF plus status/termination passed at ecc73de on borrowed base with confirmed sandbox destruction and client close. Historical finite evidence remains separate. Original-byte streaming passed at 5f2bd13 with confirmed owned cleanup. Scoped live-only process reopening, explicit PTYs and resize have deterministic coverage; no transcript replay, native tag generation or exclusive attachment guarantee. P4 live qualification is recorded separately.",
      },
      execution: {
        support: "supported",
        note: "Argv/shell, cwd/env, binary output and nonzero exit use the prepared baseline configuration. Streaming is reported separately and is not qualified by this captured-output pass.",
      },
      finiteStdin: {
        support: "conditional",
        note: "Finite exec accepts up to 1 MiB of UTF-8 text or exact bytes followed by EOF. The adapter reserves a private directory, writes and verifies the payload, then redirects the existing foreground command from that regular file; omitted input reads /dev/null. Requires writable /tmp and existing Bash/file receipt utilities. Input is seekable; no pipe, PTY or incremental-write guarantee and no native stdin-close version requirement. Uncertain staging/dispatch is never replayed; temporary input may remain after interruption until owned sandbox cleanup. Deterministic native-boundary and local wrapper tests are separate from live acceptance. The maintained execution-stdin case has not run live; older captured-output passes do not qualify finite input.",
      },
      files: {
        support: "conditional",
        note: "Bun files passed at 3188e33 in /home/user with signal-bearing binary reads, overwrite/no-clobber and confirmed owned cleanup. An earlier sticky /tmp overwrite failed and dependent no-clobber was blocked; the home-workspace pass does not qualify arbitrary paths. UTF-8 readTextFile/writeTextFile wrap these byte operations; local encoding has deterministic/packed coverage and needs no separate live qualification.",
      },
      oci: {
        support: "conditional",
        note: "Implemented; retained templates require separate ownership/cleanup and budget approval. images.get/list/delete map templates; delete refuses public, multi-build, alias-shadowed, snapshot-backed and sandbox-dependent templates before one unreplayed DELETE, with deterministic native-boundary coverage only. No live build or image-deletion acceptance.",
      },
      network: {
        support: "supported",
        note: "Maps internet/blocked to native allowInternetAccess, forwarding false for blocked. The paired Bun probe failed at 431cdaa: both internet positive controls passed, but the blocked sandbox connected to 1.1.1.1:443 and hostname resolution failed. The prior 8449def probe had no recoverable blocked-command result; bounded DNS now exposes concrete outcomes. Both runs have confirmed compute cleanup. No passing outbound isolation claim.",
      },
      snapshots: {
        support: "conditional",
        note: "Compatible envd/templates only: filesystem + RAM, native pause/resume, pinned-build restore; mounts excluded. The Bun roundtrip passed at 8449def with borrowed base in the native default region, including RAM continuity, two-way filesystem isolation, separate-process reference reopening, source deletion, second restore and confirmed owned compute/snapshot cleanup.",
      },
      volumes: {
        support: "unsupported",
        note: "Volume workflows are not supported for E2B qualification; volume CRUD and persistence tests skip before provider setup. Experimental native CRUD is not eligible for live acceptance. The original uncertain volume creator remains preserved and unresolved; identified volume-only custody does not block separately bounded tests that allocate no volumes.",
      },
      persistence: {
        support: "unsupported",
        note: "Native mounts select reusable names without immutable volume-ID binding; the adapter rejects mounts before allocation. Volume artifact CRUD is a separate capability.",
      },
    },
  },
];

function validation(
  reports: readonly QualificationReport[],
  provider: string,
  ids: readonly Scenario[],
  workflow?: Scenario,
) {
  const candidates = reports
    .flatMap((report) => parseReport(report).records)
    .filter(
      (record) =>
        record.provider === provider &&
        record.mode === "live" &&
        (ids.includes(record.scenario) || record.scenario === workflow) &&
        record.status !== "unsupported" &&
        !(record.status === "not-run" && record.issue === "not-selected"),
    );

  const newest = [...candidates].sort(
    (a, b) =>
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      Number(a.status === "passed") - Number(b.status === "passed"),
  )[0];

  if (!newest) return "not-run";

  const configurationKey = (configuration: QualificationRecord["configuration"]) => {
    // Paired controls deliberately request different policies; all other configuration stays bound.
    const values = Object.entries(configuration).filter(
      ([field]) => !ids.every((id) => id.startsWith("network-")) || field !== "network",
    );

    return JSON.stringify(values.sort(([a], [b]) => a.localeCompare(b)));
  };

  const sameRun = candidates.filter(
    (item) =>
      item.sdkCommit === newest.sdkCommit &&
      item.harnessCommit === newest.harnessCommit &&
      item.runtime === newest.runtime &&
      item.platform === newest.platform &&
      item.nativeVersion === newest.nativeVersion &&
      configurationKey(item.configuration) === configurationKey(newest.configuration),
  );

  // A grouped case reports only its workflow outcome; legacy records retain their own operations.
  const selectedIds = newest.scenario === workflow ? [workflow] : ids;

  const selected = selectedIds.map(
    (id) =>
      sameRun
        .filter((item) => item.scenario === id)
        .sort(
          (a, b) =>
            Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
            Number(a.status === "passed") - Number(b.status === "passed"),
        )[0],
  );

  if (selected.some((record) => record?.status === "failed")) return "failed";

  if (
    selected.some(
      (record) =>
        record?.status === "blocked" ||
        (record?.status === "passed" && record.runCleanup !== "confirmed"),
    )
  )
    return "blocked";

  if (selected.some((record) => !record || record.status !== "passed")) return "not-run";

  return `passed at ${newest.sdkCommit.slice(0, 8)}`;
}

// SAFETY: Object.entries reads only the fixed feature keys and their declared scenario lists.
const featureEntries = Object.entries(features) as [
  keyof typeof features,
  { label: string; scenarios: readonly Scenario[]; workflow?: Scenario },
][];

const evidenceHref =
  "https://github.com/pandemicsyn/sandbar/blob/main/packages/sdk-qualification/provider-qualification/LIVE-EVIDENCE.md";

function featureMatrix(reports: readonly QualificationReport[], profiles: SupportMetadata[]) {
  const historical = reports.flatMap((report) => parseReport(report).historicalEvidence ?? []);

  const rows = featureEntries.map(([id, feature]) => {
    const cells = profiles.map((profile) => {
      const declared = profile.features[id];

      if (!declared) throw new Error(`Missing feature declaration: ${profile.id}/${id}`);
      const state = validation(reports, profile.id, feature.scenarios, feature.workflow);

      const history = historical.filter(
        (item) => item.provider === profile.id && feature.scenarios.includes(item.scenario),
      );

      const latest = history.at(-1);

      const result =
        state === "not-run" && latest
          ? `${latest.cleanup === "incomplete" ? "blocked" : latest.status} at ${latest.sourceRevision} (historical${latest.cleanup === "incomplete" ? "; cleanup incomplete" : ""})`
          : state;

      return `[${declared.support[0]!.toUpperCase() + declared.support.slice(1)} · ${result}](#${profile.id}-${id})`;
    });

    return [feature.label, ...cells];
  });

  return markdownTable(["Feature", ...profiles.map((profile) => profile.name)], rows);
}

const legend =
  "Adapter support and live validation are separate facts. **Supported** means implemented; **conditional** requires the configuration in the linked note; **unsupported** means the adapter does not expose the workflow. Live results are **passed**, **failed**, **blocked**, or **not-run**. Each pass applies to its recorded source/configuration, not the current head or every provider account. Fixture and packed tests never produce live passes.";

const e2bVolumeException =
  "**E2B experimental-volume exception:** the Volume CRUD row's unsupported label excludes experimental native CRUD from maintained live qualification; SDK hooks exist. A live create was blocked by HTTP 403 for the tested account; original volume custody remains unresolved, so maintained qualification skips volume cases before setup. This is separate from mounts, which the adapter rejects before allocation. See the [volume caveat](#e2b-volumes) and [mounted-persistence caveat](#e2b-persistence).";

function caveats(profiles: SupportMetadata[], heading: "##" | "###") {
  return profiles.flatMap((profile) => [
    `${heading} ${profile.name} caveats`,
    "",
    ...featureEntries.flatMap(([id, feature]) => [
      `<a id="${profile.id}-${id}"></a>`,
      "",
      `${heading}# ${feature.label}`,
      "",
      profile.features[id]!.note,
      "",
    ]),
  ]);
}

/** Standalone page for an external profile: declarations, live results and caveats. */
export function renderSupportMatrix(
  reports: readonly QualificationReport[],
  metadata: readonly SupportMetadata[] = officialSupport,
) {
  const profiles = metadata.map((profile) => supportMetadataSchema.parse(profile));

  return [
    "---",
    "title: Tested provider support",
    "description: Declared adapter support and dated live acceptance, with provider caveats.",
    "---",
    "",
    "<!-- Generated by provider-qualification/render.ts; do not edit by hand. -->",
    "",
    legend,
    "",
    ...(profiles.some((profile) => profile.id === "e2b") ? [e2bVolumeException, ""] : []),
    ...featureMatrix(reports, profiles),
    "",
    "The [live evidence detail](./live-qualification.md) contains only reviewed records supplied for this external profile. Missing records remain not-run; declarations do not establish live acceptance.",
    "",
    ...caveats(profiles, "##"),
    "## Updating support",
    "",
    "Reviewed summaries belong in one results JSON per provider. Generate with provider-qualification/render.ts --profile <profile> --results <results-directory> --output <output-directory>; use --check for drift. Live runs require separate authorization and durable owned cleanup.",
    "",
  ].join("\n");
}

/** Declarations and caveats appended to the official live evidence page. */
export function renderSupportDetails(
  reports: readonly QualificationReport[],
  metadata: readonly SupportMetadata[] = officialSupport,
) {
  const profiles = metadata.map((profile) => supportMetadataSchema.parse(profile));

  return [
    "## Declared support by feature",
    "",
    legend,
    "",
    ...(profiles.some((profile) => profile.id === "e2b") ? [e2bVolumeException, ""] : []),
    ...featureMatrix(reports, profiles),
    "",
    ...caveats(profiles, "###"),
    "## Updating support",
    "",
    "Reviewed summaries live in results/<provider>.json; new integration runs use standard Bun JUnit plus a small offline provenance/cleanup mapping. Capability declarations and caveats live in provider-qualification/support.ts, and provider status in its `providerStatus` list (external authors supply equivalent metadata). Generate both pages offline with `bun packages/sdk-qualification/provider-qualification/render.ts`; use `--check` for drift. Live runs require separate explicit resource authorization and durable owned cleanup.",
    "",
  ].join("\n");
}

export type ProviderStatus = {
  id: string;
  name: string;
  href?: string;
  experimental: boolean;
  /** Why the provider is experimental, or what its live tests cover. */
  note: string;
  /** Plain-language limits that change what an application can rely on. */
  limits?: string[];
};

/** Hand-maintained release status; live columns are computed from recorded results. */
export const providerStatus: ProviderStatus[] = [
  {
    id: "daytona",
    name: "Daytona",
    href: "/docs/providers/daytona/",
    experimental: false,
    note: "Live-tested across sandboxes, commands, files, previews, snapshots and volumes.",
    limits: [
      "Previews are protected only. The preview token also grants command and file access to the whole sandbox, so treat it as a credential.",
      "The `daytona-default` network setting still allows some essential services, so it is not strict outbound blocking.",
      "Snapshots capture the filesystem, not memory; running processes stop and restart.",
    ],
  },
  {
    id: "e2b",
    name: "E2B",
    href: "/docs/providers/e2b/",
    experimental: false,
    note: "Live-tested across sandboxes, commands, files, previews, pause/resume and snapshots.",
    limits: [
      'Do not rely on `network: "blocked"` for isolation. In our live test a blocked sandbox could still open direct IPv4 connections.',
      "Volumes and volume mounts are not supported.",
      "Previews are public only.",
      "File workflows were live-tested in `/home/user`; other paths and custom templates need their own checks.",
    ],
  },
  {
    id: "boxd",
    name: "boxd",
    href: "/docs/providers/boxd/",
    experimental: true,
    note: "Only the basics have run live: sandboxes, commands, files and reconnecting. Previews, pause/resume and volumes have not.",
  },
  {
    id: "vercel",
    name: "Vercel Sandbox",
    href: "/docs/providers/vercel/",
    experimental: true,
    note: "Not yet tested against the live Vercel service.",
  },
  {
    id: "boat",
    name: "Boat",
    href: "/docs/providers/boat/",
    experimental: true,
    note: "Not yet tested against the live Boat service.",
  },
  {
    id: "runloop",
    name: "Runloop",
    href: "/docs/providers/runloop/",
    experimental: true,
    note: "Not yet tested against the live Runloop service; sign-ups are invitation only.",
  },
  {
    id: "modal",
    name: "Modal",
    experimental: true,
    note: "Not yet tested against the live Modal service.",
  },
];

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const formatDate = (timestamp: number) => {
  const date = new Date(timestamp);

  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};

const overviewLabels: Record<keyof typeof features, string> = {
  lifecycle: "Create, inspect and destroy sandboxes",
  reopening: "Reconnect to a sandbox later",
  renewal: "Extend a sandbox's lifetime",
  suspension: "Pause and resume",
  execution: "Run commands and capture output",
  streaming: "Stream output and use terminals",
  finiteStdin: "Send input to a command",
  termination: "Stop a running command",
  files: "Read and write files",
  directories: "List, copy and move files",
  previewProtected: "Protected HTTP previews",
  previewPublic: "Public HTTP previews",
  oci: "Build images",
  network: "Block outbound network",
  snapshots: "Snapshot and restore",
  storageComposition: "Restore a snapshot with volumes",
  volumes: "Create and delete volumes",
  persistence: "Mount volumes",
};

/** The provider support overview: release status, what has run live, and known limits. */
export function renderSupportOverview(
  reports: readonly QualificationReport[],
  metadata: readonly SupportMetadata[] = officialSupport,
  statuses: readonly ProviderStatus[] = providerStatus,
) {
  const profiles = metadata.map((profile) => supportMetadataSchema.parse(profile));
  const records = reports.flatMap((report) => parseReport(report).records);

  const live = (status: ProviderStatus) => {
    const runs = records.filter(
      (record) => record.provider === status.id && record.mode === "live",
    );

    if (!runs.length) return "None yet";

    const passed = featureEntries.filter(([, feature]) =>
      validation(reports, status.id, feature.scenarios, feature.workflow).startsWith("passed"),
    ).length;

    const last = Math.max(...runs.map((record) => Date.parse(record.timestamp)));

    return `${passed} ${passed === 1 ? "feature" : "features"}, last run ${formatDate(last)}`;
  };

  const providerRows = statuses.map((status) => [
    status.href ? `[${status.name}](${status.href})` : status.name,
    status.experimental ? "Experimental" : "Supported",
    live(status),
    status.note,
  ]);

  const cell = (
    profile: SupportMetadata,
    id: keyof typeof features,
    feature: (typeof featureEntries)[number][1],
  ) => {
    const state = validation(reports, profile.id, feature.scenarios, feature.workflow);

    const text =
      profile.features[id]!.support === "unsupported"
        ? "Not supported"
        : state.startsWith("passed")
          ? "Tested live"
          : state === "failed"
            ? "**Failed live test**"
            : state === "blocked"
              ? "Live test blocked"
              : "Not tested live";

    return text;
  };

  const featureRows = featureEntries.map(([id, feature]) => [
    overviewLabels[id],
    ...profiles.map((profile) => cell(profile, id, feature)),
  ]);

  const experimental = statuses.filter((status) => status.experimental);
  const limited = statuses.filter((status) => status.limits?.length);

  return [
    "---",
    "title: Provider support",
    "description: Which providers are supported or experimental, and what has been tested against each real service.",
    "---",
    "",
    "<!-- Generated by provider-qualification/render.ts; do not edit by hand. -->",
    "",
    "Every adapter is tested on each change against a deterministic copy of its provider's API, including lost responses and recovery, and the SDK is tested as a packed npm package in Node.js and Bun. Supported providers are also **tested live**: we run the same SDK test suites against a real provider account and confirm that every sandbox, snapshot and volume the tests created was cleaned up.",
    "",
    "A live pass covers the image, region and network setting it ran with, not every account or image. Experimental providers work against their provider's documented API but have little or no live testing yet; expect rough edges and pin your version.",
    "",
    "## Providers",
    "",
    ...markdownTable(["Provider", "Status", "Passed live", "Notes"], providerRows),
    "",
    "## What has been tested live",
    "",
    `This table covers the supported providers. ${new Intl.ListFormat("en", { type: "conjunction" }).format(experimental.map((status) => status.name))} are experimental; see the notes above and each provider's guide.`,
    "",
    ...markdownTable(["Feature", ...profiles.map((profile) => profile.name)], featureRows),
    "",
    "## Known limits",
    "",
    ...limited.flatMap((status) => [
      `**${status.name}**`,
      "",
      ...status.limits!.map((limit) => `- ${limit}`),
      "",
    ]),
    "## Runtimes",
    "",
    "The SDK targets server-side Node.js and Bun. Packed package checks run the published JavaScript and strict TypeScript declarations on both. Live tests ran on Bun.",
    "",
    "## Evidence",
    "",
    `The [live test evidence](${evidenceHref}) in the repository lists every recorded run with its date, SDK commit, image, region and network setting, plus the detailed caveats behind each cell above.`,
    "",
  ].join("\n");
}
