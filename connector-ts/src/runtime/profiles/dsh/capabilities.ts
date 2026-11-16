/**
 * AA capabilities of a DSH runtime, by route (04-connector.md §5.1, §5.6). Capability-driven
 * clients hide what a route cannot do; nothing here keys on the provider name alone.
 */
import type * as acp from '@agentclientprotocol/sdk'
import type { DshAgentMeta } from '../../../generated/dsh-bridge/v3_0/agent-meta.js'
import type { RuntimeCapabilities } from './port.js'

export type DshRoute = 'plugin' | 'direct'

/** The capability IDs DSH has ever reported, so absent ones are reported as unsupported. */
export const DSH_CAPABILITY_IDS = [
  'runtime.config', 'session.send_message', 'session.interrupt', 'session.steer', 'session.queue',
  'session.interaction.approval', 'session.interaction.question', 'session.continue', 'catalog.model', 'catalog.permission',
  'catalog.effort', 'session.commands', 'runtime.attachment', 'session.planning',
] as const

const on = (metadata?: Record<string, unknown>) => ({ supported: true, available: true, ...(metadata ? { metadata } : {}) })
const off = (reason: string) => ({ supported: false, available: false, metadata: { unavailableReason: reason } })

/**
 * Direct route: DSH's automation ACP. No queue (Connector queues locally), no continue,
 * plan, questions, steer, commands or permission presets; images only when advertised.
 */
export function directCapabilities(init: acp.InitializeResponse, configOptions: readonly acp.SessionConfigOption[] = []): RuntimeCapabilities {
  const reason = 'DSH 未在本机运行，这项功能需要打开 DSH Desktop（并安装 Agents Anywhere 插件）。'
  const ids = new Set(configOptions.map(option => option.id))
  const image = init.agentCapabilities?.promptCapabilities?.image === true
  return {
    'runtime.config': on({ route: 'direct' }),
    'session.send_message': on(),
    'session.interrupt': on(),
    // Each session accepts one prompt at a time; the Connector holds later ones (§5.8).
    'session.queue': on({ owner: 'connector' }),
    'session.interaction.approval': on({ persistentGrants: false }),
    'catalog.model': ids.has('model') ? on() : off('DSH 没有返回模型目录。'),
    'catalog.effort': ids.has('reasoning_effort') ? on() : off('当前模型没有推理强度选项。'),
    'runtime.attachment': image ? on({ allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }) : off(reason),
    'session.steer': off(reason),
    'session.interaction.question': off(reason),
    'session.continue': off(reason),
    'catalog.permission': off(reason),
    'session.commands': off(reason),
    'session.planning': off(reason),
  }
}

/** Plugin route: what the host's `features` table allows (contracts/dsh-bridge/3.0 §2). */
export function pluginCapabilities(meta: DshAgentMeta, init: acp.InitializeResponse, configOptions: readonly acp.SessionConfigOption[] = []): RuntimeCapabilities {
  const f = meta.features
  const ids = new Set(configOptions.map(option => option.id))
  const reason = '当前 DSH 版本或配置不支持这项功能。'
  return {
    'runtime.config': on({ route: 'plugin', hostInstance: meta.hostInstance, dshVersion: meta.dshVersion }),
    'session.send_message': on(),
    'session.interrupt': on(),
    'session.queue': f.queue ? on({ owner: 'runtime' }) : on({ owner: 'connector' }),
    'session.steer': f.steer ? on() : off(reason),
    'session.interaction.approval': on({ persistentGrants: false }),
    'session.interaction.question': f.questions ? on() : off(reason),
    'session.continue': f.continue ? on() : off(reason),
    'catalog.model': ids.has('model') ? on() : off('DSH 没有返回模型目录。'),
    'catalog.effort': ids.has('reasoning_effort') ? on() : off('当前模型没有推理强度选项。'),
    'catalog.permission': f.permissionPresets && ids.has('permission') ? on() : off(reason),
    'session.commands': off('DSH 命令尚未接入 3.0 插件。'),
    'runtime.attachment': init.agentCapabilities?.promptCapabilities?.image || f.fileUploads
      ? on({ images: init.agentCapabilities?.promptCapabilities?.image === true, files: f.fileUploads }) : off(reason),
    'session.planning': f.planning ? on({ nativePlanningAvailable: true }) : off(reason),
  }
}
