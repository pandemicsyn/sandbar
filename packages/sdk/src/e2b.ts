import { createE2BAdapter as createPrivateE2BAdapter } from "@sandbar/provider-e2b";
import { z } from "zod";
import type { AdapterDefinition, AdapterSession } from "sandbar-adapter";
import { bindAdapter, type BoundAdapter } from "./bound";

const Configuration = z
  .strictObject({
    teamId: z.string().min(1).optional(),
    templateId: z.string().min(1).default("base"),
    timeoutSeconds: z.number().int().min(60).max(3600).optional(),
    preview: z
      .strictObject({ access: z.enum(["protected", "public"]).default("protected") })
      .default({ access: "protected" }),
    lifecycle: z
      .strictObject({
        lifetimeSeconds: z.number().int().positive().safe().max(3600).optional(),
        suspension: z
          .strictObject({ preserve: z.enum(["filesystem", "filesystem+memory"]) })
          .optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.lifecycle?.lifetimeSeconds !== undefined && value.timeoutSeconds !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle", "lifetimeSeconds"],
        message: "Supply one lifetime option",
      });
  })
  .transform((value) => ({
    ...value,
    timeoutSeconds:
      value.lifecycle?.lifetimeSeconds === undefined
        ? (value.timeoutSeconds ?? 300)
        : Math.max(60, value.lifecycle.lifetimeSeconds),
  }));

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

/** Injectable E2B native boundary for deterministic qualification. */
export interface E2BTransport {
  state?: {
    template(id: string): Promise<{
      templateId: string;
      names: string[];
      public: boolean;
      builds: { buildId: string; status: "building" | "waiting" | "ready" | "error" }[];
    } | null>;
    verifyAddress(id: string, names?: string[]): Promise<void>;
    tags(id: string): Promise<{ tag: string; buildId: string }[]>;
    capture(
      id: string,
      name?: string,
      signal?: AbortSignal,
    ): Promise<{ snapshotId: string; names: string[] }>;
    snapshots(input: {
      limit: number;
      name?: string;
      sandboxId?: string;
      cursor?: string;
    }): Promise<{ items: { snapshotId: string; names: string[] }[]; nextCursor?: string }>;
    deleteSnapshot(id: string, signal?: AbortSignal): Promise<boolean>;
    createVolume(name: string, signal?: AbortSignal): Promise<{ volumeId: string; name: string }>;
    volume(id: string): Promise<{ volumeId: string; name: string }>;
    volumes(): Promise<{ volumeId: string; name: string }[]>;
    deleteVolume(id: string, signal?: AbortSignal): Promise<boolean>;
  };
  verifyAuth(): Promise<void>;
  verifyTeam(teamId: string): Promise<void>;
  verifyTemplate(teamId: string | undefined, templateId: string): Promise<string>;
  buildImage(reference: string, name: string): Promise<{ templateId: string; buildId: string }>;
  findBuild(
    teamId: string | undefined,
    name: string,
  ): Promise<{ templateId: string; buildId: string; status: string } | null>;
  create(input: {
    templateId: string;
    metadata: Record<string, string>;
    timeoutMs: number;
    allowInternetAccess: boolean;
    allowPublicTraffic?: boolean;
    volumeMounts?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<string>;
  get(id: string): Promise<{
    id: string;
    templateId: string;
    metadata: Record<string, string>;
    state: "running" | "paused";
    lifecycle?: { onTimeout?: string; autoResume?: boolean };
    envdVersion?: string;
    domain?: string;
    allowPublicTraffic?: boolean;
    volumeMounts?: { name: string; path: string }[];
  } | null>;
  list(
    metadata: Record<string, string>,
    limit: number,
    nextToken?: string,
  ): Promise<{
    items: {
      id: string;
      templateId: string;
      metadata: Record<string, string>;
      state: "running" | "paused";
      lifecycle?: { onTimeout?: string; autoResume?: boolean };
      envdVersion?: string;
      domain?: string;
      allowPublicTraffic?: boolean;
      volumeMounts?: { name: string; path: string }[];
    }[];
    nextToken?: string;
  }>;
  suspend?: (id: string, signal: AbortSignal) => Promise<void>;
  resume?: (id: string, seconds: number, signal: AbortSignal) => Promise<void>;
  renew?: (id: string, seconds: number, signal: AbortSignal) => Promise<void>;
  kill(id: string, signal?: AbortSignal): Promise<boolean>;
  run(
    id: string,
    script: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
  ): Promise<string>;
  read(
    id: string,
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  write(id: string, path: string, bytes: Uint8Array): Promise<void>;
  remove(id: string, path: string): Promise<void>;
  close(): void;
}

/** Public E2B definition for custom connection options. */
export function createE2BAdapter(
  transportFactory?: (options: { apiKey: string }) => E2BTransport,
): AdapterDefinition<typeof Configuration, typeof Credentials, AdapterSession> {
  return createPrivateE2BAdapter(transportFactory);
}

/** E2B adapter with API-key scope and default base template; optional verified team scope. */
export function e2b(options: {
  apiKey: string;
  teamId?: string;
  templateId?: string;
  timeoutSeconds?: number;
  preview?: { access: "protected" | "public" };
  lifecycle?: {
    lifetimeSeconds?: number;
    suspension?: { preserve: "filesystem" | "filesystem+memory" };
  };
}): BoundAdapter {
  return bindAdapter(
    createE2BAdapter(),
    {
      teamId: options.teamId,
      templateId: options.templateId,
      timeoutSeconds: options.timeoutSeconds,
      lifecycle: options.lifecycle,
      preview: options.preview,
    },
    { apiKey: options.apiKey },
  );
}
