/**
 * Notice actions, input fields and the input-request form.
 *
 * Every value here reaches the screen: the action order is the button order, the
 * label kind selects the button's copy, the icon selects its glyph, the fields
 * decide what the user is asked for, and the validation decides whether the
 * request is ever sent. The port's rules come from Android's
 * `feature/sessiondetail/SessionRuntimeState.kt`, so a drifted branch shows up as
 * a differently ordered or differently labelled button.
 *
 * `lib.mjs` mirrors the real `.ets`; `mirror-loader-hooks.mjs` closes the one gap
 * that would otherwise stop this module from loading at all (ArkTS writes its
 * type imports without `import type`, which Node's type stripping then rejects).
 */
import { register } from 'node:module';
register('./mirror-loader-hooks.mjs', import.meta.url);

const { loadModule, suite, expect, finish } = await import('./lib.mjs');

const np = await loadModule('feature/sessiondetail/SessionNoticePresentation.ets');
suite('feature/sessiondetail/SessionNoticePresentation.ets');

const notice = (over = {}) => ({
  noticeId: 'n1', revision: 1, updatedSeq: 1, status: 'open', severity: 'info',
  interactionType: null, actions: [], ...over,
});
const action = (over = {}) => ({ actionId: 'a', label: '', style: '', input: {}, ...over });
const withProps = (properties, required) => action({ input: { schema: { properties, required } } });
const stringProp = (type) => ({ a: { type } });

// ------------------------------------------------------------ action mapping

expect('each well-known action id maps to its own label kind, and anything else defers to the Server',
  ['approve', 'approve_for_session', 'reject', 'cancel', 'dismiss', 'submit', 'other']
    .map((id) => np.noticeActionLabelKind(action({ actionId: id }))),
  [np.NoticeActionLabelKind.Approve, np.NoticeActionLabelKind.ApproveSession, np.NoticeActionLabelKind.Deny,
    np.NoticeActionLabelKind.Cancel, np.NoticeActionLabelKind.Cancel, np.NoticeActionLabelKind.Submit,
    np.NoticeActionLabelKind.Server]);
expect('destructive answers sort first, then the session approval, then the plain approval, then by style',
  ['reject', 'cancel', 'dismiss', 'approve_for_session', 'approve']
    .map((id) => np.noticeActionOrder(action({ actionId: id })))
    .concat(['primary', 'secondary', ''].map((style) => np.noticeActionOrder(action({ actionId: 'z', style })))),
  [0, 0, 0, 1, 2, 2, 1, 1]);
expect('the glyph is an X for the destructive ids, a shield for the session approval, a check otherwise',
  ['reject', 'cancel', 'dismiss', 'approve_for_session', 'approve', 'submit']
    .map((id) => np.noticeActionIcon(action({ actionId: id }))),
  [np.NoticeActionIcon.X, np.NoticeActionIcon.X, np.NoticeActionIcon.X, np.NoticeActionIcon.Shield,
    np.NoticeActionIcon.Check, np.NoticeActionIcon.Check]);
expect('only a primary-styled action that sorts last is emphasised, and a Server label falls back to the id',
  [['approve', 'primary'], ['approve', ''], ['z', 'primary'], ['z', 'secondary'], ['reject', 'primary']]
    .map(([actionId, style]) => np.noticeActionIsPrimary(action({ actionId, style })))
    .concat([np.noticeActionServerLabel(action({ label: 'Go' })), np.noticeActionServerLabel(action({ label: '' }))]),
  [true, false, true, false, false, 'Go', 'a']);

// ------------------------------------------------------------------ ordering

const original = [
  action({ actionId: 'approve', style: 'primary' }),
  action({ actionId: 'reject' }),
  action({ actionId: 'approve_for_session' }),
  action({ actionId: 'custom', style: 'primary' }),
  action({ actionId: 'other', style: 'secondary' }),
];
const sorted = np.sortedNoticeActions(notice({ actions: original }));
expect('sorting orders the buttons reject, session approval, secondary, then the primary pair',
  sorted.map((item) => item.actionId),
  ['reject', 'approve_for_session', 'other', 'approve', 'custom']);
expect('sorting copies the list rather than reordering the caller\'s array, and an action-less notice sorts to nothing',
  [original.map((item) => item.actionId), np.sortedNoticeActions(notice())],
  [['approve', 'reject', 'approve_for_session', 'custom', 'other'], []]);
expect('the three status rules are independent: respondable, still visible, destructive',
  [
    ['open', 'failed', 'responding', 'response_accepted', 'resolving', 'resolved', '']
      .map((status) => np.noticeIsRespondable(notice({ status }))),
    ['open', 'responding', 'response_accepted', 'resolving', 'failed', 'resolved', '']
      .map((status) => np.noticeIsOpenInteraction(notice({ status }))),
    [['error', 'open'], ['warn', 'open'], ['info', 'failed'], ['info', 'open']]
      .map(([severity, status]) => np.isDestructiveNotice(notice({ severity, status }))),
  ],
  [[true, true, false, false, false, false, false], [true, true, true, true, true, false, false],
    [true, false, true, false]]);

// ------------------------------------------------------------- input fields

expect('an action with no input and no requirement asks for nothing',
  np.actionInputFields(action({ input: {} })), []);
expect('a required input asks for one synthesised string field',
  np.actionInputFields(action({ input: { required: true } })),
  [{ key: 'value', label: 'Value', type: 'string', required: true }]);
expect('a null schema falls back to the synthesised field rather than throwing, as does a non-array `required`',
  [
    np.actionInputFields(action({ input: { required: true, schema: null } })),
    np.actionInputFields(action({ input: { required: true, schema: { required: 'a', properties: {} } } })),
  ],
  [[{ key: 'value', label: 'Value', type: 'string', required: true }],
    [{ key: 'value', label: 'Value', type: 'string', required: true }]]);
expect('schema properties become fields with the title as label and string as the default type',
  np.actionInputFields(action({
    input: {
      required: true,
      schema: { required: ['a'], properties: { a: { title: 'A label', type: 'integer' }, b: { type: 'boolean' } } },
    },
  })),
  [{ key: 'a', label: 'A label', type: 'integer', required: true },
    { key: 'b', label: 'b', type: 'boolean', required: false }]);

// ---------------------------------------------------------------- coercion

const coerce = (properties, required, values) => np.coerceActionInput(
  action({ input: { schema: { properties, required } } }),
  new Map(values),
);
expect('an action with no fields coerces to a null input and no error',
  np.coerceActionInput(action({ input: {} }), new Map()), { input: null, error: null });
expect('string values are trimmed, and a blank value is omitted rather than sent',
  [coerce(stringProp('string'), undefined, [['a', ' hi ']]),
    coerce({ a: {}, b: {} }, undefined, [['a', '  '], ['b', 'x']])],
  [{ input: { a: 'hi' }, error: null }, { input: { b: 'x' }, error: null }]);
expect('a required field left blank reports its label',
  coerce({ a: { title: 'A label' } }, ['a'], []),
  { input: null, error: 'A label is required.' });
expect('integers accept signs and reject fractions and exponents, and a number rejects nonsense',
  [coerce(stringProp('integer'), undefined, [['a', '-12']]),
    coerce(stringProp('integer'), undefined, [['a', '1.5']]),
    coerce(stringProp('integer'), undefined, [['a', '1e3']]),
    coerce(stringProp('number'), undefined, [['a', '1.5e3']]),
    coerce(stringProp('number'), undefined, [['a', 'abc']])],
  [{ input: { a: -12 }, error: null },
    { input: null, error: 'a must be an integer.' },
    { input: null, error: 'a must be an integer.' },
    { input: { a: 1500 }, error: null },
    { input: null, error: 'a must be a number.' }]);
expect('booleans accept true/yes/1 and false/no/0, case-insensitively, and reject anything else',
  [['TRUE', true], ['yes', true], ['0', false], ['maybe', null]]
    .map(([raw]) => {
      const result = coerce(stringProp('boolean'), undefined, [['a', raw]]);
      return result.error === null ? result.input : result.error;
    }),
  [{ a: true }, { a: true }, { a: false }, 'a must be true or false.']);
expect('a property without a type is sent as a string, and a false or a zero survives encoding',
  [coerce({ a: { title: 'T' } }, undefined, [['a', 'v']]),
    coerce({ a: { type: 'integer' }, b: { type: 'boolean' } }, undefined, [['a', '0'], ['b', 'no']])],
  [{ input: { a: 'v' }, error: null }, { input: { a: 0, b: false }, error: null }]);

// ------------------------------------------------------- input-request form

const question = (over = {}) => ({ id: 'q1', prompt: 'Pick', options: [{ id: 'o1', label: 'One' }], ...over });
const questionNotice = (questions, over = {}) => notice({
  interactionType: 'input_request',
  actions: [action({ actionId: 'submit', input: { uiSchema: { component: 'inputRequest', version: 1, questions } } })],
  ...over,
});
const formNotice = (over = {}) => notice({
  interactionType: 'input_request',
  actions: [action({ actionId: 'submit', input: { uiSchema: { component: 'inputRequest', version: 1, questions: [question()] } } })],
  ...over,
});
const isNullForm = (value) => value === null;

expect('the form is only recognised for an input_request with the right component and version',
  [
    np.noticeInputRequestForm(notice({ interactionType: 'other' })),
    np.noticeInputRequestForm(notice({ interactionType: 'input_request' })),
    np.noticeInputRequestForm(notice({
      interactionType: 'input_request',
      actions: [action({ input: { uiSchema: { component: 'other', version: 1, questions: [question()] } } })],
    })),
    np.noticeInputRequestForm(notice({
      interactionType: 'input_request',
      actions: [action({ input: { uiSchema: { component: 'inputRequest', version: 2, questions: [question()] } } })],
    })),
  ].map(isNullForm), [true, true, true, true]);
expect('a malformed question voids the whole form instead of rendering it partially',
  [
    questionNotice([]),
    questionNotice([question({ id: '' })]),
    questionNotice([question({ prompt: '  ' })]),
    questionNotice([question(), question()]),
    questionNotice([question({ options: [] })]),
    questionNotice([question({ options: [{ id: 'a', label: '' }] })]),
    questionNotice([question({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })]),
  ].map((value) => isNullForm(np.noticeInputRequestForm(value))), [true, true, true, true, true, true, true]);
expect('an action without a uiSchema is skipped, and the matching one is found',
  np.noticeInputRequestForm(notice({
    interactionType: 'input_request',
    actions: [
      action({ actionId: 'first' }),
      action({ actionId: 'second', input: { uiSchema: { component: 'inputRequest', version: 1, questions: [question()] } } }),
    ],
  }))?.action.actionId, 'second');
expect('absent multiple and allowCustom mean single-select with custom answers allowed',
  (() => {
    const form = np.noticeInputRequestForm(questionNotice([
      question({ header: 'H', multiple: true, allowCustom: false, options: [{ id: 'o1', label: 'One', description: 'D' }, { id: 'o2', label: 'Two' }] }),
      question({ id: 'q2', prompt: 'P2' }),
    ]));
    return form?.questions;
  })(),
  [{ id: 'q1', prompt: 'Pick', header: 'H', multiple: true, allowCustom: false,
      options: [{ id: 'o1', label: 'One', description: 'D' }, { id: 'o2', label: 'Two', description: null }] },
    { id: 'q2', prompt: 'P2', header: null, multiple: false, allowCustom: true,
      options: [{ id: 'o1', label: 'One', description: null }] }]);
expect('drafts start empty, one per question id',
  [...np.initialInputDrafts(np.noticeInputRequestForm(formNotice())).keys()], ['q1']);

const singleForm = np.noticeInputRequestForm(formNotice());
const multiForm = np.noticeInputRequestForm(questionNotice([question({ multiple: true }), question({ id: 'q2' })]));
const draftWith = (form, overrides) => {
  const drafts = np.initialInputDrafts(form);
  for (const [id, values] of Object.entries(overrides)) {
    Object.assign(drafts.get(id), values);
  }
  return drafts;
};
expect('a single-select needs exactly one option, a multi-select needs at least one',
  [
    np.inputFormIsComplete(singleForm, np.initialInputDrafts(singleForm)),
    np.inputFormIsComplete(singleForm, draftWith(singleForm, { q1: { optionIds: ['o1'] } })),
    np.inputFormIsComplete(singleForm, draftWith(singleForm, { q1: { optionIds: ['o1', 'o2'] } })),
    np.inputFormIsComplete(multiForm, draftWith(multiForm, { q1: { optionIds: ['o1'] }, q2: { optionIds: ['o1'] } })),
    np.inputFormIsComplete(multiForm, draftWith(multiForm, { q1: {}, q2: { optionIds: ['o1'] } })),
  ],
  [false, true, false, true, false]);
expect('a custom answer must be non-blank, and an unknown question id makes the form incomplete',
  [
    np.inputFormIsComplete(singleForm, draftWith(singleForm, { q1: { useCustom: true } })),
    np.inputFormIsComplete(singleForm, draftWith(singleForm, { q1: { useCustom: true, customText: '  ' } })),
    np.inputFormIsComplete(singleForm, draftWith(singleForm, { q1: { useCustom: true, customText: ' ok ' } })),
    np.inputFormIsComplete(multiForm, draftWith(multiForm, { q1: { useCustom: true, customText: ' x' } })),
    np.inputFormIsComplete(singleForm, new Map()),
  ],
  [false, false, true, false, false]);
expect('answers are encoded per question, trimming custom text and keeping multi-selects as lists',
  [
    np.encodeInputFormAnswers(singleForm,
      draftWith(singleForm, { q1: { optionIds: ['o1', 'o2'], useCustom: true, customText: '  c  ' } })),
    np.encodeInputFormAnswers(multiForm,
      draftWith(multiForm, { q1: { optionIds: ['o1'] }, q2: { optionIds: ['x'], useCustom: true, customText: ' t ' } })),
    np.encodeInputFormAnswers(singleForm, np.initialInputDrafts(singleForm)),
    np.encodeInputFormAnswers(singleForm, new Map()),
  ],
  [{ q1: { customText: 'c', optionIds: ['o1'] } },
    { q1: { optionIds: ['o1'] }, q2: { customText: 't', optionIds: ['x'] } },
    { q1: {} },
    {}]);

finish();
