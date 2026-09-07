import assert from 'node:assert/strict'
import test from 'node:test'
import { QuestionForm } from '../../src/host/dsh-runtime/question-form.js'

const questions = [
  { id: 'mode', question: '选择模式', header: '模式', options: [{ label: '标准', description: '默认模式' }, { label: '快速' }] },
  { id: 'targets', question: '选择平台', multiSelect: true, options: [{ label: 'Web' }, { label: 'Android' }] },
  { id: 'notes', question: '其他要求' },
]
const answers = { mode: { optionIds: ['o_0'] }, targets: { optionIds: ['o_0', 'o_1'], customText: ' iOS ' }, notes: { customText: '简洁' } }

test('DSH questions use the unchanged inputRequest v1 form and return original labels', () => {
  const form = new QuestionForm(questions)
  const input = form.input()
  assert.equal(input.uiSchema.component, 'inputRequest')
  assert.equal(input.uiSchema.version, 1)
  assert.deepEqual(input.schema.properties.answers.required, ['mode', 'targets', 'notes'])
  assert.equal(input.uiSchema.questions[1]?.multiple, true)
  assert.deepEqual(input.uiSchema.questions[0]?.options[0], { id: 'o_0', label: '标准', description: '默认模式' })
  // Runtime notice context may be merged by the existing backend.
  assert.deepEqual(form.answer({ eventId: 'context', answers }), { answers: [
    { id: 'mode', selected: ['标准'] }, { id: 'targets', selected: ['Web', 'Android'], custom: 'iOS' },
    { id: 'notes', selected: [], custom: '简洁' },
  ] })
  assert.deepEqual(form.answer({ answers: { ...answers, mode: { customText: '另一种模式' } } }).answers[0], { id: 'mode', selected: [], custom: '另一种模式' })
})

test('platform rules reject skipped, forged and conflicting answers before responding to DSH', () => {
  const form = new QuestionForm(questions)
  for (const invalid of [undefined, {}, { answers: {} }, { answers: { ...answers, unknown: {} } },
    ...[{}, { optionIds: 'o_0' }, { optionIds: ['标准'] }, { optionIds: ['o_0', 'o_1'] }, { optionIds: ['o_0', 'o_0'] },
      { optionIds: ['o_0'], customText: '也选这个' }, { customText: '  ' }, { customText: 1 }, { optionIds: ['o_0'], extra: true }]
      .map(mode => ({ answers: { ...answers, mode } })),
  ]) assert.throws(() => form.answer(invalid))
  assert.throws(() => new QuestionForm([...questions, questions[0]]))
  assert.throws(() => new QuestionForm([{ id: 'plan', question: '批准计划？', intent: { kind: 'plan-review', approve: '好' } }]))
})
