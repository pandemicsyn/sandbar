import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CliError, usage } from "./output";

export type Env = Readonly<Record<string, string | undefined>>;

export const ProfileConfig = z
  .strictObject({
    /** An official provider id; its adapter package is `@sandbar-sdk/<provider>`. */
    provider: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .optional(),
    /** Any adapter module: a package name or a path relative to the config file. */
    module: z.string().min(1).max(1024).optional(),
    /** The module export holding the adapter definition or bound adapter. */
    export: z.string().min(1).max(128).optional(),
    config: z.record(z.string(), z.json()).optional(),
    credentials: z.record(z.string(), z.string()).optional(),
  })
  .refine((profile) => profile.provider || profile.module, {
    message: "A profile needs a provider or a module",
  });

export type ProfileConfig = z.infer<typeof ProfileConfig>;

export const CliConfig = z.strictObject({
  default: z.string().min(1).optional(),
  profiles: z.record(z.string(), ProfileConfig).optional(),
  state: z.strictObject({ kind: z.literal("fs"), dir: z.string().min(1).optional() }).optional(),
  limits: z
    .strictObject({ maxSandboxes: z.number().int().positive().nullable().optional() })
    .optional(),
  images: z.strictObject({ autoBuild: z.boolean().optional() }).optional(),
});

export type CliConfig = z.infer<typeof CliConfig>;

export type LoadedConfig = {
  path: string;
  /** Directory relative module paths and the default state folder resolve against. */
  dir: string;
  exists: boolean;
  value: CliConfig;
};

export function configHome(env: Env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "sandbar");
}

export function expandHome(path: string, env: Env): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME || homedir(), path.slice(1)) : path;
}

/** Read `sandbar.json`; a missing default file is an empty configuration. */
export async function loadConfig(
  explicitPath: string | undefined,
  env: Env,
): Promise<LoadedConfig> {
  const chosen = explicitPath ?? env.SANDBAR_CONFIG;
  const path = resolve(expandHome(chosen ?? join(configHome(env), "sandbar.json"), env));
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (!chosen && cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { path, dir: dirname(path), exists: false, value: {} };

    throw usage(`Cannot read config ${path}: ${cause instanceof Error ? cause.message : cause}`);
  }

  let json: z.infer<ReturnType<typeof z.json>>;

  try {
    json = z.json().parse(JSON.parse(text));
  } catch {
    throw usage(`Config ${path} is not valid JSON`);
  }

  const parsed = CliConfig.safeParse(json);

  if (!parsed.success)
    throw usage(
      `Config ${path} is invalid: ${z.prettifyError(parsed.error).replaceAll("\n", "; ")}`,
    );

  return { path, dir: dirname(path), exists: true, value: parsed.data };
}

export function stateDir(flag: string | undefined, config: LoadedConfig, env: Env): string {
  const chosen = flag ?? env.SANDBAR_STATE_DIR ?? config.value.state?.dir;

  return resolve(config.dir, expandHome(chosen ?? join(configHome(env), "state"), env));
}

export function maxSandboxes(config: LoadedConfig, env: Env): number | null {
  const fromEnv = env.SANDBAR_MAX_SANDBOXES;

  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = z.coerce.number().int().positive().safeParse(fromEnv);

    if (!parsed.success) throw usage("SANDBAR_MAX_SANDBOXES must be a positive integer");

    return parsed.data;
  }

  return config.value.limits?.maxSandboxes ?? null;
}

const EnvReference = z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/);

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** Replace `env:NAME` strings with the variable's value; credentials never live in files. */
export function resolveEnvReferences(value: JsonValue, env: Env, where: string): JsonValue {
  const reference = EnvReference.safeParse(value);

  if (reference.success) {
    const name = reference.data.slice(4);
    const found = env[name];

    if (found === undefined || found === "")
      throw new CliError("USAGE", `${where} needs environment variable ${name}`);

    return found;
  }

  if (Array.isArray(value)) return value.map((item) => resolveEnvReferences(item, env, where));

  const record = z.record(z.string(), z.json()).safeParse(value);

  if (record.success)
    return Object.fromEntries(
      Object.entries(record.data).map(([key, item]) => [
        key,
        resolveEnvReferences(item, env, `${where}.${key}`),
      ]),
    );

  return value;
}
