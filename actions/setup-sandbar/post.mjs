import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./lib.mjs";

const sandbar = process.env.STATE_sandbar;

const stateDir = process.env.STATE_stateDir;

if (process.env.STATE_cleanup !== "true" || !sandbar || !stateDir)
  console.log("Sandbar cleanup skipped");
else if (!existsSync(join(stateDir, "sandboxes")))
  console.log("No Sandbar sandboxes recorded in this job");
else
  try {
    // The store is this job's own, so --all reaches only sandboxes this job created.
    process.env.SANDBAR_STATE_DIR = stateDir;
    run(sandbar, ["rm", "--all"]);
  } catch (cause) {
    // Cleanup never fails the job; a later `sandbar gc` or the sandbox lifetime collects leftovers.
    console.log(
      `::warning::Sandbar cleanup did not finish: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
