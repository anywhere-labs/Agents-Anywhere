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

test('plan review preserves the full plan and maps the declared approval option independently of position', () => {
  const detail = '# 计划\n\n1. 检查配置\n2. 修改文件\n\n```ts\nconst value = 1\n```'
  const plan = { id: 'plan', question: '是否批准？', detail, intent: { kind: 'plan-review', approve: '批准计划' }, options: [{ label: '修改计划' }, { label: '批准计划' }] }
  const form = new QuestionForm([plan])
  assert.equal(form.hasPlanReview, true)
  assert.equal(form.input().uiSchema.questions[0]?.prompt, `是否批准？\n\n${detail}`)
  assert.equal(form.input().uiSchema.questions[0]?.intent?.approveOptionId, 'o_1')
  assert.deepEqual(form.answer({ answers: { plan: { optionIds: ['o_1'] } } }), { answers: [{ id: 'plan', selected: ['批准计划'] }] })
  assert.deepEqual(form.answer({ answers: { plan: { customText: '先不要修改文件' } } }), { answers: [{ id: 'plan', selected: [], custom: '先不要修改文件' }] })
  assert.throws(() => new QuestionForm([{ ...plan, detail: '' }]))
  assert.throws(() => new QuestionForm([{ ...plan, intent: { kind: 'future-review', approve: '批准计划' } }]))
  assert.throws(() => new QuestionForm([{ ...plan, intent: { kind: 'plan-review', approve: '不是选项' } }]))
  assert.throws(() => new QuestionForm([{ ...plan, multiSelect: true }]))
})

test('approval questions show their Chinese copy as a plain single choice and answer with the native labels', () => {
  // Shaped like the application access request of DSH 0.2.2 Computer Use.
  const display = {
    question: { en: 'Allow computer use to launch, read, capture and control this application?', zh: '允许 Computer Use 启动、读取、截图和控制此应用吗？' },
    detail: { en: 'Allowing or denying applies to every version.', zh: '允许或拒绝会应用于同一应用标识的所有版本和副本。' },
    approve: { en: 'Allow for this session', zh: '本会话允许' },
  }
  const access = { id: 'cua-app-access', question: 'Allow computer use to launch if needed, read, capture, and control Safari?',
    detail: 'Allowing or denying applies to every version.', options: [{ label: 'Allow for this session' }, { label: 'Deny' }, { label: 'Always allow' }],
    intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny', always: 'Always allow',
      subject: { name: 'Safari', icon: 'https://example.invalid/safari.png' }, display } }
  const form = new QuestionForm([access])
  assert.equal(form.hasPlanReview, false)
  const input = form.input()
  assert.deepEqual({ ...input.uiSchema.questions[0] }, {
    id: 'cua-app-access', header: '授权请求 · Safari',
    prompt: '允许 Computer Use 启动、读取、截图和控制此应用吗？\n\n允许或拒绝会应用于同一应用标识的所有版本和副本。',
    multiple: false, allowCustom: false,
    options: [{ id: 'o_0', label: '本会话允许' }, { id: 'o_1', label: '拒绝' }, { id: 'o_2', label: '始终允许' }],
  })
  assert.deepEqual(Object.keys(input.schema.properties.answers.properties['cua-app-access']!.properties), ['optionIds'])
  // DSH reads the decision from its native labels, whatever AA showed.
  assert.deepEqual(form.answer({ answers: { 'cua-app-access': { optionIds: ['o_2'] } } }), { answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] })
  // DSH treats any free text as a refusal, so an approval accepts exactly one offered action.
  for (const answer of [{ customText: '允许' }, { optionIds: ['o_0'], customText: '允许' }, {}, { optionIds: ['o_0', 'o_1'] }]) {
    assert.throws(() => form.answer({ answers: { 'cua-app-access': answer } }))
  }
  // Without Chinese copy the native question and grant label stay, a native header wins,
  // and the card still owns the refusal and always-allow wording.
  const english = new QuestionForm([{ ...access, header: '应用', intent: { ...access.intent, display: { question: { en: display.question.en } } } }])
    .input().uiSchema.questions[0]
  assert.equal(english?.prompt, `${access.question}\n\n${access.detail}`)
  assert.equal(english?.header, '应用')
  assert.deepEqual(english?.options.map(option => option.label), ['Allow for this session', '拒绝', '始终允许'])
  const anonymous = { ...access.intent, subject: undefined, display: { question: display.question } }
  assert.equal(new QuestionForm([{ ...access, intent: anonymous }]).input().uiSchema.questions[0]?.header, '授权请求')
  // Ordinary questions next to it keep their free-text answers.
  const mixed = new QuestionForm([access, questions[2]])
  assert.equal(mixed.input().uiSchema.questions[1]?.allowCustom, true)
  assert.deepEqual(mixed.answer({ answers: { 'cua-app-access': { optionIds: ['o_1'] }, notes: { customText: '简洁' } } }).answers,
    [{ id: 'cua-app-access', selected: ['Deny'] }, { id: 'notes', selected: [], custom: '简洁' }])
  // Without the persistent grant, two actions cover the options.
  const twoActions = { ...access, options: access.options.slice(0, 2), intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny' } }
  assert.equal(new QuestionForm([twoActions]).input().uiSchema.questions[0]?.options.length, 2)
  // Malformed approvals stay with the official DSH clients.
  for (const intent of [
    { kind: 'approval', approve: 'Allow for this session', reject: 'Allow for this session', always: 'Always allow' },
    { kind: 'approval', approve: 'Allow for this session', reject: 'Deny' },
    { kind: 'approval', approve: 'Allow', reject: 'Deny', always: 'Always allow' },
    { kind: 'approval', reject: 'Deny', always: 'Always allow' },
  ]) assert.throws(() => new QuestionForm([{ ...access, intent }]))
  assert.throws(() => new QuestionForm([{ ...access, multiSelect: true }]))
})
