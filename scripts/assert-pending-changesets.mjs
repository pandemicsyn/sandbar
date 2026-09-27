import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));

const pending = Array.isArray(report.releases)
  ? report.releases.filter((item) => item.type !== "none")
  : [];

if (pending.length === 0) {
  console.error("No publishable package releases are pending. Add a changeset first.");
  process.exit(1);
}

console.log(`Pending releases: ${pending.map((item) => item.name).join(", ")}`);
