/**
 * Runtime permission mode translation.
 *
 * Port of `RuntimePermissionTranslation` and `runtimePermissionTranslation` in
 * `feature/sessiondetail/SessionRuntimeState.kt`.
 *
 * The Server returns permission modes with English labels. For the modes the
 * client has its own copy for, the client substitutes its own localized label;
 * everything else keeps the Server's text. The decision is returned as a *kind*
 * rather than as a string so the resource reference stays a literal `$r(...)`
 * call in the UI layer (see `ui/designsystem/RuntimePermissionLocalization`).
 */
export enum RuntimePermissionTranslation {
  RequestApproval = 1,
  AutoReview = 2,
  FullAccess = 3,
  ClaudeDefault = 4,
  ClaudeAcceptEdits = 5,
  ClaudePlan = 6,
  ClaudeAuto = 7,
  ClaudeDontAsk = 8,
  ClaudeBypassPermissions = 9,
  DshReadOnly = 10,
  DshWorkspaceWrite = 11,
  DshFullAccess = 12,
}

/**
 * The mode a permission corresponds to, or `null` to keep the Server's label.
 *
 * `metadata.i18n.labelKey` is the Server's own hint and is preferred over the
 * id, because DSH renames its presets between releases.
 */
export function runtimePermissionTranslation(
  runtime: string | null,
  permissionId: string,
  metadata: Object,
): RuntimePermissionTranslation | null {
  const map: Record<string, Object> = metadata as Record<string, Object>;
  const i18n: Object = map['i18n'];
  let labelKey: string | null = null;
  if (i18n !== undefined && i18n !== null && typeof i18n === 'object') {
    const value: Object = (i18n as Record<string, Object>)['labelKey'];
    labelKey = typeof value === 'string' ? value : null;
  }
  const byLabelKey: RuntimePermissionTranslation | null = translationByLabelKey(labelKey);
  if (byLabelKey !== null) {
    return byLabelKey;
  }

  const normalizedId: string = permissionId.trim().toLowerCase();
  const preset: Object = map['preset'];
  if (runtime !== null && runtime.trim().toLowerCase() === 'dsh') {
    const key: string = typeof preset === 'string' ? preset : normalizedId;
    if (key === 'read-only') {
      return RuntimePermissionTranslation.DshReadOnly;
    }
    if (key === 'workspace-write') {
      return RuntimePermissionTranslation.DshWorkspaceWrite;
    }
    if (key === 'danger-full-access') {
      return RuntimePermissionTranslation.DshFullAccess;
    }
    return null;
  }

  if (normalizedId === 'request_approval') {
    return RuntimePermissionTranslation.RequestApproval;
  }
  if (normalizedId === 'auto_review') {
    return RuntimePermissionTranslation.AutoReview;
  }
  if (normalizedId === 'full_access') {
    return RuntimePermissionTranslation.FullAccess;
  }
  if (runtime !== null && runtime.trim().toLowerCase().includes('claude')) {
    if (normalizedId === 'default') {
      return RuntimePermissionTranslation.ClaudeDefault;
    }
    if (normalizedId === 'acceptedits') {
      return RuntimePermissionTranslation.ClaudeAcceptEdits;
    }
    if (normalizedId === 'plan') {
      return RuntimePermissionTranslation.ClaudePlan;
    }
    if (normalizedId === 'auto') {
      return RuntimePermissionTranslation.ClaudeAuto;
    }
    if (normalizedId === 'dontask') {
      return RuntimePermissionTranslation.ClaudeDontAsk;
    }
    if (normalizedId === 'bypasspermissions') {
      return RuntimePermissionTranslation.ClaudeBypassPermissions;
    }
  }
  return null;
}

function translationByLabelKey(labelKey: string | null): RuntimePermissionTranslation | null {
  if (labelKey === null) {
    return null;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.readOnly.label') {
    return RuntimePermissionTranslation.DshReadOnly;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.workspaceWrite.label') {
    return RuntimePermissionTranslation.DshWorkspaceWrite;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.fullAccess.label') {
    return RuntimePermissionTranslation.DshFullAccess;
  }
  if (labelKey === 'dashboard.new.permissionModes.requestApproval.label') {
    return RuntimePermissionTranslation.RequestApproval;
  }
  if (labelKey === 'dashboard.new.permissionModes.autoReview.label') {
    return RuntimePermissionTranslation.AutoReview;
  }
  if (labelKey === 'dashboard.new.permissionModes.fullAccess.label') {
    return RuntimePermissionTranslation.FullAccess;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.default.label') {
    return RuntimePermissionTranslation.ClaudeDefault;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.acceptEdits.label') {
    return RuntimePermissionTranslation.ClaudeAcceptEdits;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.plan.label') {
    return RuntimePermissionTranslation.ClaudePlan;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.auto.label') {
    return RuntimePermissionTranslation.ClaudeAuto;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.dontAsk.label') {
    return RuntimePermissionTranslation.ClaudeDontAsk;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.bypassPermissions.label') {
    return RuntimePermissionTranslation.ClaudeBypassPermissions;
  }
  return null;
}
