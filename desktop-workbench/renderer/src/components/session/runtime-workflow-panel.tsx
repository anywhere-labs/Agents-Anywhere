"use client"
import * as React from "react"
import { useTranslations } from "next-intl"
import { StructuredAgentFields } from "./structured-agent-fields"
import { formDefaults, formErrors, type FormSchema } from "@/features/dashboard/runtime-forms"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import type { RuntimeDialogValue, WorkflowInteraction, WorkflowView } from "@/features/dashboard/runtime-workflows"

export function RuntimeInteractionForm({ request, pending, onRespond }: {
  request: WorkflowInteraction; pending: boolean;
  onRespond: (actionId: string, input?: RuntimeDialogValue) => void;
}) {
  const [text, setText] = React.useState(typeof request.metadata.initialValue === "string" ? request.metadata.initialValue : "")
  const [selected, setSelected] = React.useState("")
  const [confirmed, setConfirmed] = React.useState(false)
  const schema = (request.metadata.formSchema ?? {}) as FormSchema
  const [formValues, setFormValues] = React.useState<Record<string, unknown>>(() => formDefaults(schema))
  const formValid = Object.keys(formErrors(schema, formValues)).length === 0
  const options = Array.isArray(request.metadata.options) ? request.metadata.options as { id: string; label: string }[] : []
  const value = (): RuntimeDialogValue | undefined => request.kind === "form" ? { kind: "form", values: formValues } : request.kind === "confirm" ? { kind: "confirm", status: "submitted", value: confirmed }
    : request.kind === "select" ? { kind: "select", status: "submitted", optionId: selected }
    : request.kind === "editor" || request.kind === "input" ? { kind: request.kind, status: "submitted", text } : undefined
  const fieldId = React.useId()
  return <FieldGroup>
    <Field>
      <FieldLabel htmlFor={fieldId}>{request.title}</FieldLabel>
      {request.message ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">{request.message}</pre> : null}
      {request.kind === "editor" ? <Textarea id={fieldId} value={text} onChange={event => setText(event.target.value)} disabled={pending} />
        : request.kind === "input" ? <Input id={fieldId} value={text} onChange={event => setText(event.target.value)} disabled={pending} />
        : request.kind === "confirm" ? <Checkbox id={fieldId} checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={pending} />
        : request.kind === "select" ? <Select value={selected} onValueChange={setSelected} disabled={pending}><SelectTrigger id={fieldId}><SelectValue placeholder="" /></SelectTrigger><SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select> : null}
    </Field>
    {request.kind === "form" ? <StructuredAgentFields schema={schema} values={formValues} onChange={setFormValues} disabled={pending} /> : null}
    <div className="flex flex-wrap gap-2">{request.actions.map(action => <Button key={action.actionId} variant={action.style === "danger" ? "destructive" : action.style === "primary" ? "default" : "outline"} disabled={pending || (action.actionId === "submit" && request.kind === "select" && !selected) || (action.actionId === "accept" && request.kind === "form" && !formValid)} onClick={() => onRespond(action.actionId, action.actionId === "submit" || action.actionId === "accept" ? value() : undefined)}>{action.label}</Button>)}</div>
  </FieldGroup>
}

export function RuntimeWorkflowPanel({ operation, pending, error, onRespond, onCancel, onRefresh, onDismiss }: {
  operation: WorkflowView; pending: boolean; error?: string;
  onRespond: (request: WorkflowInteraction, actionId: string, input?: RuntimeDialogValue) => void;
  onCancel: () => void; onRefresh?: () => void; onDismiss?: () => void;
}) {
  const tCommon = useTranslations("common")
  const requests = operation.state.interactions.filter(request => request.status === "open")
  const failure = error ?? operation.state.failure?.message
  const stopped = ["failed", "cancelled", "rejected", "expired", "outcome_unknown"].includes(operation.state.phase)
  if (!requests.length && !failure && !stopped) return null
  return <Alert><AlertTitle>{requests[0]?.title ?? tCommon(operation.kind === "preparation" ? "loadFailed" : "createFailed")}</AlertTitle><AlertDescription className="flex flex-col gap-3">
    {requests.map(request => <RuntimeInteractionForm key={request.interactionId + request.ownerGeneration} request={request} pending={pending} onRespond={(action, input) => onRespond(request, action, input)} />)}
    {error || operation.state.failure ? <p role="alert">{error ?? operation.state.failure?.message}</p> : null}
    {onRefresh ? <Button variant="outline" size="sm" disabled={pending} onClick={onRefresh}>{tCommon("refresh")}</Button> : null}
    {onDismiss && ["failed", "cancelled", "rejected", "outcome_unknown"].includes(operation.state.phase) ? <Button variant="outline" size="sm" onClick={onDismiss}>{tCommon("close")}</Button> : null}
    {operation.state.canCancel || operation.state.canCancelInitialization ? <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>{tCommon("cancel")}</Button> : null}
  </AlertDescription></Alert>
}
