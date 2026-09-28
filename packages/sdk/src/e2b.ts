import { createE2BAdapter as createPrivateE2BAdapter } from "@sandbar/provider-e2b";
import { z } from "zod";
import type { AdapterDefinition, AdapterSession } from "sandbar-adapter";
import { bindAdapter, type BoundAdapter } from "./bound";

const Configuration = z.strictObject({
  teamId: z.string().min(1).optional(),
  templateId: z.string().min(1).default("base"),
  timeoutSeconds: z.number().int().min(60).max(3600).default(300),
});

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

/** Injectable E2B native boundary for deterministic qualification. */
export interface E2BTransport {
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
  }): Promise<string>;
  get(id: string): Promise<{
    id: string;
    templateId: string;
    metadata: Record<string, string>;
    state: "running" | "paused";
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
    }[];
    nextToken?: string;
  }>;
  kill(id: string): Promise<boolean>;
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

/** Public E2B definition for service registration or custom connection options. */
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
}): BoundAdapter {
  return bindAdapter(
    createE2BAdapter(),
    {
      teamId: options.teamId,
      templateId: options.templateId,
      timeoutSeconds: options.timeoutSeconds,
    },
    { apiKey: options.apiKey },
  );
}
