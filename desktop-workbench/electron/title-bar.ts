export function validateTitleBarColors(input: unknown): { color: string; symbolColor: string } {
  if (!input || typeof input !== "object") throw new Error("Invalid title bar colors.");
  const { color, symbolColor } = input as Record<string, unknown>;
  if (typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color)
    || typeof symbolColor !== "string" || !/^#[\da-f]{6}$/i.test(symbolColor)) {
    throw new Error("Invalid title bar colors.");
  }
  return { color, symbolColor };
}
