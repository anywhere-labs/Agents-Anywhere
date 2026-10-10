import { AgentDevice } from '../model/AgentSession';
import {
  arrayField, optionalNumber, optionalString, requireString, stringOrFallbackWhenBlank,
} from './ApiJson';

/**
 * Connector (device) DTOs.
 *
 * Port of `api/DevicesDtos.kt`. Every interface field is optional so an omitted
 * key reads as `undefined`, and the parser applies Android's defaults, including
 * the blank-string-is-absent rule.
 */

const DEFAULT_DEVICE_NAME: string = 'Device';
const DEFAULT_DEVICE_STATUS: string = 'offline';

export interface RemoteDeviceDto {
  id?: string;
  name?: string;
  deviceOs?: string;
  status?: string;
  lastSeenAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Maps a wire device onto the app model; `online` is derived from `status`. */
export function parseRemoteDevice(dto: RemoteDeviceDto): AgentDevice {
  const status: string = stringOrFallbackWhenBlank(dto.status, DEFAULT_DEVICE_STATUS);
  return {
    id: requireString(dto.id, 'id'),
    name: stringOrFallbackWhenBlank(dto.name, DEFAULT_DEVICE_NAME),
    deviceOs: optionalString(dto.deviceOs),
    online: status === 'online',
    lastSeenAt: optionalString(dto.lastSeenAt),
    createdAt: optionalString(dto.createdAt),
  };
}

export interface RemoteDeviceListDto {
  connectors?: RemoteDeviceDto[];
}

export function parseRemoteDeviceList(dto: RemoteDeviceListDto): AgentDevice[] {
  const devices: AgentDevice[] = [];
  for (const entry of arrayField(dto.connectors)) {
    devices.push(parseRemoteDevice(entry as RemoteDeviceDto));
  }
  return devices;
}

/** `{ "connector": ... }` envelope used by create, patch and revoke. */
export interface RemoteDeviceEnvelopeDto {
  connector?: RemoteDeviceDto;
}

/** `{ "runtime": ... }` envelope used by the runtime endpoints. */
export interface RemoteDeviceRuntimeEnvelopeDto {
  runtime?: RemoteDeviceRuntimeDto;
}

export function parseRemoteDeviceEnvelope(dto: RemoteDeviceEnvelopeDto): AgentDevice {
  if (dto.connector === undefined || dto.connector === null) {
    requireString(undefined, 'connector');
  }
  return parseRemoteDevice(dto.connector as RemoteDeviceDto);
}

// ------------------------------------------------------------------- runtimes

/**
 * Runtime lifecycle states, byte-identical to `RemoteDeviceRuntimeStatus`.
 *
 * Android parses the wire value into an enum and falls back to `Unknown` for
 * anything unrecognized, which is what keeps a newer Server from breaking the
 * list.
 */
export class DeviceRuntimeStatus {
  static readonly STOPPED: string = 'stopped';
  static readonly DISCOVERING: string = 'discovering';
  static readonly AVAILABLE: string = 'available';
  static readonly UNAVAILABLE: string = 'unavailable';
  static readonly VALIDATING: string = 'validating';
  static readonly STARTING: string = 'starting';
  static readonly RUNNING: string = 'running';
  static readonly STOPPING: string = 'stopping';
  static readonly ERROR: string = 'error';
  static readonly UNKNOWN: string = 'unknown';
}

const KNOWN_RUNTIME_STATUSES: string[] = [
  DeviceRuntimeStatus.STOPPED,
  DeviceRuntimeStatus.DISCOVERING,
  DeviceRuntimeStatus.AVAILABLE,
  DeviceRuntimeStatus.UNAVAILABLE,
  DeviceRuntimeStatus.VALIDATING,
  DeviceRuntimeStatus.STARTING,
  DeviceRuntimeStatus.RUNNING,
  DeviceRuntimeStatus.STOPPING,
  DeviceRuntimeStatus.ERROR,
  DeviceRuntimeStatus.UNKNOWN,
];

export function parseDeviceRuntimeStatus(value: string | undefined): string {
  const normalized: string = stringOrFallbackWhenBlank(value, DeviceRuntimeStatus.UNKNOWN).toLowerCase();
  return KNOWN_RUNTIME_STATUSES.includes(normalized) ? normalized : DeviceRuntimeStatus.UNKNOWN;
}

export interface RemoteDeviceRuntimeDto {
  connectorId?: string;
  runtimeId?: string;
  runtimeType?: string;
  /** The instance's own name, which is what iOS's `sessionDisplayName` prefers. */
  name?: string;
  displayName?: string;
  /** The runtime *type*'s display name; iOS's row's second line opens with it. */
  typeDisplayName?: string;
  present?: boolean;
  configured?: boolean;
  active?: boolean;
  status?: string;
  discovery?: Object;
  metadata?: Object;
  schema?: Object;
  uiSchema?: Object;
  defaults?: Object;
  config?: Object;
  error?: Object;
  lastDiscoveredAt?: string;
  updatedAt?: string;
}

export interface RemoteDeviceRuntime {
  connectorId: string;
  id: string;
  type: string;
  /**
   * The type's display name, as the Server sends it (`typeDisplayName`).
   *
   * Optional because older fixtures and the app's own empty-instance literal do
   * not carry it; the row falls back to `runtimeTypeLabel(type)`.
   */
  typeDisplayName?: string;
  /**
   * The instance's own name (`name`).
   *
   * Optional for the same reason; `runtimeInstanceName` below is the reader that
   * applies iOS's fallback order.
   */
  name?: string;
  displayName: string;
  present: boolean;
  configured: boolean;
  active: boolean;
  status: string;
  discovery: Object;
  metadata: Object;
  schema: Object | null;
  uiSchema: Object;
  /**
   * The schema's default values.
   *
   * `DeviceRuntimeView` always carries this alongside `schema`/`uiSchema`, so the
   * configuration sheet can seed its form without a second request.
   */
  defaults: Object;
  config: Object | null;
  error: Object | null;
  lastDiscoveredAt: string | null;
  updatedAt: string | null;
}

const EMPTY_OBJECT: Object = JSON.parse('{}') as Object;

export function parseRemoteDeviceRuntime(
  dto: RemoteDeviceRuntimeDto,
  fallbackConnectorId: string,
): RemoteDeviceRuntime {
  return {
    connectorId: stringOrFallbackWhenBlank(dto.connectorId, fallbackConnectorId),
    id: stringOrFallbackWhenBlank(dto.runtimeId, ''),
    type: stringOrFallbackWhenBlank(dto.runtimeType, ''),
    typeDisplayName: optionalString(dto.typeDisplayName) ?? undefined,
    name: optionalString(dto.name) ?? undefined,
    displayName: stringOrFallbackWhenBlank(dto.displayName, ''),
    present: dto.present === true,
    configured: dto.configured === true,
    active: dto.active === true,
    status: parseDeviceRuntimeStatus(dto.status),
    discovery: dto.discovery ?? EMPTY_OBJECT,
    metadata: dto.metadata ?? EMPTY_OBJECT,
    schema: dto.schema ?? null,
    uiSchema: dto.uiSchema ?? EMPTY_OBJECT,
    defaults: dto.defaults ?? EMPTY_OBJECT,
    config: dto.config ?? null,
    error: dto.error ?? null,
    lastDiscoveredAt: optionalString(dto.lastDiscoveredAt),
    updatedAt: optionalString(dto.updatedAt),
  };
}

export interface RemoteDeviceRuntimeList {
  connectorId: string;
  runtimes: RemoteDeviceRuntime[];
  serverTime: string | null;
}

export interface RemoteDeviceRuntimeListDto {
  connectorId?: string;
  runtimes?: RemoteDeviceRuntimeDto[];
  serverTime?: string;
}

/**
 * Parses the runtime inventory.
 *
 * The connector id is taken from the response when present and from the request
 * otherwise, so a Server that omits it still produces a usable list.
 */
export function parseRemoteDeviceRuntimeList(
  dto: RemoteDeviceRuntimeListDto,
  fallbackConnectorId: string,
): RemoteDeviceRuntimeList {
  const runtimes: RemoteDeviceRuntime[] = [];
  for (const entry of arrayField(dto.runtimes)) {
    runtimes.push(parseRemoteDeviceRuntime(entry as RemoteDeviceRuntimeDto, fallbackConnectorId));
  }
  return {
    connectorId: stringOrFallbackWhenBlank(dto.connectorId, fallbackConnectorId),
    runtimes: runtimes,
    serverTime: optionalString(dto.serverTime),
  };
}

// -------------------------------------------------------------- runtime types

/**
 * Addable-runtime descriptors — `GET /connectors/{id}/runtime-types`.
 *
 * Port of the `V2RuntimeType`/`V2RuntimeConfigDescriptor` half of
 * `Domain/Connector/V2RuntimeInventory.swift`.
 *
 * The Server publishes the same JSON schema three times: nested under
 * `configSchema` (newer Connectors) and at the top level as `schema` /
 * `uiSchema` / `defaults` (legacy, still always present on `RuntimeTypeView`).
 * iOS resolves `type.configSchema?.schema ?? type.schema`, and the parser below
 * folds both shapes into one field set so the sheet never has to know which one
 * the Server sent.
 */
export interface RemoteRuntimeConfigSchemaDto {
  revision?: number;
  schema?: Object;
  uiSchema?: Object;
  defaults?: Object;
  metadata?: Object;
}

export interface RemoteRuntimeTypeDto {
  connectorId?: string;
  runtimeType?: string;
  implementationType?: string;
  displayName?: string;
  description?: string;
  present?: boolean;
  available?: boolean;
  reason?: string;
  recommended?: boolean;
  recommendationRank?: number;
  configSchema?: RemoteRuntimeConfigSchemaDto;
  schema?: Object;
  uiSchema?: Object;
  defaults?: Object;
  instancePolicy?: string;
  maxInstances?: number;
}

export interface RemoteRuntimeType {
  connectorId: string;
  /** `runtimeType`; the id iOS's `V2RuntimeType.id` exposes. */
  id: string;
  runtimeType: string;
  displayName: string;
  description: string | null;
  present: boolean;
  available: boolean;
  reason: string | null;
  recommended: boolean;
  recommendationRank: number | null;
  schema: Object | null;
  uiSchema: Object | null;
  defaults: Object;
  instancePolicy: string;
  maxInstances: number | null;
}

export interface RemoteRuntimeTypeListDto {
  connectorId?: string;
  runtimeTypes?: RemoteRuntimeTypeDto[];
  serverTime?: string;
}

export interface RemoteRuntimeTypeList {
  connectorId: string;
  runtimeTypes: RemoteRuntimeType[];
  serverTime: string | null;
}

function parseRemoteRuntimeType(
  dto: RemoteRuntimeTypeDto,
  fallbackConnectorId: string,
): RemoteRuntimeType {
  const descriptor: RemoteRuntimeConfigSchemaDto | undefined =
    dto.configSchema === undefined || dto.configSchema === null ? undefined : dto.configSchema;
  const schema: Object | undefined = descriptor === undefined
    ? dto.schema
    : (descriptor.schema ?? dto.schema);
  const uiSchema: Object | undefined = descriptor === undefined
    ? dto.uiSchema
    : (descriptor.uiSchema ?? dto.uiSchema);
  const defaults: Object | undefined = descriptor === undefined
    ? dto.defaults
    : (descriptor.defaults ?? dto.defaults);
  return {
    connectorId: stringOrFallbackWhenBlank(dto.connectorId, fallbackConnectorId),
    id: stringOrFallbackWhenBlank(dto.runtimeType, ''),
    runtimeType: stringOrFallbackWhenBlank(dto.runtimeType, ''),
    displayName: stringOrFallbackWhenBlank(dto.displayName, ''),
    description: optionalString(dto.description),
    present: dto.present === true,
    available: dto.available === true,
    reason: optionalString(dto.reason),
    recommended: dto.recommended === true,
    recommendationRank: optionalNumber(dto.recommendationRank),
    schema: schema ?? null,
    uiSchema: uiSchema ?? null,
    defaults: defaults ?? EMPTY_OBJECT,
    instancePolicy: stringOrFallbackWhenBlank(dto.instancePolicy, 'single'),
    maxInstances: optionalNumber(dto.maxInstances),
  };
}

export function parseRemoteRuntimeTypeList(
  dto: RemoteRuntimeTypeListDto,
  fallbackConnectorId: string,
): RemoteRuntimeTypeList {
  const runtimeTypes: RemoteRuntimeType[] = [];
  for (const entry of arrayField(dto.runtimeTypes)) {
    runtimeTypes.push(parseRemoteRuntimeType(entry as RemoteRuntimeTypeDto, fallbackConnectorId));
  }
  return {
    connectorId: stringOrFallbackWhenBlank(dto.connectorId, fallbackConnectorId),
    runtimeTypes: runtimeTypes,
    serverTime: optionalString(dto.serverTime),
  };
}

/**
 * iOS's `V2RuntimeInventory.canAdd`.
 *
 * `instances` is the device's runtime inventory: a type may be added again when
 * either a cleared instance of it exists (the Server lets a de-configured
 * instance be configured again) or its instance count is still below the type's
 * own policy limit.
 */
export function runtimeTypeCanAdd(
  type: RemoteRuntimeType,
  instances: RemoteDeviceRuntime[],
): boolean {
  // No schema means the type cannot be configured, which is iOS's
  // `type.schema != nil || type.configSchema != nil` after the alias fold above.
  if (!type.present || type.schema === null) {
    return false;
  }
  let count: number = 0;
  let reconfigurable: boolean = false;
  for (const instance of instances) {
    if (instance.type !== type.runtimeType) {
      continue;
    }
    count += 1;
    if (!instance.configured) {
      reconfigurable = true;
    }
  }
  if (reconfigurable) {
    return true;
  }
  if (type.instancePolicy === 'single') {
    return count < 1;
  }
  if (type.instancePolicy !== 'multiple') {
    return false;
  }
  const maximum: number | null = type.maxInstances;
  return maximum === null || count < maximum;
}
