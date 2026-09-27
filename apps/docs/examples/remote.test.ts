import { expect, test } from 'bun:test';
import { Sandbar, Image } from '@sandbar/sdk/remote';
import { ProcessFixture } from '../../../packages/sdk-qualification/processes';

async function post(url: string, token: string | undefined, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json();
}

test('service quickstart exercises the remote SDK', async () => {
  const fixture = new ProcessFixture();
  await fixture.startFake();
  await fixture.startService();
  try {
    const setup = await post(`${fixture.serviceUrl}/v1/setup`, undefined, { setupToken: fixture.setupToken });
    const project = await post(`${fixture.serviceUrl}/v1/projects`, setup.token, { name: 'Documentation example' });
    const connection = await post(`${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections`, setup.token, { provider: 'fake', name: 'Local fake' });
    await post(`${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections/${connection.id}/verify`, setup.token, {});
    const sandbar = Sandbar.connect({ url: fixture.serviceUrl!, token: setup.token, projectId: project.id });
    try {
      const box = await sandbar.sandboxes.create({ environment: Image.prepared('fake-starter') });
      expect((await box.inspect()).state).toBe('running');
      await box.destroy();
    } finally { await sandbar.close(); }
  } finally { await fixture.close(); }
}, 30_000);
