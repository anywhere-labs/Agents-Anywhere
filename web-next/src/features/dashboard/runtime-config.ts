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

export function effortFieldForModel(
  modelField: RuntimeConfigField | null | undefined,
  field: RuntimeConfigField | null | undefined,
  model: unknown,
): RuntimeConfigField | null {
  if (!field) return null;
  if (field.key !== "effort") return field;
  const modelOptions = modelField?.options ?? [];
  const hasNestedEfforts = modelOptions.some((option) => option.efforts !== undefined);
  if (!hasNestedEfforts) return field;
  const modelKey = typeof model === "string" && model ? model : "";
  const selected =
    modelOptions.find((option) => String(option.value) === modelKey) ??
    modelOptions.find((option) => option.efforts !== undefined);
  const efforts = selected?.efforts ?? [];
  if (efforts.length === 0) return null;
  return {
    ...field,
    options: efforts,
  };
}

export function validEffortValue(
  effortField: RuntimeConfigField | null | undefined,
  value: unknown,
): string {
  const key = typeof value === "string" ? value : "";
  if (key && effortField?.options?.some((option) => String(option.value) === key)) return key;
  return effortField?.options?.[0] ? String(effortField.options[0].value) : "";
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
