import type { FileEntry, SandboxHandle } from "sandbar-sdk";

/** E2B supports this explicitly recursive workflow; byte APIs need no text helpers. */
export async function directoryFiles(box: SandboxHandle, root = "/home/user/sandbar-job") {
  await box.makeDirectory(`${root}/results`, { recursive: true });
  await box.writeFile(`${root}/results/summary.bin`, Uint8Array.of(0, 255, 129));

  if (!(await box.fileExists(`${root}/results/summary.bin`))) throw Error("Missing summary");
  const bytes = await box.readFile(`${root}/results/summary.bin`);
  await box.removeFile(root, { recursive: true });

  return bytes;
}

/** For adapters with a complete native listing; both built-ins currently reject this. */
export async function listChildren(box: SandboxHandle, path: string): Promise<FileEntry[]> {
  return box.listFiles(path);
}
