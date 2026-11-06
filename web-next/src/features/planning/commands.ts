export function parsePlanningCommand(text: string): { command: 'enter_plan' | 'exit_plan' | 'submit_task'; content?: string } | null {
  const value = text.trimStart()
  if (!value.startsWith('/plan') || (value.length > 5 && !/\s/.test(value.charAt(5)))) return null
  const suffix = value.slice(5)
  if (!suffix.trim()) return { command: 'enter_plan' }
  if (suffix.trim() === 'off') return { command: 'exit_plan' }
  return { command: 'submit_task', content: suffix.slice(suffix.startsWith('\r\n') ? 2 : 1) }
}
