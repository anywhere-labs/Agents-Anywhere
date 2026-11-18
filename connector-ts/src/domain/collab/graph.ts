/** A supervision edge by session id (session ids are unique per account, so the device does not matter here). */
export interface Edge {
  readonly supervisor: string
  readonly target: string
}

/** Whether adding `edge` to the active edges closes a cycle (the target already reaches the supervisor). */
export function wouldCycle(edges: readonly Edge[], edge: Edge): boolean {
  if (edge.supervisor === edge.target) return true
  const next = new Map<string, string[]>()
  for (const { supervisor, target } of edges) next.set(supervisor, [...(next.get(supervisor) ?? []), target])
  const seen = new Set<string>()
  const stack = [edge.target]
  while (stack.length > 0) {
    const node = stack.pop() as string
    if (node === edge.supervisor) return true
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...(next.get(node) ?? []))
  }
  return false
}
