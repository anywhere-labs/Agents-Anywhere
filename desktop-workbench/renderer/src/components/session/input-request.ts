import type { Notice, NoticeAction } from "@/features/dashboard/types"

export type InputRequestOption = {
  id: string
  label: string
  description: string | null
}

export type InputRequestQuestion = {
  id: string
  prompt: string
  header: string | null
  multiple: boolean
  allowCustom: boolean
  options: InputRequestOption[]
}

export type InputRequestForm = {
  action: NoticeAction
  questions: InputRequestQuestion[]
}

export type InputRequestDraft = {
  optionIds: string[]
  customText: string
  useCustom: boolean
}

export type InputRequestDrafts = Record<string, InputRequestDraft>

export function readInputRequestForm(notice: Notice): InputRequestForm | null {
  if (notice.interactionType !== "input_request") return null

  for (const action of notice.actions) {
    const uiSchema = recordOf(action.input.uiSchema)
    if (uiSchema?.component !== "inputRequest" || uiSchema.version !== 1) continue
    if (!Array.isArray(uiSchema.questions) || uiSchema.questions.length === 0) return null

    const questions: InputRequestQuestion[] = []
    const questionIds = new Set<string>()
    for (const value of uiSchema.questions) {
      const question = readQuestion(value)
      if (!question || questionIds.has(question.id)) return null
      questionIds.add(question.id)
      questions.push(question)
    }
    return { action, questions }
  }
  return null
}

export function createInputRequestDrafts(form: InputRequestForm): InputRequestDrafts {
  return Object.fromEntries(form.questions.map((question) => [
    question.id,
    { optionIds: [], customText: "", useCustom: false },
  ]))
}

export function inputRequestIsComplete(
  form: InputRequestForm,
  drafts: InputRequestDrafts,
): boolean {
  return form.questions.every((question) => {
    const draft = drafts[question.id]
    if (!draft) return false
    const optionCount = draft.optionIds.length
    if (!question.multiple && optionCount > 1) return false
    return optionCount > 0 || (draft.useCustom && draft.customText.trim().length > 0)
  })
}

export function buildInputRequestPayload(
  form: InputRequestForm,
  drafts: InputRequestDrafts,
): Record<string, unknown> {
  const answers: Record<string, { optionIds: string[]; customText?: string }> = {}
  for (const question of form.questions) {
    const draft = drafts[question.id]
    const customText = draft?.useCustom ? draft.customText.trim() : ""
    answers[question.id] = {
      optionIds: draft?.optionIds ?? [],
      ...(customText ? { customText } : {}),
    }
  }
  return { answers }
}

function readQuestion(value: unknown): InputRequestQuestion | null {
  const question = recordOf(value)
  const id = nonEmptyText(question?.id)
  const prompt = nonEmptyText(question?.prompt)
  if (!question || !id || !prompt || !Array.isArray(question.options)) return null

  const options: InputRequestOption[] = []
  const optionIds = new Set<string>()
  for (const value of question.options) {
    const option = recordOf(value)
    const optionId = nonEmptyText(option?.id)
    const label = nonEmptyText(option?.label)
    if (!option || !optionId || !label || optionIds.has(optionId)) return null
    optionIds.add(optionId)
    options.push({
      id: optionId,
      label,
      description: nonEmptyText(option.description),
    })
  }

  return {
    id,
    prompt,
    header: nonEmptyText(question.header),
    multiple: question.multiple === true,
    allowCustom: question.allowCustom !== false,
    options,
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
