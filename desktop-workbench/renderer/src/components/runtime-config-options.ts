export type RuntimeConfigOption = {
  value: unknown
  label: string
  disabled: boolean
  description?: string
  disabledReason?: string
}

/** Schema owns allowed values; UI metadata only supplies their presentation. */
export function runtimeConfigOptions(values: unknown[] | undefined, uiOptions: unknown): RuntimeConfigOption[] {
  const rows = Array.isArray(uiOptions) ? uiOptions.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null && "value" in row,
  ) : []
  return (values ?? rows.map((row) => row.value)).map((value) => {
    const row = rows.find((row) => row.value === value)
    return {
      value,
      label: typeof row?.label === "string" ? row.label : String(value),
      disabled: row?.disabled === true,
      ...(typeof row?.description === "string" ? { description: row.description } : {}),
      ...(typeof row?.disabledReason === "string" ? { disabledReason: row.disabledReason } : {}),
    }
  })
}
