import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** A titled group of form fields; groups are separated by a hairline. */
export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn("border-t py-8 first:border-t-0 first:pt-0", className)}
    >
      <div className="mb-6">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex flex-col gap-7">{children}</div>
    </section>
  )
}

/** Label and hint stacked above the control. */
export function FormField({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div>
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  )
}

/** A field whose control is a switch: text on the left, switch on the right. */
export function SwitchField({
  label,
  description,
  htmlFor,
  control,
  children,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  htmlFor: string
  control: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <div>
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {control}
      </div>
      {children}
    </div>
  )
}

/** A labelled text control that counts its characters against a max limit. */
export function CountedTextField({
  id,
  label,
  value,
  max,
  multiline = false,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  value: string
  max: number
  multiline?: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  const Control = multiline ? Textarea : Input
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {value.length} / {max}
        </span>
      </div>
      <Control
        id={id}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
