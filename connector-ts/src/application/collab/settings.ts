import { type Authority, DEFAULT_AUTHORITY, parseAuthority } from '../../domain/collab/index.js'
import type { CollabInstanceSettings, CollabSettings } from '../ports/collab.js'

/** Collaboration is off until the account and the runtime instance both turn it on (AC10). */
export const COLLAB_OFF: CollabSettings = Object.freeze({ enabled: false, crossDevice: false, instances: {} })

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** `deviceSettings.agentCollaboration` as the Server pushes it; anything malformed reads as off. */
export function parseCollabSettings(deviceSettings: unknown): CollabSettings {
  const raw = record(record(deviceSettings).agentCollaboration)
  const instances: Record<string, CollabInstanceSettings> = {}
  for (const [runtimeId, value] of Object.entries(record(raw.instances))) {
    const item = record(value)
    instances[runtimeId] = {
      enabled: item.enabled === true,
      crossDevice: item.crossDevice === true,
      authority: parseAuthority(item.authority, DEFAULT_AUTHORITY),
    }
  }
  return { enabled: raw.enabled === true, crossDevice: raw.crossDevice === true, instances }
}

export interface EffectiveSettings {
  readonly enabled: boolean
  readonly crossDevice: boolean
  readonly authority: Authority
}

/** What one runtime instance may do: on only when the account and the instance are on. */
export function effectiveFor(settings: CollabSettings, runtimeId: string): EffectiveSettings {
  const instance = settings.instances[runtimeId]
  const enabled = settings.enabled && instance?.enabled === true
  return {
    enabled,
    crossDevice: enabled && settings.crossDevice && instance?.crossDevice === true,
    authority: instance?.authority ?? DEFAULT_AUTHORITY,
  }
}

/** The latest settings, replaced whenever the Server pushes device settings. */
export class CollabSettingsHolder {
  private current: CollabSettings = COLLAB_OFF
  private readonly listeners = new Set<(settings: CollabSettings) => void>()

  public get(): CollabSettings {
    return this.current
  }

  public apply(deviceSettings: unknown): void {
    this.current = parseCollabSettings(deviceSettings)
    for (const listener of this.listeners) listener(this.current)
  }

  public onChange(listener: (settings: CollabSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
