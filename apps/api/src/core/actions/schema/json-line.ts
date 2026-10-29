/** Undefined for a line that is null or not JSON. */
export function parseJsonLine(line: string | null): unknown {
  if (line === null) {
    return undefined;
  }

  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
