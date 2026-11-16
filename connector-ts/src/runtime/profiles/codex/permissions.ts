// Codex 权限目录：沿用 v2 codex/domain/catalogs.py `codex_permission_catalog_items` 的条目、selection ID 与 i18n，
// 落到 codex-acp 的 `mode` 预设（src/AgentMode.ts）上。

import type { ConfigOption } from '../../../application/ports/runtime-session.js'
import { codexPermissionSelectionId } from '../../../domain/identity/index.js'
import type { ProtocolPermissionItem } from '../../../generated/protocol/v1_2/permission-catalog-response.js'

interface CodexPermission {
  readonly id: string
  /** codex-acp `mode` 预设。 */
  readonly mode: string
  readonly label: string
  readonly description: string
  readonly i18nKey: string
  readonly nativeSettings: Record<string, unknown>
}

export const CODEX_PERMISSIONS: readonly CodexPermission[] = [
  {
    id: 'request_approval', mode: 'workspace-write', label: 'Request approval', i18nKey: 'requestApproval',
    description: 'Always ask before editing files outside the workspace or using the internet.',
    nativeSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } },
  },
  {
    id: 'auto_review', mode: 'agent', label: 'Auto review', i18nKey: 'autoReview',
    description: 'Only ask for approval when Codex detects a risky operation.',
    nativeSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } },
  },
  {
    id: 'full_access', mode: 'agent-full-access', label: 'Full access', i18nKey: 'fullAccess',
    description: 'Allow unrestricted internet access and access to any file on this computer.',
    nativeSettings: { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
  },
]

/** codex-acp `mode` 值 → v2 权限 selection ID（read-only 等 v2 没有的预设用自身 ID）。 */
export function codexPermissionSelectionForMode(mode: string): string {
  const permission = CODEX_PERMISSIONS.find(p => p.mode === mode)
  return permission ? codexPermissionSelectionId(permission.id, { permission_mode: permission.id }) : codexPermissionSelectionId(mode)
}

export function codexPermissionCatalog(config: readonly ConfigOption[]): ProtocolPermissionItem[] {
  const offered = config.find(o => o.category === 'permission' && o.type === 'select')?.values?.map(v => v.value)
  return CODEX_PERMISSIONS.filter(p => offered === undefined || offered.includes(p.mode)).map(p => ({
    id: p.id,
    displayName: p.label,
    description: p.description,
    default: false,
    selectionId: codexPermissionSelectionId(p.id, { permission_mode: p.id }),
    metadata: {
      source: 'codex.static-permissions',
      runtimeSettings: { permissionMode: p.id },
      nativeSettings: p.nativeSettings,
      i18n: { labelKey: `dashboard.new.permissionModes.${p.i18nKey}.label`, descriptionKey: `dashboard.new.permissionModes.${p.i18nKey}.description` },
    },
  }))
}
