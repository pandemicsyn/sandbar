import assert from "node:assert/strict";
import { defineAdapter } from "sandbar-adapter";
import { bindAdapter } from "../../sdk/src/bound";
import { fixtureAdapter } from "./adapter";

/** Only the provider boundary is replaced; the published example executes unchanged. */
export function daytona(options: { target: string }) {
  assert.equal(options.target, "us");
  const fixture = fixtureAdapter({ exitCode: 0 });

  const adapter = defineAdapter({
    ...fixture.adapter,
    async connect(input) {
      const session = await fixture.adapter.connect(input);

      if (process.env.TEST_MODE === "connect_failure")
        throw new Error("DOCUMENTATION_CONNECT_FAILURE");

      return {
        ...session,
        supports: { ...session.supports, network: ["daytona-default" as const] },
      };
    },
  });

  process.once("beforeExit", () => {
    const expected = process.env.TEST_MODE === "connect_failure" ? 0 : 1;

    assert.equal(fixture.counts.create, expected);
    assert.equal(fixture.counts.destroy, expected);
    assert.equal(fixture.counts.close, 1);
    console.log(
      process.env.TEST_MODE === "connect_failure"
        ? "DOCUMENTATION_CONNECTION_FAILURE_OK"
        : "DOCUMENTATION_WORKLOAD_OK",
    );
  });

  return bindAdapter(adapter, {}, {});
}
