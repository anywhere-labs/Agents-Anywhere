import { objGetOptString, objGetRecord } from './Json';

// Localized labels and descriptions for the known runtime permission presets.
// Mirrors Android RuntimePermissionLocalizer: values come from
// runtime_permission_* string resources supplied by the caller.
export interface RuntimePermissionStrings {
  dshReadOnly: string;
  dshWorkspaceWrite: string;
  dshFullAccess: string;
  requestApproval: string;
  autoReview: string;
  fullAccess: string;
  claudeDefault: string;
  claudeAcceptEdits: string;
  claudePlan: string;
  claudeAuto: string;
  claudeDontAsk: string;
  claudeBypassPermissions: string;
  descRequestApproval: string;
  descAutoReview: string;
  descFullAccess: string;
  descClaudeDefault: string;
  descClaudeAcceptEdits: string;
  descClaudePlan: string;
  descClaudeAuto: string;
  descClaudeDontAsk: string;
  descClaudeBypassPermissions: string;
}

export interface LocalizedRuntimePermission {
  label: string;
  description: string | null;
}

const TRANSLATION_NONE = 'none';
const TRANSLATION_REQUEST_APPROVAL = 'request_approval';
const TRANSLATION_AUTO_REVIEW = 'auto_review';
const TRANSLATION_FULL_ACCESS = 'full_access';
const TRANSLATION_CLAUDE_DEFAULT = 'claude_default';
const TRANSLATION_CLAUDE_ACCEPT_EDITS = 'claude_accept_edits';
const TRANSLATION_CLAUDE_PLAN = 'claude_plan';
const TRANSLATION_CLAUDE_AUTO = 'claude_auto';
const TRANSLATION_CLAUDE_DONT_ASK = 'claude_dont_ask';
const TRANSLATION_CLAUDE_BYPASS_PERMISSIONS = 'claude_bypass_permissions';
const TRANSLATION_DSH_READ_ONLY = 'dsh_read_only';
const TRANSLATION_DSH_WORKSPACE_WRITE = 'dsh_workspace_write';
const TRANSLATION_DSH_FULL_ACCESS = 'dsh_full_access';
const TRANSLATION_DSH_AUTO_REVIEW = 'dsh_auto_review';

// Resolves the well-known permission translation for a catalog entry. Mirrors
// Android runtimePermissionTranslation (SessionRuntimeState.kt): the metadata
// i18n labelKey wins, then dsh presets, then raw ids (claude variants only
// apply when the runtime name mentions claude).
function runtimePermissionTranslation(runtime: string | null, permissionId: string,
  metadata: Record<string, Object>): string {
  const i18n = objGetRecord(metadata, 'i18n');
  const labelKey = i18n === null ? null : objGetOptString(i18n, 'labelKey');
  const byLabelKey = translationByLabelKey(labelKey);
  if (byLabelKey !== TRANSLATION_NONE) {
    return byLabelKey;
  }
  const normalizedId = permissionId.trim().toLowerCase();
  const runtimeName = runtime === null ? '' : runtime.trim().toLowerCase();
  if (runtimeName === 'dsh') {
    const preset = objGetOptString(metadata, 'preset');
    const presetId = preset === null ? normalizedId : preset;
    if (presetId === 'read-only') {
      return TRANSLATION_DSH_READ_ONLY;
    }
    if (presetId === 'workspace-write') {
      return TRANSLATION_DSH_WORKSPACE_WRITE;
    }
    if (presetId === 'danger-full-access') {
      return TRANSLATION_DSH_FULL_ACCESS;
    }
    if (presetId === 'auto') {
      return TRANSLATION_DSH_AUTO_REVIEW;
    }
    return TRANSLATION_NONE;
  }
  if (normalizedId === 'request_approval') {
    return TRANSLATION_REQUEST_APPROVAL;
  }
  if (normalizedId === 'auto_review') {
    return TRANSLATION_AUTO_REVIEW;
  }
  if (normalizedId === 'full_access') {
    return TRANSLATION_FULL_ACCESS;
  }
  if (runtimeName.includes('claude')) {
    if (normalizedId === 'default') {
      return TRANSLATION_CLAUDE_DEFAULT;
    }
    if (normalizedId === 'acceptedits') {
      return TRANSLATION_CLAUDE_ACCEPT_EDITS;
    }
    if (normalizedId === 'plan') {
      return TRANSLATION_CLAUDE_PLAN;
    }
    if (normalizedId === 'auto') {
      return TRANSLATION_CLAUDE_AUTO;
    }
    if (normalizedId === 'dontask') {
      return TRANSLATION_CLAUDE_DONT_ASK;
    }
    if (normalizedId === 'bypasspermissions') {
      return TRANSLATION_CLAUDE_BYPASS_PERMISSIONS;
    }
  }
  return TRANSLATION_NONE;
}

function translationByLabelKey(labelKey: string | null): string {
  if (labelKey === null) {
    return TRANSLATION_NONE;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.readOnly.label') {
    return TRANSLATION_DSH_READ_ONLY;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.workspaceWrite.label') {
    return TRANSLATION_DSH_WORKSPACE_WRITE;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.fullAccess.label') {
    return TRANSLATION_DSH_FULL_ACCESS;
  }
  if (labelKey === 'dashboard.new.permissionModes.dsh.auto.label') {
    return TRANSLATION_DSH_AUTO_REVIEW;
  }
  if (labelKey === 'dashboard.new.permissionModes.requestApproval.label') {
    return TRANSLATION_REQUEST_APPROVAL;
  }
  if (labelKey === 'dashboard.new.permissionModes.autoReview.label') {
    return TRANSLATION_AUTO_REVIEW;
  }
  if (labelKey === 'dashboard.new.permissionModes.fullAccess.label') {
    return TRANSLATION_FULL_ACCESS;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.default.label') {
    return TRANSLATION_CLAUDE_DEFAULT;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.acceptEdits.label') {
    return TRANSLATION_CLAUDE_ACCEPT_EDITS;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.plan.label') {
    return TRANSLATION_CLAUDE_PLAN;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.auto.label') {
    return TRANSLATION_CLAUDE_AUTO;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.dontAsk.label') {
    return TRANSLATION_CLAUDE_DONT_ASK;
  }
  if (labelKey === 'dashboard.new.permissionModes.claude.bypassPermissions.label') {
    return TRANSLATION_CLAUDE_BYPASS_PERMISSIONS;
  }
  return TRANSLATION_NONE;
}

function localizedLabel(strings: RuntimePermissionStrings, translation: string,
  fallback: string): string {
  if (translation === TRANSLATION_DSH_READ_ONLY) {
    return strings.dshReadOnly;
  }
  if (translation === TRANSLATION_DSH_WORKSPACE_WRITE) {
    return strings.dshWorkspaceWrite;
  }
  if (translation === TRANSLATION_DSH_FULL_ACCESS) {
    return strings.dshFullAccess;
  }
  if (translation === TRANSLATION_DSH_AUTO_REVIEW || translation === TRANSLATION_AUTO_REVIEW) {
    return strings.autoReview;
  }
  if (translation === TRANSLATION_REQUEST_APPROVAL) {
    return strings.requestApproval;
  }
  if (translation === TRANSLATION_FULL_ACCESS) {
    return strings.fullAccess;
  }
  if (translation === TRANSLATION_CLAUDE_DEFAULT) {
    return strings.claudeDefault;
  }
  if (translation === TRANSLATION_CLAUDE_ACCEPT_EDITS) {
    return strings.claudeAcceptEdits;
  }
  if (translation === TRANSLATION_CLAUDE_PLAN) {
    return strings.claudePlan;
  }
  if (translation === TRANSLATION_CLAUDE_AUTO) {
    return strings.claudeAuto;
  }
  if (translation === TRANSLATION_CLAUDE_DONT_ASK) {
    return strings.claudeDontAsk;
  }
  if (translation === TRANSLATION_CLAUDE_BYPASS_PERMISSIONS) {
    return strings.claudeBypassPermissions;
  }
  return fallback;
}

function localizedDescription(strings: RuntimePermissionStrings, translation: string,
  fallback: string | null): string | null {
  if (translation === TRANSLATION_REQUEST_APPROVAL) {
    return strings.descRequestApproval;
  }
  if (translation === TRANSLATION_AUTO_REVIEW || translation === TRANSLATION_DSH_AUTO_REVIEW) {
    return strings.descAutoReview;
  }
  if (translation === TRANSLATION_FULL_ACCESS) {
    return strings.descFullAccess;
  }
  if (translation === TRANSLATION_CLAUDE_DEFAULT) {
    return strings.descClaudeDefault;
  }
  if (translation === TRANSLATION_CLAUDE_ACCEPT_EDITS) {
    return strings.descClaudeAcceptEdits;
  }
  if (translation === TRANSLATION_CLAUDE_PLAN) {
    return strings.descClaudePlan;
  }
  if (translation === TRANSLATION_CLAUDE_AUTO) {
    return strings.descClaudeAuto;
  }
  if (translation === TRANSLATION_CLAUDE_DONT_ASK) {
    return strings.descClaudeDontAsk;
  }
  if (translation === TRANSLATION_CLAUDE_BYPASS_PERMISSIONS) {
    return strings.descClaudeBypassPermissions;
  }
  return fallback;
}

// Localizes a permission catalog entry. Falls back to the raw label and
// description when the entry does not match any known preset.
export function localizeRuntimePermission(strings: RuntimePermissionStrings, runtime: string | null,
  permissionId: string, label: string, description: string | null,
  metadata: Record<string, Object>): LocalizedRuntimePermission {
  const translation = runtimePermissionTranslation(runtime, permissionId, metadata);
  const result: LocalizedRuntimePermission = {
    label: localizedLabel(strings, translation, label),
    description: localizedDescription(strings, translation, description)
  };
  return result;
}
