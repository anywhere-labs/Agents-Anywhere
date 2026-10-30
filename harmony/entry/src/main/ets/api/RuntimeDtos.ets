import {
  arrayField, booleanOr, numberOr, objectField, optionalString, requireString, stringOr,
  stringOrFallbackWhenBlank,
} from './ApiJson';

/**
 * Runtime live DTOs: state, capabilities, notices and commands.
 *
 * Port of `api/RuntimeCatalogDtos.kt` plus the runtime portions of
 * `SessionsDtos.kt`.
 *
 * These are the non-durable facts the Runtime reports while a session is open.
 * Capabilities gate every action the composer offers, and notices carry the
 * approvals the user must answer, so the defaults here decide real behaviour:
 * a capability is usable only when it is `supported && available && allowed`,
 * and a notice missing `responseRequired` is treated as informational.
 */

// ------------------------------------------------------------------ capabilities

export interface RemoteRuntimeCapabilityDto {
  capabilityId?: string;
  version?: string;
  scope?: string;
  runtime?: string;
  runtimeId?: string;
  runtimeType?: string;
  sessionId?: string;
  supported?: boolean;
  available?: boolean;
  allowed?: boolean;
  unavailableReason?: string;
  parameters?: Object;
}

export interface RemoteRuntimeCapability {
  capabilityId: string;
  version: string;
  scope: string;
  runtime: string | null;
  runtimeId: string | null;
  runtimeType: string | null;
  sessionId: string | null;
  supported: boolean;
  available: boolean;
  allowed: boolean;
  unavailableReason: string | null;
  parameters: Object;
}

export function parseRuntimeCapability(dto: RemoteRuntimeCapabilityDto): RemoteRuntimeCapability {
  const runtime: string | null = optionalString(dto.runtime);
  return {
    capabilityId: stringOr(dto.capabilityId, ''),
    version: stringOrFallbackWhenBlank(dto.version, '1'),
    scope: stringOrFallbackWhenBlank(dto.scope, 'runtime'),
    runtime: runtime,
    runtimeId: optionalString(dto.runtimeId),
    runtimeType: optionalString(dto.runtimeType) ?? runtime,
    sessionId: optionalString(dto.sessionId),
    supported: booleanOr(dto.supported, true),
    available: booleanOr(dto.available, true),
    allowed: booleanOr(dto.allowed, true),
    unavailableReason: optionalString(dto.unavailableReason),
    parameters: objectField(dto.parameters) ?? EMPTY,
  };
}

/** True only when nothing blocks the capability. */
export function capabilityUsable(capability: RemoteRuntimeCapability): boolean {
  return capability.supported && capability.available && capability.allowed;
}

export interface RemoteRuntimeCapabilitySetDto {
  revision?: number;
  capabilities?: RemoteRuntimeCapabilityDto[];
}

export interface RemoteRuntimeCapabilitySet {
  revision: number;
  capabilities: RemoteRuntimeCapability[];
}

/** An absent set parses to revision 0 with no capabilities. */
export function parseRuntimeCapabilitySet(value: Object | undefined): RemoteRuntimeCapabilitySet {
  const dto: RemoteRuntimeCapabilitySetDto | undefined =
    objectField(value) as RemoteRuntimeCapabilitySetDto | undefined;
  if (dto === undefined) {
    return { revision: 0, capabilities: [] };
  }
  const capabilities: RemoteRuntimeCapability[] = [];
  for (const entry of arrayField(dto.capabilities)) {
    capabilities.push(parseRuntimeCapability(entry as RemoteRuntimeCapabilityDto));
  }
  return { revision: numberOr(dto.revision, 0), capabilities: capabilities };
}

/** Capability ids the client asks about, matching Android's constants. */
export class SessionCapability {
  static readonly SEND_MESSAGE: string = 'session.send_message';
  static readonly STEER: string = 'session.steer';
  static readonly INTERRUPT: string = 'session.interrupt';
  static readonly APPROVAL: string = 'session.interaction.approval';
  static readonly COMMANDS: string = 'session.commands';
  static readonly COMMAND_EXECUTE: string = 'session.command.execute';
  static readonly CATALOG_MODEL: string = 'catalog.model';
  static readonly CATALOG_PERMISSION: string = 'catalog.permission';
  static readonly ATTACHMENT: string = 'runtime.attachment';
}

/**
 * Resolves whether a capability is usable.
 *
 * The lookup order is Android's: an exact runtime instance id, then a
 * runtime-scoped entry, then the type, then the global entry. Getting this order
 * wrong would let a generic entry override a stricter instance-specific one.
 */
export function isCapabilityUsable(
  set: RemoteRuntimeCapabilitySet,
  capabilityId: string,
  runtimeId: string,
  runtimeType: string,
): boolean {
  const capability: RemoteRuntimeCapability | null =
    findRuntimeCapability(set, capabilityId, runtimeId, runtimeType);
  return capability !== null && capabilityUsable(capability);
}

/**
 * The capability entry a scope resolves to, or `null` when nothing matches.
 *
 * Android's `SessionRuntimeState.find` / `NewSessionRuntimeCapabilities.find`:
 * the second step matches the *runtime* field against the runtime instance id,
 * because a runtime-scoped entry may name the instance instead of the type.
 */
export function findRuntimeCapability(
  set: RemoteRuntimeCapabilitySet,
  capabilityId: string,
  runtimeId: string | null,
  runtimeType: string | null,
): RemoteRuntimeCapability | null {
  const exact: RemoteRuntimeCapability | null =
    runtimeId === null ? null : findCapability(set, capabilityId, runtimeId, null, null);
  if (exact !== null) {
    return exact;
  }
  const runtimeScoped: RemoteRuntimeCapability | null =
    runtimeId === null ? null : findCapability(set, capabilityId, null, runtimeId, null);
  if (runtimeScoped !== null) {
    return runtimeScoped;
  }
  const byType: RemoteRuntimeCapability | null =
    runtimeType === null ? null : findCapability(set, capabilityId, null, null, runtimeType);
  if (byType !== null) {
    return byType;
  }
  return findCapability(set, capabilityId, null, null, null);
}

function findCapability(
  set: RemoteRuntimeCapabilitySet,
  capabilityId: string,
  runtimeId: string | null,
  runtime: string | null,
  runtimeType: string | null,
): RemoteRuntimeCapability | null {
  for (const capability of set.capabilities) {
    if (capability.capabilityId !== capabilityId) {
      continue;
    }
    if (runtimeId !== null) {
      if (capability.runtimeId === runtimeId) {
        return capability;
      }
      continue;
    }
    if (runtime !== null) {
      if (capability.runtimeId === null && capability.runtime === runtime) {
        return capability;
      }
      continue;
    }
    if (runtimeType !== null) {
      if (capability.runtimeType === runtimeType && capability.runtimeId === null) {
        return capability;
      }
      continue;
    }
    if (capability.runtimeId === null && capability.runtime === null && capability.runtimeType === null) {
      return capability;
    }
  }
  return null;
}

// ---------------------------------------------------------------------- notices

export interface RemoteRuntimeNoticeActionInputDto {
  required?: boolean;
  schema?: Object;
  uiSchema?: Object;
}

export interface RemoteRuntimeNoticeActionInput {
  required: boolean;
  schema: Object | null;
  uiSchema: Object | null;
}

export interface RemoteRuntimeNoticeActionDto {
  actionId?: string;
  label?: string;
  style?: string;
  input?: RemoteRuntimeNoticeActionInputDto;
}

export interface RemoteRuntimeNoticeAction {
  actionId: string;
  label: string;
  style: string;
  input: RemoteRuntimeNoticeActionInput;
  /** Every other top-level key, preserved so a newer Server field survives. */
  extra: Map<string, Object>;
}

export interface RemoteRuntimeNoticeBlockingDto {
  scope?: string;
  targetId?: string;
}

export interface RemoteRuntimeNoticeBlocking {
  scope: string;
  targetId: string;
}

export interface RemoteRuntimeNoticeDto {
  noticeId?: string;
  type?: string;
  sessionId?: string;
  source?: Object;
  title?: string;
  message?: string;
  severity?: string;
  status?: string;
  interactionType?: string;
  blocking?: RemoteRuntimeNoticeBlockingDto;
  responseRequired?: boolean;
  actions?: RemoteRuntimeNoticeActionDto[];
  context?: Object;
  metadata?: Object;
  expiresAt?: string;
  revision?: number;
  updatedSeq?: number;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string;
}

export interface RemoteRuntimeNotice {
  noticeId: string;
  type: string;
  sessionId: string;
  source: Object;
  title: string;
  message: string | null;
  severity: string;
  status: string;
  interactionType: string | null;
  blocking: RemoteRuntimeNoticeBlocking | null;
  responseRequired: boolean;
  actions: RemoteRuntimeNoticeAction[];
  context: Object;
  metadata: Object;
  expiresAt: string | null;
  revision: number;
  updatedSeq: number;
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
}

const NOTICE_ACTION_KNOWN_KEYS: string[] = ['actionId', 'label', 'style', 'input'];

export function parseRuntimeNoticeAction(dto: RemoteRuntimeNoticeActionDto): RemoteRuntimeNoticeAction {
  const inputDto: RemoteRuntimeNoticeActionInputDto | undefined =
    objectField(dto.input) as RemoteRuntimeNoticeActionInputDto | undefined;
  const input: RemoteRuntimeNoticeActionInput = inputDto === undefined
    ? { required: false, schema: null, uiSchema: null }
    : {
      required: booleanOr(inputDto.required, false),
      schema: objectField(inputDto.schema) ?? null,
      uiSchema: objectField(inputDto.uiSchema) ?? null,
    };

  // Preserve unknown action keys verbatim, matching Android's `unknown` map.
  const extra: Map<string, Object> = new Map();
  const raw: Record<string, Object> = dto as Record<string, Object>;
  for (const key of Object.keys(raw)) {
    if (!NOTICE_ACTION_KNOWN_KEYS.includes(key)) {
      extra.set(key, raw[key]);
    }
  }

  return {
    actionId: stringOr(dto.actionId, ''),
    label: stringOr(dto.label, ''),
    style: stringOrFallbackWhenBlank(dto.style, 'secondary'),
    input: input,
    extra: extra,
  };
}

export function parseRuntimeNotice(dto: RemoteRuntimeNoticeDto): RemoteRuntimeNotice {
  const blockingDto: RemoteRuntimeNoticeBlockingDto | undefined =
    objectField(dto.blocking) as RemoteRuntimeNoticeBlockingDto | undefined;
  const blocking: RemoteRuntimeNoticeBlocking | null = blockingDto === undefined
    ? null
    : {
      scope: stringOr(blockingDto.scope, ''),
      targetId: stringOr(blockingDto.targetId, ''),
    };
  const actions: RemoteRuntimeNoticeAction[] = [];
  for (const entry of arrayField(dto.actions)) {
    actions.push(parseRuntimeNoticeAction(entry as RemoteRuntimeNoticeActionDto));
  }
  return {
    noticeId: stringOr(dto.noticeId, ''),
    type: stringOrFallbackWhenBlank(dto.type, 'unknown'),
    sessionId: stringOr(dto.sessionId, ''),
    source: objectField(dto.source) ?? EMPTY,
    title: stringOr(dto.title, ''),
    message: optionalString(dto.message),
    severity: stringOrFallbackWhenBlank(dto.severity, 'info'),
    status: stringOrFallbackWhenBlank(dto.status, 'open'),
    interactionType: optionalString(dto.interactionType),
    blocking: blocking,
    responseRequired: booleanOr(dto.responseRequired, false),
    actions: actions,
    context: objectField(dto.context) ?? EMPTY,
    metadata: objectField(dto.metadata) ?? EMPTY,
    expiresAt: optionalString(dto.expiresAt),
    revision: numberOr(dto.revision, 1),
    updatedSeq: numberOr(dto.updatedSeq, 0),
    createdAt: optionalString(dto.createdAt),
    updatedAt: optionalString(dto.updatedAt),
    resolvedAt: optionalString(dto.resolvedAt),
  };
}

export function parseRuntimeNoticeList(value: Object[] | undefined): RemoteRuntimeNotice[] {
  const notices: RemoteRuntimeNotice[] = [];
  for (const entry of arrayField(value)) {
    notices.push(parseRuntimeNotice(entry as RemoteRuntimeNoticeDto));
  }
  return notices;
}

/** True when the notice is still asking for something. */
export function noticeIsOpen(notice: RemoteRuntimeNotice): boolean {
  return notice.status === 'open';
}

/** True when the notice blocks the session until it is answered. */
export function noticeBlocksSession(notice: RemoteRuntimeNotice, sessionId: string): boolean {
  if (!noticeIsOpen(notice)) {
    return false;
  }
  if (!notice.responseRequired) {
    return false;
  }
  const blocking: RemoteRuntimeNoticeBlocking | null = notice.blocking;
  if (blocking === null) {
    return false;
  }
  return blocking.scope === 'session' ? blocking.targetId === sessionId : blocking.targetId.length > 0;
}

// ------------------------------------------------------------------ runtime state

export interface RemoteSessionRuntimeStateDto {
  sessionId?: string;
  runtime?: string;
  runtimeId?: string;
  runtimeType?: string;
  runtimeName?: string;
  externalSessionId?: string;
  status?: string;
  selections?: Record<string, Object>;
  statusReason?: string;
  error?: Object;
  metadata?: Object;
  updatedSeq?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface RemoteSessionRuntimeState {
  sessionId: string;
  runtime: string;
  runtimeId: string;
  runtimeType: string;
  runtimeName: string;
  externalSessionId: string | null;
  status: string;
  /** Non-string selections collapse to null, matching Android. */
  selections: Map<string, string | null>;
  statusReason: string | null;
  error: Object | null;
  metadata: Object;
  updatedSeq: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export function parseRuntimeState(dto: RemoteSessionRuntimeStateDto): RemoteSessionRuntimeState {
  const runtime: string = stringOrFallbackWhenBlank(
    stringOrFallbackWhenBlank(dto.runtime, dto.runtimeType ?? ''), '',
  );
  const runtimeId: string = stringOrFallbackWhenBlank(dto.runtimeId, runtime);
  const runtimeType: string = stringOrFallbackWhenBlank(dto.runtimeType, runtime);
  const runtimeName: string = stringOrFallbackWhenBlank(dto.runtimeName, runtimeId);

  const selections: Map<string, string | null> = new Map();
  const rawSelections: Record<string, Object> | undefined = dto.selections;
  if (rawSelections !== undefined && rawSelections !== null) {
    for (const key of Object.keys(rawSelections)) {
      const value: Object = rawSelections[key];
      selections.set(key, typeof value === 'string' ? value : null);
    }
  }

  return {
    sessionId: stringOr(dto.sessionId, ''),
    runtime: runtime,
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    runtimeName: runtimeName,
    externalSessionId: optionalString(dto.externalSessionId),
    // A blank status is reported as `unknown` rather than as an empty string.
    status: stringOrFallbackWhenBlank(dto.status, 'unknown'),
    selections: selections,
    statusReason: optionalString(dto.statusReason),
    error: objectField(dto.error) ?? null,
    metadata: objectField(dto.metadata) ?? EMPTY,
    updatedSeq: numberOr(dto.updatedSeq, 0),
    createdAt: optionalString(dto.createdAt),
    updatedAt: optionalString(dto.updatedAt),
  };
}

/** Runtime statuses the composer keys its placeholder and interrupt button on. */
export class RuntimeStatus {
  static readonly UNKNOWN: string = 'unknown';
  static readonly IDLE: string = 'idle';
  static readonly WAITING: string = 'waiting';
  static readonly PENDING: string = 'pending';
  static readonly RUNNING: string = 'running';
  static readonly STOPPING: string = 'stopping';
  static readonly WAITING_APPROVAL: string = 'waiting_approval';
  static readonly BLOCKED: string = 'blocked';
  static readonly ERROR: string = 'error';
}

// --------------------------------------------------------------------- commands

export interface RemoteSessionCommandDto {
  id?: string;
  title?: string;
  description?: string;
  aliases?: string[];
  category?: string;
  scope?: string;
  enabled?: boolean;
  disabledReason?: string;
  acceptsArgs?: boolean;
  argsSchema?: Object;
  metadata?: Object;
}

export interface RemoteSessionCommand {
  id: string;
  title: string;
  description: string | null;
  aliases: string[];
  category: string | null;
  scope: string;
  enabled: boolean;
  disabledReason: string | null;
  acceptsArgs: boolean;
  argsSchema: Object | null;
  metadata: Object;
}

export function parseRemoteSessionCommand(dto: RemoteSessionCommandDto): RemoteSessionCommand {
  const aliases: string[] = [];
  for (const entry of arrayField(dto.aliases)) {
    if (typeof entry === 'string' && entry.length > 0) {
      aliases.push(entry);
    }
  }
  return {
    id: stringOr(dto.id, ''),
    title: stringOr(dto.title, ''),
    description: optionalString(dto.description),
    aliases: aliases,
    category: optionalString(dto.category),
    scope: stringOrFallbackWhenBlank(dto.scope, 'session'),
    enabled: booleanOr(dto.enabled, true),
    disabledReason: optionalString(dto.disabledReason),
    acceptsArgs: booleanOr(dto.acceptsArgs, false),
    argsSchema: objectField(dto.argsSchema) ?? null,
    metadata: objectField(dto.metadata) ?? EMPTY,
  };
}

export interface RemoteSessionCommandListDto {
  commands?: RemoteSessionCommandDto[];
  serverTime?: string;
}

export function parseRemoteSessionCommandList(dto: RemoteSessionCommandListDto): RemoteSessionCommand[] {
  const commands: RemoteSessionCommand[] = [];
  for (const entry of arrayField(dto.commands)) {
    commands.push(parseRemoteSessionCommand(entry as RemoteSessionCommandDto));
  }
  return commands;
}

// ----------------------------------------------------------------- rpc responses

/** `ok` defaults to false: an absent flag must never read as success. */
export interface RemoteRpcErrorDto {
  code?: string;
  message?: string;
}

export interface RemoteRpcResponseDto {
  ok?: boolean;
  error?: RemoteRpcErrorDto;
}

export interface RemoteRpcResponse {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export function parseRpcResponse(dto: RemoteRpcResponseDto): RemoteRpcResponse {
  const error: RemoteRpcErrorDto | undefined = objectField(dto.error) as RemoteRpcErrorDto | undefined;
  return {
    ok: dto.ok === true,
    errorCode: error === undefined ? null : optionalString(error.code),
    errorMessage: error === undefined ? null : optionalString(error.message),
  };
}

const EMPTY: Object = JSON.parse('{}') as Object;
