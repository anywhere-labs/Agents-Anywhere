// Mirrors android/feature/sessiondetail/SessionRuntimeState.kt notice-input helpers:
// inputFields (schema-driven text fields), coerceInput (typed coercion + required
// validation), inputRequestForm / buildPayload (uiSchema question form).
import { RemoteNoticeAction, RemoteRuntimeNotice } from 'network';

export interface NoticeInputField {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

export interface NoticeAnswerDraft {
  optionIds: string[];
  customText: string;
  useCustom: boolean;
}

export interface NoticeInputRequestOption {
  id: string;
  label: string;
  description: string;
}

export interface NoticeInputRequestQuestion {
  id: string;
  prompt: string;
  header: string;
  multiple: boolean;
  allowCustom: boolean;
  options: NoticeInputRequestOption[];
}

export interface NoticeInputRequestForm {
  action: RemoteNoticeAction;
  questions: NoticeInputRequestQuestion[];
}

// Parse action.input.schema (JSON schema subset: required + properties with
// title/type) into renderable fields. Falls back to a single required "value"
// field when input.required but the schema has no properties.
export function noticeInputFields(action: RemoteNoticeAction): NoticeInputField[] {
  const input = action.input;
  if (input === null || input === undefined) {
    return [];
  }
  const schema: Record<string, Object> | null = input.schema;
  if (schema === null) {
    return input.required ? [makeValueField()] : [];
  }
  const requiredRaw = schema['required'];
  const requiredKeys: string[] = [];
  if (Array.isArray(requiredRaw)) {
    for (const item of requiredRaw as Object[]) {
      if (typeof item === 'string') {
        requiredKeys.push(item);
      }
    }
  }
  const properties: Record<string, Object> | null = objOrNull(schema['properties']);
  if (properties === null) {
    return input.required ? [makeValueField()] : [];
  }
  const fields: NoticeInputField[] = [];
  const keys: string[] = Object.keys(properties);
  for (const key of keys) {
    const property: Record<string, Object> | null = objOrNull(properties[key]);
    const label = stringOr(property === null ? null : property['title'], key);
    const type = stringOr(property === null ? null : property['type'], 'string');
    const required = requiredKeys.indexOf(key) >= 0;
    const field: NoticeInputField = {
      key: key,
      label: label,
      type: type,
      required: required
    };
    fields.push(field);
  }
  if (fields.length > 0) {
    return fields;
  }
  return input.required ? [makeValueField()] : [];
}

// Coerce raw string values into a typed payload: integer -> number,
// boolean -> boolean, number -> number, string stays; required blanks fail.
export function coerceNoticeInput(action: RemoteNoticeAction,
  rawValues: Map<string, string>): Record<string, Object> | null {
  const fields = noticeInputFields(action);
  if (fields.length === 0) {
    return null;
  }
  const payload: Record<string, Object> = {};
  for (const field of fields) {
    const raw = rawValues.has(field.key) ? rawValues.get(field.key) : undefined;
    const value = raw === undefined ? '' : raw.trim();
    if (field.required && value.length === 0) {
      throw new Error(`${field.label} is required.`);
    }
    if (value.length === 0) {
      continue;
    }
    if (field.type === 'integer') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        throw new Error(`${field.label} must be an integer.`);
      }
      payload[field.key] = parsed;
    } else if (field.type === 'number') {
      const parsed = Number.parseFloat(value);
      if (Number.isNaN(parsed)) {
        throw new Error(`${field.label} must be a number.`);
      }
      payload[field.key] = parsed;
    } else if (field.type === 'boolean') {
      const lowered = value.toLowerCase();
      if (lowered === 'true' || lowered === 'yes' || lowered === '1') {
        payload[field.key] = true;
      } else if (lowered === 'false' || lowered === 'no' || lowered === '0') {
        payload[field.key] = false;
      } else {
        throw new Error(`${field.label} must be true or false.`);
      }
    } else {
      payload[field.key] = value;
    }
  }
  return payload;
}

// Parse the input_request question form from an action's uiSchema
// (component: inputRequest, version: 1). Returns null when the notice is not
// an input_request or the schema is missing/malformed.
export function noticeInputRequestForm(notice: RemoteRuntimeNotice): NoticeInputRequestForm | null {
  if (notice.interactionType !== 'input_request') {
    return null;
  }
  const actions = notice.actions;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const input = action.input;
    if (input === null || input === undefined) {
      continue;
    }
    const uiSchema: Record<string, Object> | null = input.uiSchema;
    if (uiSchema === null) {
      continue;
    }
    if (stringOr(uiSchema['component'], '') !== 'inputRequest' ||
      Number(uiSchema['version']) !== 1) {
      continue;
    }
    const rawQuestions = uiSchema['questions'];
    if (!Array.isArray(rawQuestions)) {
      continue;
    }
    const questions: NoticeInputRequestQuestion[] = [];
    let valid = true;
    for (const rawItem of rawQuestions as Object[]) {
      const question = parseNoticeQuestion(rawItem);
      if (question === null) {
        valid = false;
        break;
      }
      questions.push(question);
    }
    if (!valid || questions.length === 0) {
      return null;
    }
    const form: NoticeInputRequestForm = {
      action: action,
      questions: questions
    };
    return form;
  }
  return null;
}

export function isNoticeFormComplete(form: NoticeInputRequestForm,
  drafts: Map<string, NoticeAnswerDraft>): boolean {
  for (const question of form.questions) {
    const draft = drafts.has(question.id) ? drafts.get(question.id) : undefined;
    if (draft === undefined) {
      return false;
    }
    const optionCount = draft.optionIds.length;
    const hasCustom = draft.useCustom && draft.customText.trim().length > 0;
    if (!question.multiple && optionCount > 1) {
      return false;
    }
    if (optionCount === 0 && !hasCustom) {
      return false;
    }
  }
  return true;
}

// Build the answers payload: { answers: { [questionId]: { optionIds, customText? } } }
export function buildNoticeFormPayload(form: NoticeInputRequestForm,
  drafts: Map<string, NoticeAnswerDraft>): Record<string, Object> {
  const answers: Record<string, Object> = {};
  for (const question of form.questions) {
    const draft = drafts.has(question.id) ? drafts.get(question.id) : undefined;
    const answer: Record<string, Object> = { 'optionIds': [] };
    if (draft !== undefined) {
      answer['optionIds'] = draft.optionIds;
      const customText = draft.useCustom ? draft.customText.trim() : '';
      if (customText.length > 0) {
        answer['customText'] = customText;
      }
    }
    answers[question.id] = answer;
  }
  const payload: Record<string, Object> = { 'answers': answers };
  return payload;
}

function parseNoticeQuestion(rawItem: Object): NoticeInputRequestQuestion | null {
  const question = objOrNull(rawItem);
  if (question === null) {
    return null;
  }
  const id = stringOr(question['id'], '');
  const prompt = stringOr(question['prompt'], '');
  if (id.length === 0 || prompt.length === 0) {
    return null;
  }
  const header = stringOr(question['header'], '');
  const multiple = question['multiple'] === true;
  const allowCustom = question['allowCustom'] !== false;
  const rawOptions = question['options'];
  const options: NoticeInputRequestOption[] = [];
  if (Array.isArray(rawOptions)) {
    for (const rawOption of rawOptions as Object[]) {
      const optionRecord = objOrNull(rawOption);
      if (optionRecord === null) {
        return null;
      }
      const optionId = stringOr(optionRecord['id'], '');
      const optionLabel = stringOr(optionRecord['label'], '');
      if (optionId.length === 0 || optionLabel.length === 0) {
        return null;
      }
      const option: NoticeInputRequestOption = {
        id: optionId,
        label: optionLabel,
        description: stringOr(optionRecord['description'], '')
      };
      options.push(option);
    }
  }
  const result: NoticeInputRequestQuestion = {
    id: id,
    prompt: prompt,
    header: header,
    multiple: multiple,
    allowCustom: allowCustom,
    options: options
  };
  return result;
}

function makeValueField(): NoticeInputField {
  const field: NoticeInputField = {
    key: 'value',
    label: 'Value',
    type: 'string',
    required: true
  };
  return field;
}

function objOrNull(value: Object | null | undefined): Record<string, Object> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, Object>;
}

function stringOr(value: Object | null | undefined, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}
