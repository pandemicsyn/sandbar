import { usage } from "./output";

const durationUnits = new Map([
  ["", 1],
  ["s", 1],
  ["m", 60],
  ["h", 3600],
]);

/** `90`, `90s`, `30m` or `2h` as whole seconds. */
export function parseDuration(value: string, flag: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
  const seconds = match ? Number(match[1]) * (durationUnits.get(match[2] ?? "") ?? 1) : NaN;

  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw usage(`--${flag} must be a duration like 90s, 30m or 2h`);

  return seconds;
}

const sizeUnits = new Map([
  ["", 1],
  ["b", 1],
  ["k", 1024],
  ["m", 1024 ** 2],
  ["g", 1024 ** 3],
]);

/** `4096`, `512k`, `1m` or `2g` as bytes. */
export function parseSize(value: string, flag: string): number {
  const match = /^(\d+)(b|k|m|g)?$/i.exec(value.trim());

  const bytes = match
    ? Number(match[1]) * (sizeUnits.get((match[2] ?? "").toLowerCase()) ?? 1)
    : NaN;

  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw usage(`--${flag} must be a size like 4096, 512k or 1m`);

  return bytes;
}

/** Repeated `KEY=VALUE` flags as a record. */
export function parsePairs(values: readonly string[], flag: string) {
  const pairs = values.map((value) => {
    const index = value.indexOf("=");

    if (index <= 0) throw usage(`--${flag} expects KEY=VALUE, got ${value}`);

    return [value.slice(0, index), value.slice(index + 1)] as const;
  });

  return Object.fromEntries(pairs);
}
