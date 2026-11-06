import {
  RemoteRuntimeNotice, RemoteRuntimeNoticeAction,
} from '../../api/RuntimeDtos';
import { arrayField, objectField, stringOr } from '../../api/ApiJson';

/**
 * Notice presentation logic: action ordering, labels, field extraction and
 * input-request forms.
 *
 * Port of the notice helpers in `feature/sessiondetail/SessionRuntimeState.kt`.
 *
 * Labels resolve to a *kind* rather than a string because ArkUI resource
 * references must be literal `$r('app.string.…')` calls; the UI maps the kind to
 * the resource, which keeps the copy in the resource table like Android's
 * `stringResource` calls do.
 */

/** A notice status the user can still act on. */
const RESPONDABLE_STATUSES: string[] = ['open', 'failed'];
/** Statuses that keep an interaction visible but not re-answerable. */
const OPEN_INTERACTION_STATUSES: string[] = [
  'open', 'responding', 'response_accepted', 'resolving', 'failed',
];

export function noticeIsRespondable(notice: RemoteRuntimeNotice): boolean {
  return RESPONDABLE_STATUSES.includes(notice.status);
}

/** True while an interaction notice is still occupying the session. */
export function noticeIsOpenInteraction(notice: RemoteRuntimeNotice): boolean {
  return OPEN_INTERACTION_STATUSES.includes(notice.status);
}

export function isDestructiveNotice(notice: RemoteRuntimeNotice): boolean {
  return notice.severity === 'error' || notice.status === 'failed';
}

/** Which resource the action's label comes from. */
export enum NoticeActionLabelKind {
  Server = 0,
  Approve = 1,
  ApproveSession = 2,
  Deny = 3,
  Cancel = 4,
  Submit = 5,
}

/**
 * Android's ordering: destructive answers first, then the session-scoped
 * approval, then the plain approval, then primary, then secondary.
 */
export function noticeActionOrder(action: RemoteRuntimeNoticeAction): number {
  const id: string = action.actionId;
  if (id === 'reject' || id === 'cancel' || id === 'dismiss') {
    return 0;
  }
  if (id === 'approve_for_session') {
    return 1;
  }
  if (id === 'approve') {
    return 2;
  }
  return action.style === 'primary' ? 2 : 1;
}

export function sortedNoticeActions(notice: RemoteRuntimeNotice): RemoteRuntimeNoticeAction[] {
  return notice.actions.slice().sort(
    (left: RemoteRuntimeNoticeAction, right: RemoteRuntimeNoticeAction) =>
      noticeActionOrder(left) - noticeActionOrder(right),
  );
}

export function noticeActionLabelKind(action: RemoteRuntimeNoticeAction): NoticeActionLabelKind {
  const id: string = action.actionId;
  if (id === 'approve') {
    return NoticeActionLabelKind.Approve;
  }
  if (id === 'approve_for_session') {
    return NoticeActionLabelKind.ApproveSession;
  }
  if (id === 'reject') {
    return NoticeActionLabelKind.Deny;
  }
  if (id === 'cancel' || id === 'dismiss') {
    return NoticeActionLabelKind.Cancel;
  }
  if (id === 'submit') {
    return NoticeActionLabelKind.Submit;
  }
  return NoticeActionLabelKind.Server;
}

/** Fallback text for a Server-labelled action. */
export function noticeActionServerLabel(action: RemoteRuntimeNoticeAction): string {
  return action.label.length > 0 ? action.label : action.actionId;
}

/** Which glyph an action's button uses. */
export enum NoticeActionIcon {
  X = 0,
  Shield = 1,
  Check = 2,
}

export function noticeActionIcon(action: RemoteRuntimeNoticeAction): NoticeActionIcon {
  const id: string = action.actionId;
  if (id === 'reject' || id === 'cancel' || id === 'dismiss') {
    return NoticeActionIcon.X;
  }
  if (id === 'approve_for_session') {
    return NoticeActionIcon.Shield;
  }
  return NoticeActionIcon.Check;
}

export function noticeActionIsPrimary(action: RemoteRuntimeNoticeAction): boolean {
  return noticeActionOrder(action) === 2 && action.style === 'primary';
}

// ------------------------------------------------------------------ input fields

export interface RuntimeNoticeInputField {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

/**
 * Fields an action collects before it can be submitted.
 *
 * Derived from `input.schema.properties`; when the schema names no properties
 * but the input is required, Android synthesises a single string field so the
 * user is still asked for something.
 */
export function actionInputFields(action: RemoteRuntimeNoticeAction): RuntimeNoticeInputField[] {
  // `schema` is `Object | null` on the wire DTO while `objectField` takes
  // `Object | undefined`, so null is normalised before the read.
  const schema: Record<string, Object> =
    objectField(action.input.schema ?? undefined) as Record<string, Object> ?? emptyRecord();
  const requiredKeys: string[] = [];
  for (const entry of arrayField(schema['required'])) {
    if (typeof entry === 'string') {
      requiredKeys.push(entry);
    }
  }
  const properties: Record<string, Object> | undefined =
    objectField(schema['properties']) as Record<string, Object> | undefined;

  const fields: RuntimeNoticeInputField[] = [];
  if (properties !== undefined) {
    for (const key of Object.keys(properties)) {
      const property: Record<string, Object> = objectField(properties[key]) as
        Record<string, Object> ?? emptyRecord();
      const rawTitle: string = stringOr(property['title'] as string, '');
      const rawType: string = stringOr(property['type'] as string, '');
      fields.push({
        key: key,
        label: rawTitle.length > 0 ? rawTitle : key,
        type: rawType.length > 0 ? rawType : 'string',
        required: requiredKeys.includes(key),
      });
    }
  }
  if (fields.length > 0) {
    return fields;
  }
  if (action.input.required) {
    return [{ key: 'value', label: 'Value', type: 'string', required: true }];
  }
  return [];
}

/**
 * Validates and converts the raw field values for an action.
 *
 * Returns the decoded object, or null when the action takes no input. The
 * messages are built exactly as Android builds them, including the field label.
 */
export function coerceActionInput(
  action: RemoteRuntimeNoticeAction,
  rawValues: Map<string, string>,
): CoercedInput {
  const fields: RuntimeNoticeInputField[] = actionInputFields(action);
  if (fields.length === 0) {
    return { input: null, error: null };
  }
  const encoded: Map<string, Object> = new Map();
  for (const field of fields) {
    const raw: string = (rawValues.get(field.key) ?? '').trim();
    if (field.required && raw.length === 0) {
      return { input: null, error: `${field.label} is required.` };
    }
    if (raw.length === 0) {
      continue;
    }
    if (field.type === 'integer') {
      const value: number = Number.parseInt(raw, 10);
      if (Number.isNaN(value) || !/^-?\d+$/.test(raw)) {
        return { input: null, error: `${field.label} must be an integer.` };
      }
      encoded.set(field.key, value);
    } else if (field.type === 'number') {
      const value: number = Number(raw);
      if (Number.isNaN(value)) {
        return { input: null, error: `${field.label} must be a number.` };
      }
      encoded.set(field.key, value);
    } else if (field.type === 'boolean') {
      const lower: string = raw.toLowerCase();
      if (lower === 'true' || lower === 'yes' || lower === '1') {
        encoded.set(field.key, true);
      } else if (lower === 'false' || lower === 'no' || lower === '0') {
        encoded.set(field.key, false);
      } else {
        return { input: null, error: `${field.label} must be true or false.` };
      }
    } else {
      encoded.set(field.key, raw);
    }
  }
  const object: Record<string, Object> = {};
  encoded.forEach((value: Object, key: string) => {
    object[key] = value;
  });
  return { input: object as Object, error: null };
}

export interface CoercedInput {
  input: Object | null;
  error: string | null;
}

// ------------------------------------------------------------- input-request form

export interface RuntimeInputRequestOption {
  id: string;
  label: string;
  description: string | null;
}

export interface RuntimeInputRequestQuestion {
  id: string;
  prompt: string;
  header: string | null;
  multiple: boolean;
  allowCustom: boolean;
  options: RuntimeInputRequestOption[];
}

export interface RuntimeInputRequestForm {
  action: RemoteRuntimeNoticeAction;
  questions: RuntimeInputRequestQuestion[];
}

/** One question's answer while the user is filling the form in. */
export class RuntimeInputRequestDraft {
  optionIds: string[] = [];
  customText: string = '';
  useCustom: boolean = false;
}

function nonEmptyText(value: Object | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim().length > 0 ? value : null;
}

/**
 * Extracts the structured question form an input request carries.
 *
 * Android is strict here: the form is only recognised when `interactionType` is
 * `input_request` and an action publishes `uiSchema` with
 * `component == "inputRequest"` and `version == 1`. Any malformed question makes
 * the whole form null, so a partial form is never rendered with missing options.
 */
export function noticeInputRequestForm(notice: RemoteRuntimeNotice): RuntimeInputRequestForm | null {
  if (notice.interactionType !== 'input_request') {
    return null;
  }
  for (const action of notice.actions) {
    const uiSchema: Record<string, Object> | undefined =
      objectField(action.input.uiSchema ?? undefined) as Record<string, Object> | undefined;
    if (uiSchema === undefined) {
      continue;
    }
    if (stringOr(uiSchema['component'] as string, '') !== 'inputRequest') {
      continue;
    }
    const version: Object = uiSchema['version'];
    if (typeof version !== 'number' || version !== 1) {
      continue;
    }
    const rawQuestions: Object[] | undefined = uiSchema['questions'] as Object[] | undefined;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return null;
    }
    const questionIds: Set<string> = new Set();
    const questions: RuntimeInputRequestQuestion[] = [];
    for (const rawQuestion of rawQuestions) {
      const question: Record<string, Object> | undefined =
        objectField(rawQuestion) as Record<string, Object> | undefined;
      if (question === undefined) {
        return null;
      }
      const id: string | null = nonEmptyText(question['id']);
      const prompt: string | null = nonEmptyText(question['prompt']);
      if (id === null || prompt === null || questionIds.has(id)) {
        return null;
      }
      questionIds.add(id);
      const rawOptions: Object[] | undefined = question['options'] as Object[] | undefined;
      if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        return null;
      }
      const optionIds: Set<string> = new Set();
      const options: RuntimeInputRequestOption[] = [];
      for (const rawOption of rawOptions) {
        const option: Record<string, Object> | undefined =
          objectField(rawOption) as Record<string, Object> | undefined;
        if (option === undefined) {
          return null;
        }
        const optionId: string | null = nonEmptyText(option['id']);
        const label: string | null = nonEmptyText(option['label']);
        if (optionId === null || label === null || optionIds.has(optionId)) {
          return null;
        }
        optionIds.add(optionId);
        options.push({
          id: optionId,
          label: label,
          description: nonEmptyText(option['description']),
        });
      }
      questions.push({
        id: id,
        prompt: prompt,
        header: nonEmptyText(question['header']),
        multiple: question['multiple'] === true,
        // Absent `allowCustom` means allowed, matching Android's `!= false`.
        allowCustom: question['allowCustom'] !== false,
        options: options,
      });
    }
    return { action: action, questions: questions };
  }
  return null;
}

export function initialInputDrafts(form: RuntimeInputRequestForm): Map<string, RuntimeInputRequestDraft> {
  const drafts: Map<string, RuntimeInputRequestDraft> = new Map();
  for (const question of form.questions) {
    drafts.set(question.id, new RuntimeInputRequestDraft());
  }
  return drafts;
}

/** True when every question has an acceptable answer. */
export function inputFormIsComplete(
  form: RuntimeInputRequestForm,
  drafts: Map<string, RuntimeInputRequestDraft>,
): boolean {
  for (const question of form.questions) {
    const draft: RuntimeInputRequestDraft | undefined = drafts.get(question.id);
    if (draft === undefined) {
      return false;
    }
    const optionCount: number = draft.optionIds.length;
    if (draft.useCustom) {
      if (draft.customText.trim().length === 0) {
        return false;
      }
      if (question.multiple && optionCount === 0) {
        // A multi-select with a custom answer is still valid on its own.
        continue;
      }
      continue;
    }
    if (question.multiple) {
      if (optionCount === 0) {
        return false;
      }
    } else if (optionCount !== 1) {
      return false;
    }
  }
  return true;
}

/** Encodes the drafts into the `input` object the Server expects. */
export function encodeInputFormAnswers(
  form: RuntimeInputRequestForm,
  drafts: Map<string, RuntimeInputRequestDraft>,
): Object {
  const answers: Record<string, Object> = {};
  for (const question of form.questions) {
    const draft: RuntimeInputRequestDraft | undefined = drafts.get(question.id);
    if (draft === undefined) {
      continue;
    }
    const answer: Record<string, Object> = {};
    if (draft.useCustom) {
      answer['customText'] = draft.customText.trim();
    }
    if (question.multiple) {
      answer['optionIds'] = draft.optionIds;
    } else if (draft.optionIds.length > 0) {
      answer['optionIds'] = [draft.optionIds[0]];
    }
    answers[question.id] = answer as Object;
  }
  return answers as Object;
}

function emptyRecord(): Record<string, Object> {
  return {} as Record<string, Object>;
}
