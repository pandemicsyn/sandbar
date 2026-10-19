import { expect, test } from "bun:test";
import { AdapterError } from "./errors";
import { ResourceMinimums, smallestSize } from "./sizing";

const sizes = [
  { name: "s", vcpus: 1, memoryMiB: 2048 },
  { name: "m", vcpus: 2, memoryMiB: 4096 },
  { name: "l", vcpus: 4, memoryMiB: 8192 },
];

test("smallestSize rounds each minimum up and never down", () => {
  expect(smallestSize("fixture", sizes, {}).name).toBe("s");
  expect(smallestSize("fixture", sizes, { vcpus: 1.5 }).name).toBe("m");
  expect(smallestSize("fixture", sizes, { vcpus: 1, memoryMiB: 4097 }).name).toBe("l");

  const error = (() => {
    try {
      return smallestSize("fixture", sizes, { vcpus: 8 });
    } catch (cause) {
      return cause;
    }
  })();

  expect(error).toBeInstanceOf(AdapterError);
  expect(error).toMatchObject({
    code: "UNSUPPORTED",
    message: "fixture has no size with at least 8 vCPU; its largest is 4 vCPU / 8192 MiB",
  });
});

test("resource minimums are positive, bounded and strict", () => {
  for (const value of [{ vcpus: 0 }, { memoryMiB: 1.5 }, { memoryMiB: -1 }, { disk: 1 }])
    expect(ResourceMinimums.safeParse(value).success).toBe(false);
  expect(ResourceMinimums.parse({ vcpus: 0.25, memoryMiB: 512 })).toEqual({
    vcpus: 0.25,
    memoryMiB: 512,
  });
});
