// Normalize command output for terminal-style rendering.
export function normalizeCommandOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.includes("\r")) return normalized;
  return normalized
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}
