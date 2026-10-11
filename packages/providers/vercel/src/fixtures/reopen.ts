import { z } from "zod";
import { AdapterSandbox, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createVercelAdapter } from "../adapter";

const input = z
  .strictObject({
    reference: z.json(),
    credentials: z.strictObject({ token: z.string() }),
  })
  .parse(JSON.parse(await Bun.stdin.text()));

// SAFETY: The parent fixture serializes the SDK-produced create reference; recover validates its scope and fields.
const reference = input.reference as AdapterRecoveryReference;

const sessionId = z.object({ sessionId: z.string() }).parse(reference.token).sessionId;

const paths: string[] = [];

let closed = 0;

const session = {
  id: sessionId,
  region: "iad1",
  status: "running",
  networkPolicy: { mode: "deny-all" },
};

const adapter = createVercelAdapter(() => ({
  async fetch(url, init) {
    const request = new URL(url);
    paths.push(request.pathname);

    if (init.method !== "GET") throw new Error("Fresh-process recovery attempted a mutation");

    if (new Headers(init.headers).get("authorization") !== `Bearer ${input.credentials.token}`)
      throw new Error("Fresh-process recovery did not use current credentials");

    if (request.searchParams.get("teamId") !== "team-fixture")
      throw new Error("Unexpected team routing");

    switch (request.pathname) {
      case "/api/v2/teams/team-fixture":
        return Response.json({ id: "team-fixture" });
      case "/api/v2/projects/project-fixture":
        return Response.json({ id: "project-fixture", accountId: "team-fixture" });
      case "/api/v2/sandboxes":
        return Response.json({ sandboxes: [], pagination: { next: null } });
      case "/api/v2/sandboxes/sessions":
        if (request.searchParams.get("project") !== "project-fixture")
          throw new Error("Unexpected project routing");

        return Response.json({ sessions: [session], pagination: { next: null } });
      case `/api/v2/sandboxes/sessions/${sessionId}`:
        return Response.json({ session });
      default:
        throw new Error("Unexpected native route during fresh-process recovery");
    }
  },
  close() {
    closed++;
  },
}));

const client = await Sandbar.connect({
  adapter,
  config: { teamId: "team-fixture", projectId: "project-fixture" },
  credentials: input.credentials,
});

try {
  const box = await (await client.recover(reference)).observe();

  if (!(box instanceof AdapterSandbox))
    throw new Error("Create reference did not restore a sandbox");
  const inspection = await box.inspect();
  await client.close();
  console.log(JSON.stringify({ id: box.id, inspection, paths, closed, pid: process.pid }));
} finally {
  await client.close();
}
