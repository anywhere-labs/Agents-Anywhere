/**
 * What a supervisor may do on a person's behalf (docs/agent-collaboration.md, AC8). The default allows steering and
 * closing sessions the supervisor itself created; everything else is opt-in.
 */
export interface Authority {
  readonly steer: boolean
  readonly interrupt: boolean
  readonly respondApproval: boolean
  readonly reviewPlan: boolean
  readonly close: boolean
}

export const DEFAULT_AUTHORITY: Authority = Object.freeze({ steer: true, interrupt: false, respondApproval: false, reviewPlan: false, close: true })

export const NO_AUTHORITY: Authority = Object.freeze({ steer: false, interrupt: false, respondApproval: false, reviewPlan: false, close: false })

/**
 * How much the supervisor session may do by itself, read from its own permission setting:
 * - `readonly`: it may not change anything, so it may not change another session either;
 * - `ask`: every write needs a person, so it may not answer another session's approvals;
 * - `auto` / `full`: the granted authority applies as is.
 */
export type PermissionLevel = 'readonly' | 'ask' | 'auto' | 'full'

/** Each flag on only when both sides allow it. */
export function intersect(a: Authority, b: Authority): Authority {
  return {
    steer: a.steer && b.steer,
    interrupt: a.interrupt && b.interrupt,
    respondApproval: a.respondApproval && b.respondApproval,
    reviewPlan: a.reviewPlan && b.reviewPlan,
    close: a.close && b.close,
  }
}

/** The authority left once the supervisor's own permission level caps it (invariant: never more than it has itself). */
export function capByPermission(authority: Authority, level: PermissionLevel): Authority {
  if (level === 'readonly') return NO_AUTHORITY
  if (level === 'ask') return { ...authority, respondApproval: false }
  return authority
}

/**
 * The permission level of a permission selection id. Runtimes name their modes differently, so this reads the
 * common words; an unknown id is `ask`, the cautious middle.
 */
export function permissionLevelOf(selectionId: string | null | undefined): PermissionLevel {
  const id = (selectionId ?? '').toLowerCase()
  if (id === '') return 'ask'
  if (/(read[-_]?only|^plan$|:plan$|readonly)/u.test(id)) return 'readonly'
  if (/(bypass|full[-_]?access|yolo|danger)/u.test(id)) return 'full'
  if (/(^auto$|:auto$|accept[-_]?edits|workspace[-_]?write|^agent$|:agent$)/u.test(id)) return 'auto'
  return 'ask'
}

export function parseAuthority(value: unknown, fallback: Authority = DEFAULT_AUTHORITY): Authority {
  if (value === null || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  const flag = (key: keyof Authority): boolean => (typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback[key])
  return { steer: flag('steer'), interrupt: flag('interrupt'), respondApproval: flag('respondApproval'), reviewPlan: flag('reviewPlan'), close: flag('close') }
}
