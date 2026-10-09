import type { FileEntry, SandboxHandle, WalkFileEntry } from "sandbar-sdk";

/** The same private-filesystem workflow works with Daytona, E2B and custom adapters. */
export async function directoryFiles(box: SandboxHandle, root = "/home/user/sandbar-job") {
  await box.makeDirectory(`${root}/results`, { recursive: true });
  await box.writeFile(`${root}/results/summary.bin`, Uint8Array.of(0, 255, 129));

  if (!(await box.fileExists(`${root}/results/summary.bin`))) throw Error("Missing summary");
  const bytes = await box.readFile(`${root}/results/summary.bin`);
  await box.removeFile(root, { recursive: true });

  return bytes;
}

/** Strict, complete listing; use readDirectory when completeness may be unknown. */
export async function listChildren(box: SandboxHandle, path: string): Promise<FileEntry[]> {
  return box.listFiles(path);
}

/** Incremental artifact IO: the caller owns both the source chunks and the sink. */
export async function artifactFiles(
  box: SandboxHandle,
  input: AsyncIterable<Uint8Array>,
  destination: { write(chunk: Uint8Array): Promise<void> },
  root = "/home/user/sandbar-artifacts",
  signal?: AbortSignal,
) {
  await box.makeDirectory(`${root}/results`, { recursive: true, signal });

  try {
    await box.writeTextFile(`${root}/results/report.json`, JSON.stringify({ ready: true }), {
      signal,
    });
    const directory = await box.readDirectory(`${root}/results`, { signal });
    const info = await box.statFile(`${root}/results/report.json`, { signal });
    await box.copyFile(`${root}/results/report.json`, `${root}/copy.json`, { signal });
    await box.moveFile(`${root}/copy.json`, `${root}/final.json`, { signal });
    const uploaded = await box.writeFileStream(`${root}/archive.bin`, input, { signal });

    for await (const chunk of box.readFileStream(`${root}/archive.bin`, { signal })) {
      await destination.write(chunk);
    }

    await box.writeTextFile(`${root}/results/events.txt`, "ready ✓\r\ncomplete\n", { signal });
    const entries: WalkFileEntry[] = [];

    for await (const entry of box.walkFiles(root, { signal, maxDepth: 2, maxEntries: 32 })) {
      entries.push(entry);
    }

    const lines: string[] = [];

    for await (const line of box.readTextLines(`${root}/results/events.txt`, {
      signal,
      maxLineBytes: 1024,
    })) {
      lines.push(line);
    }

    return { directory, info, uploaded, entries, lines };
  } finally {
    await box.removeFile(root, { recursive: true });
  }
}
