import { loadCredentials } from "./credentials";

const action = process.argv[2];

if (action !== "live-prepared" && action !== "reconcile")
  throw new Error("Usage: bun manual.ts live-prepared | reconcile <run UUID>");

const provider = process.env.SANDBAR_QUAL_PROVIDER;

if (provider !== "daytona" && provider !== "e2b")
  throw new Error("SANDBAR_QUAL_PROVIDER must be daytona or e2b");

await loadCredentials();

// No provider import or dispatch until merged public profiles establish native lifetime
// and scoped cleanup. Credential presence never enables a live run by itself.
throw new Error(
  `${provider} live qualification is blocked pending its merged public SDK profile and native cleanup evidence`,
);
