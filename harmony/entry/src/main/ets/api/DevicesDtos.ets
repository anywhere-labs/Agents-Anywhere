import { AgentDevice } from '../model/AgentSession';
import { arrayField, optionalString, requireString, stringOrFallbackWhenBlank } from './ApiJson';

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
  displayName?: string;
  present?: boolean;
  configured?: boolean;
  active?: boolean;
  status?: string;
  discovery?: Object;
  metadata?: Object;
  schema?: Object;
  uiSchema?: Object;
  config?: Object;
  error?: Object;
  lastDiscoveredAt?: string;
  updatedAt?: string;
}

export interface RemoteDeviceRuntime {
  connectorId: string;
  id: string;
  type: string;
  displayName: string;
  present: boolean;
  configured: boolean;
  active: boolean;
  status: string;
  discovery: Object;
  metadata: Object;
  schema: Object | null;
  uiSchema: Object;
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
    displayName: stringOrFallbackWhenBlank(dto.displayName, ''),
    present: dto.present === true,
    configured: dto.configured === true,
    active: dto.active === true,
    status: parseDeviceRuntimeStatus(dto.status),
    discovery: dto.discovery ?? EMPTY_OBJECT,
    metadata: dto.metadata ?? EMPTY_OBJECT,
    schema: dto.schema ?? null,
    uiSchema: dto.uiSchema ?? EMPTY_OBJECT,
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
