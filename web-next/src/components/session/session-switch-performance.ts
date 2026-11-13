type Phase = "content-committed" | "subscribed" | "messages-recovered" | "runtime-settled"
let navigation: { sessionId: string; at: number } | null = null
let visit = 0
const retainedVisits: string[][] = []

export function markSessionNavigation(sessionId: string) {
  navigation = { sessionId, at: performance.now() }
}

/** Bounded User Timing entries, inspectable in Chromium's Performance panel. */
export function traceSessionSwitch(sessionId: string, cacheHit: boolean) {
  const now = performance.now()
  const started = navigation?.sessionId === sessionId && now - navigation.at < 10_000 ? navigation.at : now
  if (navigation?.sessionId === sessionId) navigation = null
  const visitId = ++visit
  const phases = new Set<Phase>()
  const names: string[] = []
  retainedVisits.push(names)
  if (retainedVisits.length > 50) for (const name of retainedVisits.shift()!) performance.clearMeasures(name)
  return {
    mark(phase: Phase) {
      if (phases.has(phase)) return
      phases.add(phase)
      const name = `aa.session.${visitId}.${phase}`
      names.push(name)
      performance.measure(name, {
        start: started,
        end: performance.now(),
        detail: { sessionId, cacheHit, visitId, phase },
      })
    },
  }
}
