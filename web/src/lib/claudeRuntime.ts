import type { RuntimeConfigField } from "./api";

export function filterClaudeEffortField(
  _runtime: string,
  field: RuntimeConfigField | null | undefined,
  model: unknown,
  modelField?: RuntimeConfigField | null,
): RuntimeConfigField | null {
  if (!field) return null;
  if (field.key !== "effort") return field;
  const schemaEfforts = modelEffortsFromSchema(modelField, model);
  if (schemaEfforts !== null) {
    if (schemaEfforts.length === 0) return null;
    return {
      ...field,
      options: schemaEfforts,
    };
  }
  return field;
}

function modelEffortsFromSchema(
  modelField: RuntimeConfigField | null | undefined,
  model: unknown,
) {
  if (!modelField) return null;
  const modelKey = typeof model === "string" ? model : "";
  const options = modelField.options ?? [];
  const selected = modelKey
    ? options.find((option) => String(option.value) === modelKey)
    : options[0];
  if (selected?.efforts) return selected.efforts;
  if (options.some((option) => option.efforts)) return [];
  return null;
}
