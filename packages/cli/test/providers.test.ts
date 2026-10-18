import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { descriptor, loadAdapter, missingEnv, resolveProfile } from "../src/providers";
import { SecretReader } from "../src/secrets";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sandbar-providers-"));
  const scope = join(home, ".config", "sandbar", "adapters", "node_modules", "@sandbar-sdk");
  await mkdir(scope, { recursive: true });
  await symlink(join(import.meta.dir, "..", "..", "providers", "boxd"), join(scope, "boxd"));
  await symlink(join(import.meta.dir, "..", "..", "providers", "boat"), join(scope, "boat"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("environment-only boxd setup names and binds its required network choice", async () => {
  const env = { HOME: home, BOXD_API_KEY: "key", BOXD_ORG: "team" };

  expect(missingEnv(descriptor("boxd")!, env)).toEqual(["BOXD_NETWORK"]);

  const ready = { ...env, BOXD_NETWORK: "internet" };
  const profile = resolveProfile({ provider: "boxd" }, await loadConfig(undefined, ready), ready);

  expect(profile.config).toEqual({ org: "team", network: "internet" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("boxd");
});

test("environment-only Boat setup names and binds its required network choice", async () => {
  const env = { HOME: home, BOAT_API_KEY: "key" };

  expect(missingEnv(descriptor("boat")!, env)).toEqual(["BOAT_NETWORK"]);

  const ready = { ...env, BOAT_NETWORK: "internet" };
  const profile = resolveProfile({ provider: "boat" }, await loadConfig(undefined, ready), ready);

  expect(profile.config).toEqual({ network: "internet" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("boat");
});
