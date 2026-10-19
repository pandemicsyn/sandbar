import { z } from "zod";
import { AdapterError } from "./errors";

/**
 * Portable sandbox size, given as minimums. An adapter picks the smallest native size that meets
 * every minimum, rejects when none does, and reports the size it actually used.
 */
export const ResourceMinimums = z.strictObject({
  vcpus: z.number().positive().finite().max(1024).optional(),
  memoryMiB: z.number().int().positive().max(16_777_216).optional(),
});

export type ResourceMinimums = z.infer<typeof ResourceMinimums>;

/** A concrete native size: whole vCPUs (fractional where the provider allows) and MiB of memory. */
export type SandboxResources = { vcpus: number; memoryMiB: number };

export function meetsMinimums(size: SandboxResources, minimums: ResourceMinimums = {}): boolean {
  return (
    (minimums.vcpus === undefined || size.vcpus >= minimums.vcpus) &&
    (minimums.memoryMiB === undefined || size.memoryMiB >= minimums.memoryMiB)
  );
}

export function describeResources(minimums: ResourceMinimums): string {
  const parts = [
    ...(minimums.vcpus === undefined ? [] : [`${minimums.vcpus} vCPU`]),
    ...(minimums.memoryMiB === undefined ? [] : [`${minimums.memoryMiB} MiB`]),
  ];

  return parts.join(" / ") || "no minimums";
}

/**
 * The smallest listed size that meets the minimums. Sizes must be listed smallest first. Throws
 * UNSUPPORTED naming the largest size when none is big enough, so nothing is ever rounded down.
 */
export function smallestSize<T extends SandboxResources>(
  provider: string,
  sizes: readonly T[],
  minimums: ResourceMinimums,
): T {
  const size = sizes.find((value) => meetsMinimums(value, minimums));

  if (size) return size;
  const largest = sizes.at(-1);

  throw new AdapterError(
    "UNSUPPORTED",
    `${provider} has no size with at least ${describeResources(minimums)}${
      largest ? `; its largest is ${describeResources(largest)}` : ""
    }`,
  );
}
