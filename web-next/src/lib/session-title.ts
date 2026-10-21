// Mirrors the server's DERIVED_SESSION_TITLE_MAX_CHARS so the optimistic
// sidebar entry shows the same title the server will store.
export const SESSION_TITLE_MAX_CHARS = 48

/** Collapse whitespace and cap a first prompt so it can serve as a session title. */
export function sessionTitleFromPrompt(prompt: string): string | null {
  const collapsed = prompt.split(/\s+/).filter(Boolean).join(" ")
  if (!collapsed) return null
  if (collapsed.length <= SESSION_TITLE_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, SESSION_TITLE_MAX_CHARS).trimEnd()}...`
}
