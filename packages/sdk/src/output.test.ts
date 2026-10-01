import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Image, Sandbar, outputText, NonzeroExitError, NoExitCodeError } from "./index";
import { execOutput } from "./resource";

const encode = (text: string) => new TextEncoder().encode(text);

test("existing text defaults and numeric limits remain byte based; full has no input cap", () => {
  const bytes = encode("x".repeat(20_000));
  expect(outputText(bytes)).toBe("x".repeat(16_384) + "…");
  expect(outputText(bytes, undefined)).toBe(outputText(bytes));
  expect(outputText(bytes, 4)).toBe("xxxx…");
  expect(outputText(bytes, 1_048_576)).toBe("x".repeat(20_000));
  expect(outputText(bytes, { full: true })).toBe("x".repeat(20_000));
  const large = encode("y".repeat(1_048_577));
  expect(outputText(large, { full: true })).toBe("y".repeat(1_048_577));
  expect(outputText(large, 1_048_576)).toBe("y".repeat(1_048_576) + "…");
});

test("each preview reports display shortening independently of capture and literal ellipsis", () => {
  for (const truncated of [false, true]) {
    const result = execOutput(0, encode("abcdef"), encode("…"), truncated);
    expect(result.stdoutPreview({ maxBytes: 3 })).toEqual({ text: "abc…", shortened: true });
    expect(result.stderrPreview({ maxBytes: 3 })).toEqual({ text: "…", shortened: false });
    expect(result.stdoutPreview({ maxBytes: 6 })).toEqual({ text: "abcdef", shortened: false });
    expect(result.stderrPreview({ maxBytes: 0 })).toEqual({ text: "…", shortened: true });
    expect(result.stdoutText({ full: true })).toBe("abcdef");
    expect(result.stderrText({ full: true })).toBe("…");
    expect(result.truncated).toBe(truncated);
  }

  const empty = execOutput(0, new Uint8Array(), new Uint8Array(), true);
  expect(empty.stdoutPreview({ maxBytes: 0 })).toEqual({ text: "", shortened: false });
  expect(empty.stderrPreview()).toEqual({ text: "", shortened: false });
  expect(outputText(empty.stdout, 0)).toBe("");
  expect(empty.stdoutText({ full: true })).toBe("");
  expect(empty.stderrText({ full: true })).toBe("");
  const long = execOutput(0, encode("a".repeat(16_385)), encode("b".repeat(16_385)), false);

  for (const preview of [
    long.stdoutPreview(),
    long.stderrPreview(undefined),
    long.stdoutPreview({}),
  ]) {
    expect(preview.shortened).toBe(true);
    expect(preview.text.length).toBe(16_385);
  }
});

test("UTF-8 replacement, byte boundaries, and BOM handling match the standard decoder", () => {
  const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0xff, 0xe2, 0x82);
  const before = bytes.slice();
  const result = execOutput(7, bytes, bytes, true);
  expect(result.stdoutText({ full: true })).toBe("é��");
  expect(result.stderrText({ full: true })).toBe("é��");
  expect(result.stdoutPreview({ maxBytes: 4 })).toEqual({ text: "�…", shortened: true });
  expect(result.stderrPreview({ maxBytes: 3 })).toEqual({ text: "…", shortened: true });
  expect(result.stdoutText(2)).toBe("�…");
  expect(bytes).toEqual(before);
  expect(result.stdout).toBe(bytes);
  expect(result.stderr).toBe(bytes);
  expect(result.exitCode).toBe(7);
  expect(result.truncated).toBe(true);
});

test("invalid numeric limits and JavaScript option objects throw only local RangeErrors", () => {
  const result = execOutput(0, encode("ok"), encode("error"), false);
  const limits = [-1, 1.5, NaN, Infinity, 1_048_577, Number.MAX_SAFE_INTEGER + 1, "2", null];

  for (const maxBytes of limits) {
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => outputText(result.stdout, maxBytes as never)).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stdoutText(maxBytes as never)).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stderrText(maxBytes as never)).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stdoutPreview({ maxBytes: maxBytes as never })).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stderrPreview({ maxBytes: maxBytes as never })).toThrow(RangeError);
  }

  const hidden = Object.defineProperty({ full: true }, "extra", { value: 1 });

  for (const options of [
    null,
    {},
    [],
    new Date(),
    true,
    "full",
    { full: false },
    { full: 1 },
    { full: true, maxBytes: 1 },
    { full: true, extra: true },
    { full: true, [Symbol()]: 1 },
    hidden,
    Object.create({ full: true }),
  ]) {
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => outputText(result.stdout, options as never)).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stdoutText(options as never)).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stderrText(options as never)).toThrow(RangeError);
  }

  for (const options of [
    null,
    4,
    [],
    new Date(),
    { full: true },
    { maxBytes: 2, extra: 1 },
    { [Symbol()]: 1 },
    Object.create({ maxBytes: 2 }),
  ]) {
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stdoutPreview(options as never)).toThrow(RangeError);
    // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
    expect(() => result.stderrPreview(options as never)).toThrow(RangeError);
  }

  expect(result.stdoutPreview({ maxBytes: undefined })).toEqual({ text: "ok", shortened: false });
  expect(result.stdoutText()).toBe("ok");
  expect(result.exitCode).toBe(0);
  expect(result.truncated).toBe(false);
});

test.each([0, 7, null])(
  "normal and fresh-client recovered results share helpers (exit %s)",
  async (exitCode) => {
    let submits = 0;
    const stdout = encode("x".repeat(20_000));
    const stderr = encode("diagnostic");

    const adapter = defineAdapter({
      name: "example.output",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: {
            images: ["prepared"],
            network: ["blocked"],
            exec: { commands: ["argv"], maxOutputBytes: 1_048_576 },
          },
          async create() {
            return { id: "box", state: "running" as const };
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
          exec: {
            recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
            async submit(_input, ctx) {
              submits++;

              return ctx.pending({ jobId: "job" }, { pollAfterMs: 1 });
            },
            async observe() {
              return { exitCode, stdout, stderr, truncated: false };
            },
          },
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
    const fresh = await Sandbar.connect({ adapter, config: {}, credentials: {} });

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await box.submitExec(["fixture"]);
      const recovered = await fresh.recover(JSON.parse(JSON.stringify(operation.reference)));

      for (const observed of [operation, recovered]) {
        let result;

        try {
          result = await observed.wait();
        } catch (error) {
          expect(error).toBeInstanceOf(exitCode === null ? NoExitCodeError : NonzeroExitError);

          if (!(error instanceof NoExitCodeError || error instanceof NonzeroExitError)) throw error;
          expect(error.effect).toBe("applied");
          result = error.result;
        }

        expect(result).toMatchObject({ exitCode, truncated: false });
        expect(result.stdoutText({ full: true })).toBe("x".repeat(20_000));
        expect(result.stdoutPreview()).toEqual({ text: "x".repeat(16_384) + "…", shortened: true });
        expect(result.stderrPreview()).toEqual({ text: "diagnostic", shortened: false });
        // SAFETY: Deliberately bypass the public type to test malformed JavaScript input.
        expect(() => result.stdoutText({ full: false } as never)).toThrow(RangeError);
        expect(result.exitCode).toBe(exitCode);
      }

      expect(submits).toBe(1);
    } finally {
      await client.close();
      await fresh.close();
    }
  },
);
