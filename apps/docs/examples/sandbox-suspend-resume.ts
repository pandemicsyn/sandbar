import { Sandbar, Image, type SandboxReference } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";

// Provider changes stay in setup. Memory preservation also meets a filesystem minimum.
export const daytonaSetup = (apiKey: string) =>
  daytona({
    apiKey,
    target: "us",
    lifecycle: { lifetimeSeconds: 600, suspension: { preserve: "filesystem" } },
  });

export const e2bSetup = (apiKey: string, teamId: string) =>
  e2b({
    apiKey,
    teamId,
    templateId: "base",
    lifecycle: { lifetimeSeconds: 600, suspension: { preserve: "filesystem" } },
  });

export async function saveWorkspace(
  adapter: ReturnType<typeof daytona>,
  preparedImage: string,
  save: (reference: SandboxReference) => Promise<void>,
) {
  const client = await Sandbar.connect(adapter);

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared(preparedImage) });

    try {
      if (!box.reference) throw new Error("Verified sandbox identity unavailable");
      await save(box.reference); // Save before suspension; applications own persistence.
      await box.writeFile("/tmp/workspace.txt", new TextEncoder().encode("saved"), {
        overwrite: true,
      });
    } catch (error) {
      await box.destroy();
      throw error;
    }

    return await box.suspend(); // No per-call mode or provider options.
  } finally {
    await client.close();
  }
}

export async function finishWorkspace(
  adapter: ReturnType<typeof daytona>,
  saved: SandboxReference,
) {
  const client = await Sandbar.connect(adapter);

  try {
    const box = await client.sandboxes.get(saved); // Inactive compute stays inactive.
    const inactive = await box.inspect();

    try {
      const resumed = await box.resume(); // E2B uses this setup's initial lifetime; Daytona TTL keeps ticking.
      const bytes = await box.readFile("/tmp/workspace.txt");

      return { inactive, resumed, bytes };
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}
