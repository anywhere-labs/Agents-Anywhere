// Claude 的权限目录：沿用 v2 claude/domain/permissions.py 的条目、selection ID 和 i18n 键。

import type { ConfigOption } from '../../../application/ports/runtime-session.js'
import { claudePermissionSelectionId } from '../../../domain/identity/index.js'
import type { ProtocolPermissionItem } from '../../../generated/protocol/v1_2/permission-catalog-response.js'

interface PermissionMode {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly default?: boolean
}

export const CLAUDE_PERMISSION_MODES: readonly PermissionMode[] = [
  { id: 'default', title: 'Ask permissions', description: "Use Claude Code's default prompts for risky tools.", default: true },
  { id: 'acceptEdits', title: 'Accept edits', description: 'Automatically accept file edits; still ask for other risky tools.' },
  { id: 'plan', title: 'Plan mode', description: 'Allow planning without executing writes or commands.' },
  { id: 'auto', title: 'Auto mode', description: "Use Claude Code's automatic classifier for risky actions." },
  { id: 'dontAsk', title: "Don't ask", description: 'Deny unapproved tools instead of asking for permission.' },
  { id: 'bypassPermissions', title: 'Bypass permissions', description: 'Skip permission prompts and allow unrestricted tool use.' },
]

function item(mode: PermissionMode): ProtocolPermissionItem {
  return {
    id: mode.id,
    displayName: mode.title,
    description: mode.description,
    default: mode.default === true,
    selectionId: claudePermissionSelectionId(mode.id),
    metadata: {
      default: mode.default === true,
      identity: { permission_mode: mode.id },
      runtimeSettings: { permissionMode: mode.id },
      nativeSettings: { permissionMode: mode.id },
      i18n: {
        labelKey: `dashboard.new.permissionModes.claude.${mode.id}.label`,
        descriptionKey: `dashboard.new.permissionModes.claude.${mode.id}.description`,
      },
    },
  }
}

/** 已知会话配置时只列出适配器实际提供的模式（claude-agent-acp 0.107 没有 dontAsk）。 */
export function claudePermissionCatalog(config: readonly ConfigOption[]): ProtocolPermissionItem[] {
  const offered = config.find(o => o.category === 'permission' && o.type === 'select')?.values?.map(v => v.value)
  return CLAUDE_PERMISSION_MODES.filter(mode => offered === undefined || offered.includes(mode.id)).map(item)
}
