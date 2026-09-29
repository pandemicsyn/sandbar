export function freezeReference<T extends object>(value: T): T {
  for (const child of Object.values(value))
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parsed recovery references contain only bounded JSON containers and scalar values.
    if (child !== null && typeof child === "object") freezeReference(child);

  return Object.freeze(value);
}
