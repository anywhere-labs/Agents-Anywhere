"use client"

import * as React from "react"
import { Check, CircleAlert, CircleCheck, Info, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  buildInputRequestPayload,
  createInputRequestDrafts,
  inputRequestIsComplete,
  readInputRequestForm,
  type InputRequestDraft,
  type InputRequestDrafts,
  type InputRequestForm,
  type InputRequestQuestion,
} from "@/components/session/input-request"
import { cn } from "@/lib/utils"
import type { Notice, NoticeAction } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type InteractionCardProps = {
  notice: Notice
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  onRespondInteraction: (noticeId: string, actionId: string, input?: Record<string, unknown>) => void
  compact?: boolean
}

export function InteractionCard({
  notice,
  resolvingNoticeId,
  resolvingActionId,
  onRespondInteraction,
  compact,
}: InteractionCardProps) {
  const tSession = useTranslations("dashboard.session")
  const resolving = resolvingNoticeId === notice.noticeId
  const disabled = resolvingNoticeId !== null || notice.status === "response_accepted" || notice.status === "resolving"
  const Icon = notice.severity === "error" ? CircleAlert : ShieldCheck
  const inputRequest = React.useMemo(() => readInputRequestForm(notice), [notice])
  const [inputDrafts, setInputDrafts] = React.useState<InputRequestDrafts>(() => (
    inputRequest ? createInputRequestDrafts(inputRequest) : {}
  ))

  React.useEffect(() => {
    setInputDrafts(inputRequest ? createInputRequestDrafts(inputRequest) : {})
  }, [inputRequest])

  const respond = (action: NoticeAction) => {
    const input = inputRequest?.action.actionId === action.actionId
      ? buildInputRequestPayload(inputRequest, inputDrafts)
      : undefined
    onRespondInteraction(notice.noticeId, action.actionId, input)
  }

  const actionButtons = (
    <div className="flex flex-wrap gap-2 md:justify-end md:flex-nowrap">
      {notice.actions.map((action) => {
        const submitDisabled = inputRequest?.action.actionId === action.actionId
          && !inputRequestIsComplete(inputRequest, inputDrafts)
        return (
          <Button
            key={action.actionId}
            type="button"
            variant={action.style === "primary" ? "default" : "outline"}
            size="sm"
            className="whitespace-nowrap"
            disabled={disabled || submitDisabled}
            onClick={() => respond(action)}
          >
            {resolving && resolvingActionId === action.actionId
              ? <Loader2 className="size-3.5 animate-spin" />
              : actionIcon(action.actionId)}
            {action.label}
          </Button>
        )
      })}
    </div>
  )

  return (
    <div className={cn(
      "rounded-xl border bg-card p-3 shadow-sm",
      notice.severity === "error" ? "border-destructive/35" : "border-border",
      compact && "rounded-lg",
    )}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 gap-2">
            <Icon className={cn(
              "mt-0.5 size-4 shrink-0",
              notice.severity === "error" ? "text-destructive" : "text-muted-foreground",
            )} />
            <div className="min-w-0">
              <div className="wrap-break-word text-sm font-medium">{notice.title}</div>
            </div>
          </div>
          {!inputRequest ? actionButtons : null}
        </div>
        {notice.message || notice.status === "failed" ? (
          <div className="min-w-0 pl-6">
            {notice.message ? (
              <p className="wrap-break-word text-sm text-muted-foreground">{notice.message}</p>
            ) : null}
            {notice.status === "failed" ? (
              <p className="mt-1 text-xs text-destructive">{interactionErrorMessage(notice)}</p>
            ) : null}
          </div>
        ) : null}
        {inputRequest ? (
          <div className="flex flex-col gap-3 pl-6">
            <InputRequestFields
              noticeId={notice.noticeId}
              form={inputRequest}
              drafts={inputDrafts}
              disabled={disabled}
              otherLabel={tSession("inputRequestOther")}
              onDraftChange={(questionId, draft) => {
                setInputDrafts((current) => ({ ...current, [questionId]: draft }))
              }}
            />
            <div className="flex justify-end">{actionButtons}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function InputRequestFields({
  noticeId,
  form,
  drafts,
  disabled,
  otherLabel,
  onDraftChange,
}: {
  noticeId: string
  form: InputRequestForm
  drafts: InputRequestDrafts
  disabled: boolean
  otherLabel: string
  onDraftChange: (questionId: string, draft: InputRequestDraft) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {form.questions.map((question) => (
        <InputRequestQuestionFields
          key={question.id}
          noticeId={noticeId}
          question={question}
          draft={drafts[question.id] ?? emptyInputRequestDraft()}
          disabled={disabled}
          otherLabel={otherLabel}
          onChange={(draft) => onDraftChange(question.id, draft)}
        />
      ))}
    </div>
  )
}

function InputRequestQuestionFields({
  noticeId,
  question,
  draft,
  disabled,
  otherLabel,
  onChange,
}: {
  noticeId: string
  question: InputRequestQuestion
  draft: InputRequestDraft
  disabled: boolean
  otherLabel: string
  onChange: (draft: InputRequestDraft) => void
}) {
  const fieldId = `${noticeId}-${question.id}`

  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-2 min-w-0">
        {question.header ? (
          <span className="block text-xs font-medium text-muted-foreground">{question.header}</span>
        ) : null}
        <span className="mt-0.5 block wrap-break-word text-sm text-foreground">{question.prompt}</span>
      </legend>
      {question.multiple ? (
        <div className="grid gap-1.5">
          {question.options.map((option) => {
            const optionId = `${fieldId}-${option.id}`
            return (
              <div key={option.id} className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <Checkbox
                  id={optionId}
                  checked={draft.optionIds.includes(option.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    const optionIds = checked === true
                      ? [...draft.optionIds, option.id]
                      : draft.optionIds.filter((id) => id !== option.id)
                    onChange({ ...draft, optionIds })
                  }}
                />
                <OptionLabel htmlFor={optionId} label={option.label} description={option.description} />
              </div>
            )
          })}
          {question.allowCustom ? (
            <CustomAnswerField
              id={`${fieldId}-custom`}
              multiple
              label={otherLabel}
              draft={draft}
              disabled={disabled}
              onChange={onChange}
            />
          ) : null}
        </div>
      ) : (
        <RadioGroup
          value={draft.useCustom ? CUSTOM_ANSWER_VALUE : draft.optionIds[0] ?? ""}
          disabled={disabled}
          className="gap-1.5"
          onValueChange={(value) => {
            if (value === CUSTOM_ANSWER_VALUE) {
              onChange({ ...draft, optionIds: [], useCustom: true })
              return
            }
            onChange({ optionIds: [value], customText: "", useCustom: false })
          }}
        >
          {question.options.map((option) => {
            const optionId = `${fieldId}-${option.id}`
            return (
              <div key={option.id} className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <RadioGroupItem id={optionId} value={option.id} />
                <OptionLabel htmlFor={optionId} label={option.label} description={option.description} />
              </div>
            )
          })}
          {question.allowCustom ? (
            <CustomAnswerField
              id={`${fieldId}-custom`}
              multiple={false}
              label={otherLabel}
              draft={draft}
              disabled={disabled}
              onChange={onChange}
            />
          ) : null}
        </RadioGroup>
      )}
    </fieldset>
  )
}

function OptionLabel({
  htmlFor,
  label,
  description,
}: {
  htmlFor: string
  label: string
  description: string | null
}) {
  return (
    <label htmlFor={htmlFor} className="min-w-0 flex-1 cursor-pointer text-sm">
      <span className="block wrap-break-word text-foreground">{label}</span>
      {description ? (
        <span className="mt-0.5 block wrap-break-word text-xs text-muted-foreground">{description}</span>
      ) : null}
    </label>
  )
}

function CustomAnswerField({
  id,
  multiple,
  label,
  draft,
  disabled,
  onChange,
}: {
  id: string
  multiple: boolean
  label: string
  draft: InputRequestDraft
  disabled: boolean
  onChange: (draft: InputRequestDraft) => void
}) {
  const selectCustom = () => {
    onChange({
      ...draft,
      optionIds: multiple ? draft.optionIds : [],
      useCustom: true,
    })
  }

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
      {multiple ? (
        <Checkbox
          id={`${id}-selector`}
          checked={draft.useCustom}
          disabled={disabled}
          onCheckedChange={(checked) => {
            const useCustom = checked === true
            onChange({ ...draft, useCustom, customText: useCustom ? draft.customText : "" })
          }}
        />
      ) : (
        <RadioGroupItem id={`${id}-selector`} value={CUSTOM_ANSWER_VALUE} />
      )}
      <label htmlFor={id} className="shrink-0 cursor-pointer text-sm text-foreground">{label}</label>
      <Input
        id={id}
        value={draft.customText}
        disabled={disabled}
        className="h-8 flex-1 rounded-md"
        onFocus={selectCustom}
        onChange={(event) => {
          onChange({
            ...draft,
            optionIds: multiple ? draft.optionIds : [],
            customText: event.target.value,
            useCustom: true,
          })
        }}
      />
    </div>
  )
}

function emptyInputRequestDraft(): InputRequestDraft {
  return { optionIds: [], customText: "", useCustom: false }
}

const CUSTOM_ANSWER_VALUE = "__custom_answer__"

export function InteractionHeaderNotice({
  blockingInteractionCount,
  onResolveClick,
}: {
  blockingInteractionCount: number
  onResolveClick: () => void
}) {
  const tSession = useTranslations("dashboard.session")

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 px-4 pt-2">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-2 text-sm shadow-lg shadow-background/20 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2 text-foreground">
          <ShieldCheck className="size-4 shrink-0 text-amber-500" />
          <span className="min-w-0 truncate">
            {tSession(blockingInteractionCount > 1 ? "interactionPendingPlural" : "interactionPending", {
              count: blockingInteractionCount,
            })}
          </span>
        </div>
        <button
          type="button"
          className="pointer-events-auto shrink-0 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={onResolveClick}
        >
          {tSession("resolveBelow")}
        </button>
      </div>
    </div>
  )
}

export function NotificationCard({ notice }: { notice: Notice }) {
  const Icon = notificationIcon(notice.severity)
  return (
    <div className={cn(
      "rounded-xl border bg-muted/25 p-3",
      notice.severity === "error" && "border-destructive/35 bg-destructive/5",
      notice.severity === "warning" && "border-amber-500/30 bg-amber-500/5",
      notice.severity === "success" && "border-emerald-500/30 bg-emerald-500/5",
    )}>
      <div className="flex min-w-0 gap-2">
        <Icon className={cn(
          "mt-0.5 size-4 shrink-0",
          notice.severity === "error" && "text-destructive",
          notice.severity === "warning" && "text-amber-500",
          notice.severity === "success" && "text-emerald-500",
          notice.severity === "info" && "text-muted-foreground",
        )} />
        <div className="min-w-0">
          <div className="wrap-break-word text-sm font-medium">{notice.title}</div>
          {notice.message ? (
            <p className="mt-0.5 wrap-break-word text-sm text-muted-foreground">{notice.message}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function actionIcon(actionId: string) {
  if (actionId === "reject" || actionId === "cancel" || actionId === "dismiss") return <X className="size-3.5" />
  if (actionId === "approve_for_session") return <ShieldCheck className="size-3.5" />
  return <Check className="size-3.5" />
}

function notificationIcon(severity: Notice["severity"]) {
  if (severity === "error") return CircleAlert
  if (severity === "warning") return TriangleAlert
  if (severity === "success") return CircleCheck
  if (severity === "info") return Info
  return Info
}

function interactionErrorMessage(notice: Notice): string {
  const error = notice.context.error
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return "The response failed. Choose an action again."
}
