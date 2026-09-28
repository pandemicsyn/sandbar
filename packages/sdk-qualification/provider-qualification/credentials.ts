import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Called only by the manual live/cleanup entrypoint; never by ordinary offline tests. */
export async function loadCredentials(
  filename = process.env.SANDBAR_CREDENTIALS_FILE ?? join(homedir(), ".config", "sandbar.env"),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let source: string;

  try {
    source = await readFile(filename, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") source = "";
    else throw new Error("Unable to read Sandbar credential file");
  }

  if (Buffer.byteLength(source) > 65_536)
    throw new Error("Sandbar credential file exceeds the size limit");
  const parsed = parseEnv(source);

  const daytona =
    environment.SANDBAR_DAYTONA_API_KEY ??
    environment.DAYTONA_API_KEY ??
    parsed.SANDBAR_DAYTONA_API_KEY ??
    parsed.DAYTONA_API_KEY;

  const e2b =
    environment.E2B_API_KEY ??
    environment.SANDBAR_E2B_API_KEY ??
    parsed.E2B_API_KEY ??
    parsed.SANDBAR_E2B_API_KEY;

  if (daytona !== undefined) environment.SANDBAR_DAYTONA_API_KEY = daytona;

  if (e2b !== undefined) environment.E2B_API_KEY = e2b;
}
