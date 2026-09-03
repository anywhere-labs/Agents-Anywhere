export function logArchiveDebug(
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (process.env.NODE_ENV === "production") return
  console.info(`[archive-debug] ${event}`, details)
}
