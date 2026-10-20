import { expect, test } from "bun:test";
import profile from "./boxd-profile";
import { profileRouting } from "./profile";

test("boxd profile retains explicit internet routing, native expiry and honest unsupported declarations without IO", () => {
  const routing = profileRouting(profile, { SANDBAR_BOXD_ORG: "team" });
  expect(routing).toEqual({
    org: "team",
    imageId: "ubuntu:24.04",
    networkPolicy: "internet",
    nativeLifetimeSeconds: 900,
    previewAccess: "protected",
  });
  expect(profileRouting(profile, {}, routing)).toEqual(routing);
  expect(profile.fileNoClobber).toBe(true);
  expect(profile.support.features.finiteStdin.support).toBe("conditional");
  expect(profile.support.features.directories.support).toBe("conditional");
  expect(profile.support.features.previewPublic.support).toBe("conditional");
  expect(profile.configuredEnvironment).toBe(true);
  expect(profile.support.features.snapshots.support).toBe("conditional");
  expect(profile.support.features.streaming.support).toBe("unsupported");
  expect(profile.support.features.volumes.support).toBe("conditional");
  expect(profile.support.features.persistence.support).toBe("conditional");
  expect(() => profileRouting(profile, {})).toThrow();
});
