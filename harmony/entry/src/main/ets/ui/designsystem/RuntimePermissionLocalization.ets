import { RuntimePermissionTranslation } from '../../feature/sessiondetail/RuntimePermissionTranslation';

/**
 * Resource mapping for the runtime permission modes.
 *
 * Port of `ui/designsystem/RuntimePermissionLocalization.kt`.
 *
 * Android builds a `Map<RuntimePermissionTranslation, LocalizedRuntimePermission>`
 * once per composition and looks a mode up by kind. ArkTS cannot hold string
 * resources in a data structure that is built outside a component, so the map is
 * expressed as two functions that each return a literal `$r(...)` reference. The
 * behaviour is the same: a recognised mode gets the client's own copy, its
 * description is used only when it has one, and an unrecognised mode keeps
 * whatever the Server sent.
 */

/**
 * The client's label for a mode, or `null` to keep the Server's label.
 *
 * The mode label always wins over the Server's text, which is the point of the
 * translation: the Server's copy is English and does not match the client's.
 */
export function runtimePermissionLabelResource(
  translation: RuntimePermissionTranslation | null,
): Resource | null {
  if (translation === RuntimePermissionTranslation.DshReadOnly) {
    return $r('app.string.runtime_permission_dsh_read_only');
  }
  if (translation === RuntimePermissionTranslation.DshWorkspaceWrite) {
    return $r('app.string.runtime_permission_dsh_workspace_write');
  }
  if (translation === RuntimePermissionTranslation.DshFullAccess) {
    return $r('app.string.runtime_permission_dsh_full_access');
  }
  if (translation === RuntimePermissionTranslation.RequestApproval) {
    return $r('app.string.runtime_permission_request_approval');
  }
  if (translation === RuntimePermissionTranslation.AutoReview) {
    return $r('app.string.runtime_permission_auto_review');
  }
  if (translation === RuntimePermissionTranslation.FullAccess) {
    return $r('app.string.runtime_permission_full_access');
  }
  if (translation === RuntimePermissionTranslation.ClaudeDefault) {
    return $r('app.string.runtime_permission_claude_default');
  }
  if (translation === RuntimePermissionTranslation.ClaudeAcceptEdits) {
    return $r('app.string.runtime_permission_claude_accept_edits');
  }
  if (translation === RuntimePermissionTranslation.ClaudePlan) {
    return $r('app.string.runtime_permission_claude_plan');
  }
  if (translation === RuntimePermissionTranslation.ClaudeAuto) {
    return $r('app.string.runtime_permission_claude_auto');
  }
  if (translation === RuntimePermissionTranslation.ClaudeDontAsk) {
    return $r('app.string.runtime_permission_claude_dont_ask');
  }
  if (translation === RuntimePermissionTranslation.ClaudeBypassPermissions) {
    return $r('app.string.runtime_permission_claude_bypass_permissions');
  }
  return null;
}

/**
 * The client's description for a mode, or `null` when the Server's text stands.
 *
 * The DSH presets have no description of their own, which is why Android's map
 * stores `null` for them and falls back to the Server's copy.
 */
export function runtimePermissionDescriptionResource(
  translation: RuntimePermissionTranslation | null,
): Resource | null {
  if (translation === RuntimePermissionTranslation.RequestApproval) {
    return $r('app.string.runtime_permission_desc_request_approval');
  }
  if (translation === RuntimePermissionTranslation.AutoReview) {
    return $r('app.string.runtime_permission_desc_auto_review');
  }
  if (translation === RuntimePermissionTranslation.FullAccess) {
    return $r('app.string.runtime_permission_desc_full_access');
  }
  if (translation === RuntimePermissionTranslation.ClaudeDefault) {
    return $r('app.string.runtime_permission_desc_claude_default');
  }
  if (translation === RuntimePermissionTranslation.ClaudeAcceptEdits) {
    return $r('app.string.runtime_permission_desc_claude_accept_edits');
  }
  if (translation === RuntimePermissionTranslation.ClaudePlan) {
    return $r('app.string.runtime_permission_desc_claude_plan');
  }
  if (translation === RuntimePermissionTranslation.ClaudeAuto) {
    return $r('app.string.runtime_permission_desc_claude_auto');
  }
  if (translation === RuntimePermissionTranslation.ClaudeDontAsk) {
    return $r('app.string.runtime_permission_desc_claude_dont_ask');
  }
  if (translation === RuntimePermissionTranslation.ClaudeBypassPermissions) {
    return $r('app.string.runtime_permission_desc_claude_bypass_permissions');
  }
  return null;
}
