import { z } from "zod";

/** The portable sandbox lifetime when setup leaves `lifecycle.lifetimeSeconds` out: 15 minutes. */
export const DEFAULT_LIFETIME_SECONDS = 900;

/** The portable default, lowered to an adapter's maximum so it always works. */
export function defaultLifetime(maxSeconds: number): number {
  return Math.min(DEFAULT_LIFETIME_SECONDS, maxSeconds);
}

/** The lifetimes a connection accepts per create, in whole seconds. */
export const LifetimeLimits = z.strictObject({
  minSeconds: z.number().int().positive().safe(),
  maxSeconds: z.number().int().positive().safe(),
});

export type LifetimeLimits = z.infer<typeof LifetimeLimits>;

/** Why a per-create lifetime cannot be applied, or null when it can. Never rounds down. */
export function lifetimeProblem(
  limits: LifetimeLimits | undefined,
  seconds: number | undefined,
): string | null {
  if (seconds === undefined) return null;

  if (!limits) return "A per-create lifetime is unsupported by this adapter";

  if (seconds < limits.minSeconds || seconds > limits.maxSeconds)
    return `Lifetime ${seconds}s is outside this adapter's range of ${limits.minSeconds}-${limits.maxSeconds} seconds`;

  return null;
}
