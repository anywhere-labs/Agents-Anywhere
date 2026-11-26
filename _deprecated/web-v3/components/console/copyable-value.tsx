import { CopyButton } from "@/components/copy-button"

/** A labelled value to copy into another service's or app's settings. */
export function CopyableValue({
  label,
  value,
  copyLabel,
  copyFailedLabel,
}: {
  label: string
  value: string
  copyLabel?: string
  copyFailedLabel?: string
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-background px-4 py-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1">
        <code className="min-w-0 font-mono text-sm break-all">{value}</code>
        <CopyButton
          value={value}
          copyLabel={copyLabel}
          copyFailedLabel={copyFailedLabel}
        />
      </div>
    </div>
  )
}
