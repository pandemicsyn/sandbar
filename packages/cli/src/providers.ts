import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bindAdapter,
  type AdapterDefinition,
  type BoundAdapter,
  type Json,
  type RuntimeSession,
} from "@sandbar-sdk/adapter";
import { Sandbar, type SandbarClient } from "sandbar-sdk";
import { z } from "zod";
import {
  configHome,
  resolveEnvReferences,
  searchProjectAdapters,
  type Env,
  type LoadedConfig,
  type ProfileConfig,
} from "./config";
import { CliError, usage } from "./output";
import type { SecretReader } from "./secrets";

/**
 * How the CLI builds an official adapter from environment variables alone.
 * Temporary home: adapters should export this themselves (design gap G6).
 */
export type ProviderDescriptor = {
  id: string;
  module: string;
  export: string;
  experimental: boolean;
  /** Credential key -> environment variable. All are required. */
  credentials: Readonly<Record<string, string>>;
  /** Config key -> environment variable, and whether the adapter requires it. */
  config: Readonly<Record<string, { env: string; required: boolean }>>;
};

export const providers: readonly ProviderDescriptor[] = [
  {
    id: "daytona",
    module: "@sandbar-sdk/daytona",
    export: "daytonaAdapter",
    experimental: false,
    credentials: { apiKey: "DAYTONA_API_KEY" },
    config: { target: { env: "DAYTONA_TARGET", required: true } },
  },
  {
    id: "e2b",
    module: "@sandbar-sdk/e2b",
    export: "e2bAdapter",
    experimental: false,
    credentials: { apiKey: "E2B_API_KEY" },
    config: {},
  },
  {
    id: "boxd",
    module: "@sandbar-sdk/boxd",
    export: "boxdAdapter",
    experimental: true,
    credentials: { apiKey: "BOXD_API_KEY" },
    config: {
      org: { env: "BOXD_ORG", required: true },
      // boxd always allows internet egress, so its adapter requires choosing that explicitly.
      network: { env: "BOXD_NETWORK", required: true },
    },
  },
  {
    id: "vercel",
    module: "@sandbar-sdk/vercel",
    export: "vercel",
    experimental: false,
    credentials: { token: "VERCEL_TOKEN" },
    config: {
      teamId: { env: "VERCEL_TEAM_ID", required: true },
      projectId: { env: "VERCEL_PROJECT_ID", required: true },
    },
  },
  {
    id: "modal",
    module: "@sandbar-sdk/modal",
    export: "modalAdapter",
    experimental: true,
    credentials: { tokenId: "MODAL_TOKEN_ID", tokenSecret: "MODAL_TOKEN_SECRET" },
    config: {
      appName: { env: "MODAL_APP_NAME", required: true },
      environment: { env: "MODAL_ENVIRONMENT", required: true },
    },
  },
];

export function descriptor(id: string): ProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id);
}

/** Environment variables an official provider still needs; `covered` names keys set elsewhere. */
export function missingEnv(
  provider: ProviderDescriptor,
  env: Env,
  covered: ReadonlySet<string> = new Set(),
): string[] {
  const needed = [
    ...Object.entries(provider.credentials),
    ...Object.entries(provider.config).flatMap(([key, entry]) =>
      entry.required ? [[key, entry.env] as const] : [],
    ),
  ];

  return needed.flatMap(([key, name]) => (covered.has(key) || env[name] ? [] : [name]));
}

export type ResolvedProfile = {
  name: string;
  provider: string;
  module: string;
  export: string;
  /** Directory a relative module path resolves against. */
  baseDir: string;
  /** Whether the project's node_modules may supply the adapter (config adapters.searchProject). */
  searchProject: boolean;
  config: Record<string, Json>;
  credentials: Record<string, string>;
};

/** Pick the profile: --profile, SANDBAR_PROFILE, --provider, SANDBAR_PROVIDER, then the config default. */
export function resolveProfile(
  flags: { profile?: string; provider?: string },
  loaded: LoadedConfig,
  env: Env,
): ResolvedProfile {
  const profiles = loaded.value.profiles ?? {};
  const profileName = flags.profile ?? (flags.provider ? undefined : env.SANDBAR_PROFILE);

  if (profileName) {
    const profile = profiles[profileName];

    if (!profile)
      throw usage(
        `Profile ${profileName} is not defined in ${loaded.path}`,
        Object.keys(profiles).length
          ? `known profiles: ${Object.keys(profiles).join(", ")}`
          : 'add it under "profiles" in sandbar.json',
      );

    return fromProfile(profileName, profile, loaded, env);
  }

  const providerId = flags.provider ?? env.SANDBAR_PROVIDER;

  if (providerId) return fromProfile(providerId, { provider: providerId }, loaded, env);

  const fallback = loaded.value.default;

  if (fallback) {
    const profile = profiles[fallback];

    if (!profile) throw usage(`Default profile ${fallback} is not defined in ${loaded.path}`);

    return fromProfile(fallback, profile, loaded, env);
  }

  const ready = providers.filter((provider) => !missingEnv(provider, env).length);

  throw usage(
    "No provider selected",
    ready.length
      ? `credentials found for: ${ready.map((provider) => provider.id).join(", ")}; set SANDBAR_PROVIDER or pass --provider`
      : "set SANDBAR_PROVIDER and the provider's credentials (see `sandbar providers`), or add a profile to sandbar.json",
  );
}

function fromProfile(
  name: string,
  profile: ProfileConfig,
  loaded: LoadedConfig,
  env: Env,
): ResolvedProfile {
  const official = profile.provider ? descriptor(profile.provider) : undefined;

  if (profile.provider && !official && !profile.module)
    throw usage(
      `Unknown provider ${profile.provider}`,
      `official providers: ${providers.map((provider) => provider.id).join(", ")}; use "module" for other adapters`,
    );

  const where = `profile ${name}`;

  // Environment variables fill official adapter settings; profile values override them.
  const credentials = Object.fromEntries([
    ...Object.entries(official?.credentials ?? {}).flatMap(([key, variable]) => {
      const value = env[variable];

      return value ? [[key, value] as const] : [];
    }),
    ...Object.entries(profile.credentials ?? {}).map(
      ([key, value]) =>
        [
          key,
          z.string().parse(resolveEnvReferences(value, env, `${where}.credentials.${key}`)),
        ] as const,
    ),
  ]);

  const config = Object.fromEntries([
    ...Object.entries(official?.config ?? {}).flatMap(([key, entry]) => {
      const value = env[entry.env];

      return value ? [[key, value] as const] : [];
    }),
    ...Object.entries(profile.config ?? {}).map(
      ([key, value]) => [key, resolveEnvReferences(value, env, `${where}.config.${key}`)] as const,
    ),
  ]);

  if (official) {
    const missing = [
      ...Object.entries(official.credentials)
        .filter(([key]) => !credentials[key])
        .map(([, variable]) => variable),
      ...Object.entries(official.config)
        .filter(([key, entry]) => entry.required && config[key] === undefined)
        .map(([, entry]) => entry.env),
    ];

    if (missing.length)
      throw usage(
        `${where} (${official.id}) is missing ${missing.join(", ")}`,
        "set the environment variables, or put the values in the profile in sandbar.json",
      );
  }

  return {
    name,
    provider: official?.id ?? profile.provider ?? name,
    module: profile.module ?? official?.module ?? "",
    export: profile.export ?? official?.export ?? "default",
    baseDir: loaded.dir,
    searchProject: searchProjectAdapters(loaded, env),
    config,
    credentials,
  };
}

const ConditionalEntry = z.object({
  import: z.string().optional(),
  default: z.string().optional(),
});

const PackageManifest = z.object({
  main: z.string().optional(),
  exports: z
    .union([
      z.string(),
      z.object({ ".": z.union([z.string(), ConditionalEntry]).optional() }),
      ConditionalEntry,
    ])
    .optional(),
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

function rootEntry(manifest: z.infer<typeof PackageManifest>): string {
  const field = manifest.exports;
  const plain = z.string().safeParse(field);

  if (plain.success) return plain.data;
  const dotted = z.object({ ".": z.union([z.string(), ConditionalEntry]) }).safeParse(field);
  const target = dotted.success ? dotted.data["."] : field;
  const direct = z.string().safeParse(target);

  if (direct.success) return direct.data;
  const conditional = ConditionalEntry.safeParse(target);

  return (
    (conditional.success && (conditional.data.import ?? conditional.data.default)) ||
    manifest.main ||
    "index.js"
  );
}

async function entryFor(packageDir: string): Promise<string | null> {
  const manifestPath = join(packageDir, "package.json");

  if (!(await exists(manifestPath))) return null;
  const manifest = PackageManifest.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));

  if (!manifest.success) return null;
  const entry = resolve(packageDir, rootEntry(manifest.data));
  const inside = relative(packageDir, entry);

  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new CliError(
      "ADAPTER_NOT_INSTALLED",
      `${manifestPath} points its entry outside the package (${rootEntry(manifest.data)})`,
    );

  return entry;
}

const PackageName = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Adapters are installed separately and receive credentials, so they come from
 * `~/.config/sandbar/adapters` or the CLI's own module resolution. The working directory's
 * node_modules (walking up) is searched only when adapters.searchProject opts in.
 */
export async function resolveAdapterModule(
  profile: ResolvedProfile,
  cwd: string,
  env: Env,
): Promise<string> {
  const spec = profile.module;

  if (spec.startsWith(".") || isAbsolute(spec))
    return pathToFileURL(resolve(profile.baseDir, spec)).href;

  if (!PackageName.test(spec))
    throw usage(`Adapter module ${spec} is not a package name or a path`);

  const roots = [join(configHome(env), "adapters", "node_modules")];

  if (profile.searchProject)
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      roots.push(join(dir, "node_modules"));

      if (dirname(dir) === dir) break;
    }

  for (const root of roots) {
    const entry = await entryFor(join(root, spec));

    if (entry) return pathToFileURL(entry).href;
  }

  return spec;
}

function isAdapter(
  value: unknown,
): value is AdapterDefinition<z.ZodType, z.ZodType, RuntimeSession> | BoundAdapter {
  return value instanceof Object && "name" in value && "connect" in value && "config" in value;
}

const AdapterExport = z.custom<
  AdapterDefinition<z.ZodType, z.ZodType, RuntimeSession> | BoundAdapter
>(isAdapter);

export async function loadAdapter(
  profile: ResolvedProfile,
  cwd: string,
  env: Env,
  secrets: SecretReader,
): Promise<BoundAdapter> {
  const target = await resolveAdapterModule(profile, cwd, env);
  const schema = z.object({ [profile.export]: AdapterExport });
  let parsed: ReturnType<typeof schema.safeParse>;

  try {
    parsed = schema.safeParse(await import(target));
  } catch (cause) {
    const official = descriptor(profile.provider);

    throw new CliError(
      "ADAPTER_NOT_INSTALLED",
      `Cannot load adapter ${profile.module} for profile ${profile.name}: ${cause instanceof Error ? cause.message : cause}`,
      official
        ? `install it into ${join(configHome(env), "adapters")} (cd there && npm install ${official.module}); project installs need adapters.searchProject or SANDBAR_PROJECT_ADAPTERS=1`
        : "check the profile's module path",
    );
  }

  if (!parsed.success)
    throw new CliError(
      "ADAPTER_NOT_INSTALLED",
      `${profile.module} has no adapter export named ${profile.export}`,
    );
  const exported = parsed.data[profile.export];

  if (!exported) throw new CliError("ADAPTER_NOT_INSTALLED", `${profile.module} export is empty`);

  if ("bound" in exported) return exported;

  // Password-manager references are read only now, when the profile is actually used.
  const where = `profile ${profile.name}`;
  const config = await secrets.resolve(profile.config, `${where}.config`);

  const credentials = z
    .record(z.string(), z.string())
    .parse(await secrets.resolve(profile.credentials, `${where}.credentials`));

  return bindAdapter(exported, config, credentials);
}

export async function connect(
  profile: ResolvedProfile,
  cwd: string,
  env: Env,
  secrets: SecretReader,
): Promise<SandbarClient<true>> {
  return Sandbar.connect(await loadAdapter(profile, cwd, env, secrets));
}
