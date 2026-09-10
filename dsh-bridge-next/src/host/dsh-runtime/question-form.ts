import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { BridgeError } from './errors.js'
import { record } from './types.js'

function invalid(message: string): never { throw new BridgeError('INVALID_PARAMS', message) }

/** The existing inputRequest v1 contract; DSH option labels never become wire IDs. */
export class QuestionForm {
  readonly questions: AskUserQuestionItem[]
  constructor(value: unknown) {
    if (!Array.isArray(value) || !value.length) invalid('DSH returned no questions.')
    const ids = new Set<string>()
    this.questions = value.map(raw => {
      const q = record(raw)
      if (typeof q.id !== 'string' || !q.id || ids.has(q.id) || typeof q.question !== 'string' || !q.question.trim() || q.intent != null) {
        invalid('Unsupported DSH question definition.')
      }
      ids.add(q.id)
      if (q.multiSelect != null && typeof q.multiSelect !== 'boolean') invalid('Invalid DSH selection mode.')
      const options = q.options ?? []
      if (!Array.isArray(options)) invalid('Invalid DSH options.')
      const labels = new Set<string>()
      for (const option of options) {
        const o = record(option)
        if (typeof o.label !== 'string' || !o.label || labels.has(o.label) || (o.description != null && typeof o.description !== 'string')) invalid('Invalid DSH option.')
        labels.add(o.label)
      }
      return { id: q.id, question: q.question,
        ...(typeof q.header === 'string' ? { header: q.header } : {}),
        ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
        multiSelect: q.multiSelect === true, options: options as NonNullable<AskUserQuestionItem['options']> }
    })
  }

  input() {
    const questions = this.questions.map(q => ({ id: q.id, prompt: q.detail ? `${q.question}\n\n${q.detail}` : q.question,
      ...(q.header ? { header: q.header } : {}), multiple: q.multiSelect === true, allowCustom: true,
      options: (q.options ?? []).map((o, i) => ({ id: `o_${i}`, label: o.label, ...(o.description ? { description: o.description } : {}) })) }))
    return { required: true,
      schema: { type: 'object', required: ['answers'], additionalProperties: false, properties: {
        answers: { type: 'object', required: questions.map(q => q.id), additionalProperties: false,
          properties: Object.fromEntries(questions.map(q => [q.id, { type: 'object', additionalProperties: false,
            properties: { optionIds: { type: 'array', uniqueItems: true, items: { type: 'string', enum: q.options.map(o => o.id) },
              ...(!q.multiple ? { maxItems: 1 } : {}) }, customText: { type: 'string' } } }])) },
      } }, uiSchema: { component: 'inputRequest', version: 1, questions } }
  }

  answer(input: unknown): AskUserQuestionAnswer {
    const answers = record(record(input).answers)
    if (Object.keys(answers).length !== this.questions.length || Object.keys(answers).some(id => !this.questions.some(q => q.id === id))) invalid('请回答所有问题。')
    return { answers: this.questions.map(q => {
      const a = record(Object.hasOwn(answers, q.id) ? answers[q.id] : undefined)
      if (Object.keys(a).some(key => key !== 'optionIds' && key !== 'customText')) invalid('答案包含未知字段。')
      const optionIds = a.optionIds ?? []
      if (!Array.isArray(optionIds) || optionIds.some(id => typeof id !== 'string') || new Set(optionIds).size !== optionIds.length) invalid('请选择有效选项。')
      if (a.customText != null && typeof a.customText !== 'string') invalid('自填答案必须是文本。')
      const custom = typeof a.customText === 'string' ? a.customText.trim() : ''
      if (!optionIds.length && !custom) invalid('请回答所有问题。')
      if (!q.multiSelect && (optionIds.length > 1 || (optionIds.length > 0 && custom))) invalid('单选问题请选择一个选项，或填写自定义答案。')
      const options = new Map((q.options ?? []).map((o, i) => [`o_${i}`, o.label]))
      const selected = optionIds.map(id => {
        if (!options.has(id)) invalid('答案包含未知选项。')
        return options.get(id)!
      })
      return { id: q.id, selected, ...(custom ? { custom } : {}) }
    }) }
  }
}
