// Desktop static export (`AA_DESKTOP_EXPORT=1`, see `next.config.ts`): dynamic routes are pre-rendered once for
// a placeholder param and the desktop `app://` protocol serves that page for every concrete id.

export const desktopExport = process.env.NEXT_PUBLIC_AA_DESKTOP_EXPORT === "1"

/** Param value the desktop export pre-renders dynamic routes for. */
export const DESKTOP_EXPORT_PLACEHOLDER = "_"

/** Static params for a dynamic route: the placeholder in the desktop export, none (all on demand) otherwise. */
export function exportPlaceholderParams<K extends string>(...keys: K[]): Record<K, string>[] {
  if (!desktopExport) return []
  return [Object.fromEntries(keys.map((k) => [k, DESKTOP_EXPORT_PLACEHOLDER])) as Record<K, string>]
}
