import { ControlStore, openSqliteBackend } from "@sandbar/store";

const path = process.argv[2];

if (!path) throw new Error("SQLite path required");

const store = new ControlStore(openSqliteBackend(path));

const claim = await store.claimDue("hard-crash-test", -1);

if (!claim || !(await store.beginSubmission(claim)))
  throw new Error("No due operation to mark submitted");

process.kill(process.pid, "SIGKILL");
