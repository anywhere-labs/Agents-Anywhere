export type ComposerAction = "submit" | "interrupt"

export function resolveComposerActions({
  hasInput,
  canInterruptActiveTurn,
}: {
  hasInput: boolean
  canInterruptActiveTurn: boolean
}): { button: ComposerAction; enter: "submit" } {
  return {
    button: !hasInput && canInterruptActiveTurn ? "interrupt" : "submit",
    enter: "submit",
  }
}
