import { Image, type AdapterDirectClient, type AdapterSandbox, type Preview } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";

export const daytonaPreviewSetup = (apiKey: string) =>
  daytona({ apiKey, target: "us", preview: { access: "protected" } });

// Public exposure is an explicit setup choice, across the sandbox's HTTP services.
export const e2bPreviewSetup = (apiKey: string) => e2b({ apiKey, preview: { access: "public" } });

export async function previewResponse(
  box: AdapterSandbox,
  port: number,
  request: typeof fetch = fetch,
): Promise<Response> {
  const preview: Preview = await box.preview(port);

  return request(preview.url, {
    headers: preview.access === "protected" ? preview.headers : undefined,
  });
}

// Select an existing prepared image whose startup command serves HTTP on port 3000.
// This recipe neither starts a server nor claims indefinite process/log support.
export async function previewWorkspace(client: AdapterDirectClient, preparedImage: string) {
  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared(preparedImage),
      networkPolicy: "blocked",
    });

    try {
      const response = await previewResponse(box, 3000);

      // The URL may resolve before the listener is ready. Handle a failed response explicitly.
      if (!response.ok) throw new Error("Preview service is unavailable or not yet ready");

      return await response.text();
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}
