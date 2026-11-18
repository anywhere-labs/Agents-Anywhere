import type { GoalAction, GoalObservation, GoalStatus } from '../../domain/goals/index.js'
import { asRecord } from './client.js'

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function goalStatus(value: unknown): GoalStatus | undefined {
  switch (value) {
    case 'active':
    case 'paused':
    case 'blocked':
    case 'usageLimited':
    case 'budgetLimited':
    case 'complete':
    case 'failed':
    case 'cleared':
    case 'replaced':
      return value
    case 'limited':
      return 'usageLimited'
    default:
      return undefined
  }
}

export function parseGoalObservation(
  snapshot: unknown,
  actions?: readonly GoalAction[],
  confirmedEmpty = false,
): GoalObservation | null {
  const capability = actions === undefined ? {} : { actions }
  if (snapshot === null) return { ...capability, goal: null, empty: true, ...(confirmedEmpty ? { outcome: 'cleared' } : {}) }
  const native = asRecord(snapshot)
  const status = goalStatus(native.status)
  if (typeof native.objective !== 'string' || !native.objective.trim() || status === undefined) return null
  const createdAt = timestamp(native.createdAt)
  const updatedAt = timestamp(native.updatedAt)
  return {
    ...capability,
    empty: false,
    goal: {
      objective: native.objective,
      status,
      ...(typeof native.id === 'string' ? { nativeIdentity: native.id } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(typeof native.tokenBudget === 'number' ? { tokenBudget: native.tokenBudget } : {}),
      ...(typeof native.tokensUsed === 'number' ? { tokensUsed: native.tokensUsed } : {}),
      ...(typeof native.timeUsedSeconds === 'number' ? { timeUsedSeconds: native.timeUsedSeconds } : {}),
    },
  }
}
