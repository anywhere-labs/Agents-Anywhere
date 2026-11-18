// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/preparations.py @98dd0e6e5 (SessionPreparation)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/configuration.py @98dd0e6e5 (merge_legacy, validate)
//
// Workspace preparation for ACP sessions: session/new runs in the directory at preparation time and the options
// and catalog are read from that session. The creation opens nothing new: it switches the session to the AA
// session id, applies the frozen selections and configuration, and hands the same session to the session engine.

import type {
  Catalogs,
  ConfigOption,
  FrozenCreation,
  PreparedSession,
  RuntimeError,
  RuntimeSession,
} from '../../application/ports/runtime-session.js'
import { choiceError, findOption, selectionsToConfig } from './config.js'
import type { SelectionCodec } from './dialect.js'
import { RuntimeFailure } from './errors.js'
import { runtimeError } from './session.js'

/** A session that can be prepared: the Agent created it, its options are known and its AA session id can still change. */
export interface PreparableSession extends RuntimeSession {
  readonly configOptions: readonly ConfigOption[]
  readonly planningOptionId: string | null
  rebind(sessionId: string): void
}

/**
 * The option changes of a first message: the configuration first, then each selection mapped to
 * the single option of its category. Different values for the same option are a conflict; a value outside the
 * option's choices is invalid.
 */
export function creationChanges(config: readonly ConfigOption[], frozen: FrozenCreation, codec?: SelectionCodec): Array<{ optionId: string; value: string | boolean }> {
  const merged = new Map<string, string | boolean>()
  for (const [optionId, value] of Object.entries(frozen.configuration)) {
    if (findOption(config, optionId) === undefined) throw new RuntimeFailure({ code: 'configuration_changed', message: '配置选项已不可用。' })
    if (choiceError(config, optionId, value) !== undefined) throw new RuntimeFailure({ code: 'invalid_configuration_value', message: '配置值不在当前可用范围。' })
    merged.set(optionId, value)
  }
  for (const change of selectionsToConfig(config, frozen.selections, codec)) {
    const existing = merged.get(change.optionId)
    if (existing !== undefined && existing !== change.value) throw new RuntimeFailure({ code: 'configuration_conflict', message: '旧选择与通用配置不一致。' })
    merged.set(change.optionId, change.value)
  }
  return [...merged].map(([optionId, value]) => ({ optionId, value }))
}

export interface PreparedOptions {
  readonly catalogs: () => Promise<Catalogs>
  readonly codec?: SelectionCodec
  /** Whether plan mode can be entered before the first message; by default, whether the session has a plan mode switch. */
  readonly canPlan?: boolean
}

/** Wraps a session the Agent just created as a `PreparedSession`. */
export function preparedSession(session: PreparableSession, options: PreparedOptions): PreparedSession {
  let adopted = false
  return {
    get nativeSessionId() {
      return session.nativeSessionId
    },
    get configOptions() {
      return session.configOptions
    },
    get planningOptionId() {
      return session.planningOptionId
    },
    get canPlan() {
      return options.canPlan ?? (session.planning !== undefined && session.planningOptionId !== null)
    },
    catalogs: options.catalogs,
    events: session.events,
    respond: async (interactionId, answer) => {
      await session.respond(interactionId, answer)
    },
    check(frozen): RuntimeError | null {
      try {
        creationChanges(session.configOptions, frozen, options.codec)
        return null
      } catch (error) {
        return runtimeError(error, 'invalid_configuration_value')
      }
    },
    async adopt(sessionId, frozen) {
      if (adopted) throw new RuntimeFailure({ code: 'preparation_consumed', message: 'the prepared session was already adopted' })
      adopted = true
      session.rebind(sessionId)
      try {
        for (const change of creationChanges(session.configOptions, frozen, options.codec)) {
          if (findOption(session.configOptions, change.optionId)?.currentValue === change.value) continue
          await session.configure(change)
        }
      } catch (error) {
        await session.close().catch(() => undefined)
        throw error
      }
      return session
    },
    close: () => session.close(),
  }
}

/**
 * Whether a failed preparation definitely never reached the Agent (it failed before the launch, or authentication
 * was refused), as `details.definite` of the error; the use case records failed or outcome_unknown from it.
 */
export function prepareFailure(error: unknown, definite: boolean): RuntimeFailure {
  const reported = runtimeError(error, 'agent_open_failed')
  const sure = definite || reported.code === 'runtime_auth_required' || reported.code === 'agent_authentication_required'
  return new RuntimeFailure({ ...reported, details: { ...(reported.details ?? {}), definite: sure } })
}
