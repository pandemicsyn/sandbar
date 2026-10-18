import { expect, test } from "bun:test";
import { EXEC_RECORD, parseWrapper, quote, wrapperScript } from "./exec";

test("quote keeps every byte literal for POSIX sh", () => {
  expect(quote("it's $(x)")).toBe(`'it'\\''s $(x)'`);
  expect(() => quote("a\0b")).toThrow();
});

test("wrapper rejects empty argv and non-POSIX environment names before dispatch", () => {
  expect(() => wrapperScript({ command: { kind: "argv", argv: [] }, maxBytes: 1 })).toThrow();
  expect(() =>
    wrapperScript({ command: { kind: "argv", argv: ["true"] }, env: { "A-B": "1" }, maxBytes: 1 }),
  ).toThrow();
});

test("the result record must be exact and its lengths consistent", () => {
  const record = (body: string) => `${EXEC_RECORD} ${body}`;

  expect(parseWrapper(record("2 3 0\nAP+A\n\n"))).toEqual({
    exitCode: 2,
    stdout: Uint8Array.of(0, 255, 128),
    stderr: new Uint8Array(),
    truncated: false,
  });
  expect(parseWrapper(record("0 9 0\nAP+A\n\n"))?.truncated).toBe(true);
  // More decoded bytes than the guest counted, trailing text or non-canonical base64 are malformed.
  expect(parseWrapper(record("0 1 0\nAP+A\n\n"))).toBeNull();
  expect(parseWrapper(record("0 3 0\nAP+A\n\nextra"))).toBeNull();
  expect(parseWrapper(record("0 1 0\nAB==\n\n"))).toBeNull();
  expect(parseWrapper("")).toBeNull();
});
