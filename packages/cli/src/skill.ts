import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The skill ships inside the CLI so an installed copy always matches this version's commands.
import bundled from "../../../skills/sandbar-cli/SKILL.md" with { type: "text" };
import type { Flags } from "./commands";
import { CliError, usage } from "./output";
import type { Session } from "./session";

export const skillName = "sandbar-cli";

/** Marks a copy this command wrote, so a later install may replace it and nothing else. */
const marker = "<!-- Installed by `sandbar skill install`; rerun it to update this file. -->";

type InstallResult = {
  path: string;
  result: "written" | "updated" | "unchanged" | "skipped";
  reason?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/**
 * `.agents/skills` is the shared location most agents read; Claude Code reads `.claude/skills`,
 * so that copy is written only where a `.claude` folder already exists.
 */
async function skillRoots(base: string): Promise<string[]> {
  const roots = [join(base, ".agents", "skills")];

  if (await exists(join(base, ".claude"))) roots.push(join(base, ".claude", "skills"));

  return roots;
}

async function installAt(root: string, content: string): Promise<InstallResult> {
  const path = join(root, skillName, "SKILL.md");
  let current: string | null = null;

  try {
    current = await readFile(path, "utf8");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  if (current === content) return { path, result: "unchanged" };

  if (current !== null && !current.includes(marker))
    return {
      path,
      result: "skipped",
      reason: "a copy installed another way is already there; remove it to let sandbar manage it",
    };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);

  return { path, result: current === null ? "written" : "updated" };
}

export async function skillCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...extra] = flags.positionals;
  const { out, env, cwd } = session.ctx;

  if (extra.length || (action !== undefined && action !== "install"))
    throw usage("Usage: sandbar skill [install [--project]]");

  if (action === undefined) {
    if (flags.bool("project")) throw usage("--project only applies to `sandbar skill install`");

    if (out.json) out.success({ name: skillName, content: bundled }, "");
    else out.streams.stdout(bundled);

    return 0;
  }

  const content = `${bundled.trimEnd()}\n\n${marker}\n`;
  const base = flags.bool("project") ? cwd : env.HOME || homedir();

  const results = await Promise.all(
    (await skillRoots(base)).map((root) => installAt(root, content)),
  );

  if (results.every((entry) => entry.result === "skipped"))
    throw new CliError(
      "CONFLICT",
      `The ${skillName} skill is already installed another way: ${results.map((entry) => entry.path).join(", ")}`,
      "remove those files and rerun, or update them with the tool that installed them",
    );

  for (const entry of results) if (entry.reason) out.note(`skipped ${entry.path}: ${entry.reason}`);

  out.success(
    { name: skillName, installed: results },
    results
      .filter((entry) => entry.result !== "skipped")
      .map((entry) => `${entry.result.padEnd(9)} ${entry.path}`)
      .join("\n"),
  );

  return 0;
}
