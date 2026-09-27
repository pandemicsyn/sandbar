import { openSqliteBackend } from "../backend";

openSqliteBackend(Bun.argv[2]!);

process.stdout.write("ready\n");

setInterval(() => {}, 1000);
