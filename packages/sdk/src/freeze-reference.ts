export function freezeReference<T extends object>(value: T): T {
  const pending: object[] = [value];

  while (pending.length) {
    const current = pending.pop()!;

    for (const child of Object.values(current))
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parsed recovery references contain only bounded JSON containers and scalar values.
      if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(current);
  }

  return value;
}
