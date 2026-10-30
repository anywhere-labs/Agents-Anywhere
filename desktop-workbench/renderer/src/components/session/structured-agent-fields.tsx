"use client"
import * as React from "react"
import { useTranslations } from "next-intl"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formErrors, type FormSchema } from "@/features/dashboard/runtime-forms"

export function StructuredAgentFields({ schema, values, onChange, disabled }: { schema: FormSchema; values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void; disabled?: boolean }) {
  const tValidation = useTranslations("dashboard.device.runtimeConfigValidation")
  const prefix = React.useId()
  const errors = formErrors(schema, values)
  return <FieldGroup>{Object.entries(schema.properties ?? {}).map(([key, field]) => {
    const id = prefix + key
    const value = values[key]
    const set = (next: unknown) => onChange({ ...values, [key]: next })
    return <Field key={key} data-invalid={!!errors[key]} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{field.title ?? key}{schema.required?.includes(key) ? " *" : ""}</FieldLabel>
      {field.description ? <p className="text-sm text-muted-foreground">{field.description}</p> : null}
      {field.type === "boolean" ? <Checkbox id={id} checked={value === true} onCheckedChange={next => set(next === true)} disabled={disabled} aria-invalid={!!errors[key]} />
        : field.enum ? <Select value={typeof value === "string" && field.enum.includes(value) ? String(field.enum.indexOf(value)) : ""} onValueChange={index => set(field.enum![Number(index)])} disabled={disabled}><SelectTrigger id={id} aria-invalid={!!errors[key]}><SelectValue placeholder="" /></SelectTrigger><SelectContent><SelectGroup>{field.enum.map((item, index) => <SelectItem key={item} value={String(index)}>{field.enumNames?.[index] ?? item}</SelectItem>)}</SelectGroup></SelectContent></Select>
        : field.type === "array" && field.items?.enum ? <FieldGroup>{field.items.enum.map((item, index) => <Field key={item}><FieldLabel htmlFor={id + index}>{item}</FieldLabel><Checkbox id={id + index} checked={Array.isArray(value) && value.includes(item)} onCheckedChange={checked => set(checked ? [...(Array.isArray(value) ? value : []), item] : (Array.isArray(value) ? value : []).filter(entry => entry !== item))} disabled={disabled} /></Field>)}</FieldGroup>
        : field.type === "string" ? <Textarea id={id} value={typeof value === "string" ? value : ""} onChange={event => set(event.target.value)} disabled={disabled} aria-invalid={!!errors[key]} />
        : <Input id={id} type={field.type === "number" || field.type === "integer" ? "number" : "text"} step={field.type === "integer" ? 1 : "any"} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={event => set(field.type === "number" || field.type === "integer" ? event.target.value === "" ? undefined : Number(event.target.value) : event.target.value)} disabled={disabled} aria-invalid={!!errors[key]} />}
      {errors[key] ? <p role="alert" className="text-sm text-destructive">{tValidation(errors[key] === "required" ? "required" : "invalidFormat", { field: field.title ?? key })}</p> : null}
    </Field>
  })}</FieldGroup>
}
