import type {
  DirectSandboxHandle,
  ProcessHandle,
  ProcessOutputBytes,
  StartProcessInput,
  ProcessReference,
  TerminalHandle,
} from "sandbar-sdk";

/** Compile the public byte/text inference independently of the implementation. */
export async function processOutputTypes(box: DirectSandboxHandle): Promise<void> {
  const command = { kind: "argv" as const, argv: ["worker"] };
  const text: ProcessHandle = await box.processes.start({ command });

  for await (const chunk of text.output()) {
    const value: string = chunk.text;
    void value;
    // @ts-expect-error Text observation does not pretend to contain original bytes.
    void chunk.bytes;
  }

  const request: StartProcessInput<"bytes"> = {
    command,
    output: { mode: "stream", format: "bytes" },
  };

  const bytes: ProcessHandle<"bytes"> = await box.processes.start(request);

  for await (const chunk of bytes.output()) {
    const value: ProcessOutputBytes = chunk;
    void value;
    // @ts-expect-error Byte observation has no implicit decoded text.
    void chunk.text;
  }

  const inferred = await box.processes.start({
    command,
    output: { mode: "stream", format: "bytes" },
  });

  const selected: ProcessHandle<"bytes"> = inferred;
  void selected;
  // @ts-expect-error A byte handle requires explicit selection before starting.
  await box.processes.start<"bytes">({ command });
  // @ts-expect-error Byte mode must be streamed, never a finite legacy capture option.
  await box.processes.start({ command, output: { format: "bytes" } });
}

/** Persisted output profiles retain inference and terminal input has no pipe EOF API. */
export async function processExtensionTypes(
  box: DirectSandboxHandle,
  saved: ProcessReference<"bytes">,
): Promise<void> {
  const process: ProcessHandle<"bytes"> = await box.processes.reopen(saved);
  await process.signal("SIGTERM");
  // @ts-expect-error Portable signal names are explicit.
  await process.signal("SIGINT");
  const reference: ProcessReference<"bytes"> = process.reference();
  void reference;

  const terminal: TerminalHandle = await box.terminals.start({
    command: { kind: "argv", argv: ["shell"] },
    columns: 80,
    rows: 24,
  });

  await terminal.resize({ columns: 120, rows: 40 });

  for await (const bytes of terminal.output()) {
    const value: Uint8Array = bytes;
    void value;
  }

  // @ts-expect-error Terminal input has no pipe EOF operation.
  await terminal.closeStdin();
  await terminal.disconnect();
  const reopened: TerminalHandle = await box.terminals.reopen(terminal.reference());
  void reopened;
}
