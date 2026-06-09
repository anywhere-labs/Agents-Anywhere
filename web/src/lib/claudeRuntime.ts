import type { RuntimeConfigField } from "./api";

export const CLAUDE_NO_EFFORT_MODEL = "claude-haiku-4-5";

const OPUS_48_47_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const OPUS_46_SONNET_46_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "max",
]);

export function claudeEffortValuesForModel(model: unknown): ReadonlySet<string> {
  const key = typeof model === "string" ? model : "";
  if (key === CLAUDE_NO_EFFORT_MODEL) return new Set();
  if (
    key.startsWith("claude-opus-4-8") ||
    key.startsWith("claude-opus-4-7")
  ) {
    return OPUS_48_47_EFFORTS;
  }
  if (
    key.startsWith("claude-opus-4-6") ||
    key.startsWith("claude-sonnet-4-6")
  ) {
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
