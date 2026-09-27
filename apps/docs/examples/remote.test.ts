import { expect, test } from "bun:test";
import { Sandbar, Image } from "@sandbar/sdk/remote";
import { ProcessFixture } from "../../../packages/sdk-qualification/processes";

type RequestBody =
  | { setupToken: string }
  | { name: string }
  | { provider: "fake"; name: string }
  | Record<string, never>;

async function post(url: string, token: string | undefined, body: RequestBody): Promise<any> {
  const headers = new Headers({ "Content-Type": "application/json" });

  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);

  return response.json();
}

test("service quickstart exercises the remote SDK", async () => {
  const fixture = new ProcessFixture();

  try {
    await fixture.startFake();
    await fixture.startService();

    const setup = await post(`${fixture.serviceUrl}/v1/setup`, undefined, {
      setupToken: fixture.setupToken,
    });

    const project = await post(`${fixture.serviceUrl}/v1/projects`, setup.token, {
      name: "Documentation example",
    });

    const connection = await post(
      `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections`,
      setup.token,
      { provider: "fake", name: "Local fake" },
    );

    await post(
      `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
      setup.token,
      {},
    );

    const sandbar = Sandbar.connect({
      url: fixture.serviceUrl!,
      token: setup.token,
      projectId: project.id,
    });

    try {
      const box = await sandbar.sandboxes.create({ environment: Image.prepared("fake-starter") });
      expect((await box.inspect()).state).toBe("running");
      await box.destroy();
    } finally {
      await sandbar.close();
    }
  } finally {
    await fixture.close();
  }
}, 30_000);
