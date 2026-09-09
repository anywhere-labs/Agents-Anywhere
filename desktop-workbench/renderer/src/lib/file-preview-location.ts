export type FilePreviewLocation = { lineNumber: number; column: number }

function positiveInteger(value: string | null | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number <= 2_147_483_647 ? number : undefined
}

/** A missing or invalid location keeps the preview's normal initial position. */
export function filePreviewLocation(line: string | null, column: string | null): FilePreviewLocation | undefined {
  const lineNumber = positiveInteger(line)
  return lineNumber ? { lineNumber, column: positiveInteger(column) ?? 1 } : undefined
}
