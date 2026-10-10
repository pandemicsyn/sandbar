import {
  Image,
  SandbarError,
  type CreateInput,
  type SandbarClient,
  type SandboxHandle,
} from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) throw new Error(`Set ${name} in examples/.env.local`);

  return value;
}

// Validate configuration before connecting or allocating compute.
export function providerSetup(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--provider") {
    throw new Error("Usage: hello|edit --provider daytona|e2b");
  }

  switch (args[1]) {
    case "daytona":
      return {
        adapter: daytona({
          apiKey: required("DAYTONA_API_KEY"),
          target: required("DAYTONA_TARGET"),
          environment: Image.prepared(required("DAYTONA_SNAPSHOT")),
          lifecycle: { lifetimeSeconds: 600 },
          networkPolicy: "daytona-default",
        }),
        create: { networkPolicy: "daytona-default" } satisfies CreateInput,
      };
    case "e2b":
      return {
        adapter: e2b({
          apiKey: required("E2B_API_KEY"),
          templateId: process.env.E2B_TEMPLATE_ID?.trim() || "base",
          lifecycle: { lifetimeSeconds: 600 },
        }),
        create: { networkPolicy: "internet" } satisfies CreateInput,
      };
    default:
      throw new Error("Choose --provider daytona or --provider e2b");
  }
}

export function cancellation() {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  return {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(480_000)]),
    dispose() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    },
  };
}

// Cleanup has its own deadline because the workflow signal may already be aborted.
export async function cleanup(
  client: Pick<SandbarClient, "close">,
  box: Pick<SandboxHandle, "id" | "destroy"> | undefined,
  failed: boolean,
) {
  let cleanupFailed = false;

  try {
    if (box) await box.destroy({ signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    cleanupFailed = true;
    console.error(
      `Cleanup uncertain for sandbox ${box?.id}; inspect it in the provider dashboard.`,
      error,
    );
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        client.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Client close timed out")), 5_000);
        }),
      ]);
    } catch (error) {
      cleanupFailed = true;
      console.error("Client close failed:", error);
    } finally {
      clearTimeout(timer);
    }
  }

  if (cleanupFailed && !failed) throw new Error("Sandbox cleanup was not confirmed");
}

// SDK errors carry a recovery reference when a submitted operation is uncertain.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The top-level catch accepts arbitrary JavaScript errors and narrows SDK errors before accessing recovery references.
export function reportFailure(error: unknown) {
  console.error(error);

  if (error instanceof SandbarError && error.reference) {
    console.error("Recovery reference (do not blindly retry):", JSON.stringify(error.reference));
  }

  process.exitCode = 1;
}
