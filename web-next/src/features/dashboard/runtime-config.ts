import type { RuntimeConfigField, RuntimeConfigSchema } from "./types";

export function runtimeConfigFields(
  schema: RuntimeConfigSchema | null | undefined,
  settings: Record<string, unknown> | null,
  scope: "device" | "session",
): RuntimeConfigField[] {
  return (schema?.fields ?? [])
    .filter((field) => !field.hidden)
    .filter((field) => scope === "device" || field.allowSessionOverride)
    .filter((field) => fieldVisible(field, settings));
}

export function fieldVisible(
  field: RuntimeConfigField,
  settings: Record<string, unknown> | null,
): boolean {
  const visibleWhen = field.visibleWhen;
  if (!visibleWhen || Object.keys(visibleWhen).length === 0) return true;
  return Object.entries(visibleWhen).every(([key, expected]) => settings?.[key] === expected);
}

export function optionLabel(
  field: RuntimeConfigField | null | undefined,
  value: unknown,
  fallback: string,
): string {
  if (!field) return fallback;
  const key = typeof value === "string" ? value : "";
  return (
    field.options?.find((option) => String(option.value) === key)?.label ??
    field.options?.[0]?.label ??
    fallback
  );
}

export function effectiveFieldValue(
  field: RuntimeConfigField | null | undefined,
  value: unknown,
): string {
  if (typeof value === "string") return value;
  return field?.options?.[0] ? String(field.options[0].value) : "";
}

const CLAUDE_NO_EFFORT_MODEL = "claude-haiku-4-5";
const OPUS_48_47_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const OPUS_46_SONNET_46_EFFORTS = new Set(["low", "medium", "high", "max"]);

function claudeEffortValuesForModel(model: unknown): ReadonlySet<string> {
  const key = typeof model === "string" ? model : "";
  if (key === CLAUDE_NO_EFFORT_MODEL) return new Set();
  if (key.startsWith("claude-opus-4-8") || key.startsWith("claude-opus-4-7")) {
    return OPUS_48_47_EFFORTS;
  }
  if (key.startsWith("claude-opus-4-6") || key.startsWith("claude-sonnet-4-6")) {
    return OPUS_46_SONNET_46_EFFORTS;
  }
  return OPUS_46_SONNET_46_EFFORTS;
}

export function filterClaudeEffortField(
  runtime: string,
  field: RuntimeConfigField | null | undefined,
  model: unknown,
): RuntimeConfigField | null {
  if (!field) return null;
  if (runtime !== "claude" || field.key !== "effort") return field;
  const allowed = claudeEffortValuesForModel(model);
  if (allowed.size === 0) return null;
  return {
    ...field,
    options: field.options?.filter((option) => allowed.has(String(option.value))) ?? [],
  };
}

export function composerMenuOptions(field: RuntimeConfigField | null | undefined) {
  return (
    field?.options?.map((option) => ({
      id: String(option.value),
      label: option.label,
      description: option.description,
    })) ?? []
  );
}

export type ComposerPermissionLabelKey =
  | "askApproval"
  | "autoApprove"
  | "fullAccess"
  | "readOnly";

const PERMISSION_LABEL_KEYS: Record<string, ComposerPermissionLabelKey> = {
  ask: "askApproval",
  default: "askApproval",
  acceptEdits: "askApproval",
  auto: "autoApprove",
  fullAccess: "fullAccess",
  bypassPermissions: "fullAccess",
  plan: "readOnly",
};

export function permissionLabelKey(value: unknown): ComposerPermissionLabelKey | null {
  return typeof value === "string" ? PERMISSION_LABEL_KEYS[value] ?? null : null;
}
