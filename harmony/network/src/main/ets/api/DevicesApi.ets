import { ApiClient } from './ApiClient';
import { objGetArray, objGetBool, objGetNumber, objGetOptString, objGetRecord, objGetString, recordsFromArray } from 'common';

export const MODEL_CATALOG_CAPABILITY: string = 'catalog.model';
export const PERMISSION_CATALOG_CAPABILITY: string = 'catalog.permission';

export interface RemoteDevice {
  id: string;
  name: string;
  deviceOs: string | null;
  status: string;
  lastSeenAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface RemoteDeviceCredential {
  device: RemoteDevice;
  deviceToken: string;
  tokenPrefix: string | null;
}

export interface RemoteDeviceRuntime {
  connectorId: string;
  runtimeId: string;
  runtimeType: string;
  displayName: string;
  present: boolean;
  configured: boolean;
  active: boolean;
  status: string;
  // Configuration schema shipped by the server (mirrors the wire "schema"
  // field, renamed to avoid shadowing generic names). Null when the server
  // did not include a schema for this runtime.
  schemaRecord: Record<string, Object> | null;
  uiSchemaRecord: Record<string, Object> | null;
  configRecord: Record<string, Object> | null;
  lastDiscoveredAt: string | null;
  updatedAt: string | null;
}

export interface RemoteDeviceRuntimeList {
  connectorId: string;
  runtimes: RemoteDeviceRuntime[];
  serverTime: string | null;
}

const RUNTIME_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RUNTIME_INSTANCE_PATTERN = /^rti_[A-Za-z0-9_-]{1,124}$/;

export function isValidRuntimeType(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && !value.startsWith('rti_') &&
    RUNTIME_TYPE_PATTERN.test(value);
}

export function isValidRuntimeInstanceId(value: string, runtimeType: string): boolean {
  return value === runtimeType || (value.length <= 128 && RUNTIME_INSTANCE_PATTERN.test(value));
}

export function parseRemoteDevice(value: Record<string, Object>): RemoteDevice {
  const name = objGetOptString(value, 'name');
  const device: RemoteDevice = {
    id: objGetString(value, 'id', ''),
    name: name === null ? 'Device' : name,
    deviceOs: objGetOptString(value, 'deviceOs'),
    status: objGetString(value, 'status', 'offline'),
    lastSeenAt: objGetOptString(value, 'lastSeenAt'),
    createdAt: objGetOptString(value, 'createdAt'),
    updatedAt: objGetOptString(value, 'updatedAt')
  };
  return device;
}

export function parseRemoteDeviceRuntime(value: Record<string, Object>, fallbackConnectorId: string): RemoteDeviceRuntime {
  const legacyRuntime = objGetOptString(value, 'runtime');
  const runtimeId = objGetOptString(value, 'runtimeId') ?? legacyRuntime ?? '';
  const reportedRuntimeType = objGetOptString(value, 'runtimeType');
  const runtimeType = legacyRuntime ?? (isValidRuntimeType(runtimeId) ? runtimeId : (reportedRuntimeType ?? ''));
  const connectorIdRaw = objGetString(value, 'connectorId', fallbackConnectorId);
  const runtime: RemoteDeviceRuntime = {
    connectorId: connectorIdRaw.length > 0 ? connectorIdRaw : fallbackConnectorId,
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    displayName: objGetOptString(value, 'displayName') ?? objGetOptString(value, 'name') ?? runtimeType,
    present: objGetBool(value, 'present', false),
    configured: objGetBool(value, 'configured', false),
    active: objGetBool(value, 'active', false),
    status: objGetString(value, 'status', 'unknown'),
    schemaRecord: objGetRecord(value, 'schema'),
    uiSchemaRecord: objGetRecord(value, 'uiSchema'),
    configRecord: objGetRecord(value, 'config'),
    lastDiscoveredAt: objGetOptString(value, 'lastDiscoveredAt'),
    updatedAt: objGetOptString(value, 'updatedAt')
  };
  return runtime;
}

export function parseRemoteDeviceRuntimeList(value: Record<string, Object>, deviceId: string): RemoteDeviceRuntimeList {
  const connectorIdRaw = objGetString(value, 'connectorId', deviceId);
  const connectorId = connectorIdRaw.length > 0 ? connectorIdRaw : deviceId;
  const runtimes: RemoteDeviceRuntime[] = [];
  for (const item of recordsFromArray(objGetArray(value, 'runtimes'))) {
    const runtime = parseRemoteDeviceRuntime(item, connectorId);
    if (isValidRuntimeType(runtime.runtimeType) &&
      isValidRuntimeInstanceId(runtime.runtimeId, runtime.runtimeType)) {
      runtimes.push(runtime);
    }
  }
  const list: RemoteDeviceRuntimeList = {
    connectorId: connectorId,
    runtimes: runtimes,
    serverTime: objGetOptString(value, 'serverTime')
  };
  return list;
}

export interface RemoteRuntimeCapabilityDetail {
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
  parameters: Record<string, Object>;
}

export interface RemoteRuntimeCapabilities {
  connectorId: string;
  revision: number;
  capabilities: RemoteRuntimeCapabilityDetail[];
  serverTime: string | null;
}

export interface RemoteReasoningItem {
  id: string;
  selectionId: string;
  fullModelId: string | null;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  metadata: Record<string, Object>;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RemoteModelItem {
  id: string;
  selectionId: string | null;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  reasoningItems: RemoteReasoningItem[];
  metadata: Record<string, Object>;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RemoteModelCatalog {
  runtime: string;
  runtimeId: string;
  runtimeType: string;
  revision: number;
  models: RemoteModelItem[];
  serverTime: string | null;
}

export interface RemotePermissionItem {
  id: string;
  selectionId: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  metadata: Record<string, Object>;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RemotePermissionCatalog {
  runtime: string;
  runtimeId: string;
  runtimeType: string;
  revision: number;
  permissions: RemotePermissionItem[];
  serverTime: string | null;
}

function metadataRecord(source: Record<string, Object>): Record<string, Object> {
  const record = objGetRecord(source, 'metadata');
  if (record === null) {
    const empty: Record<string, Object> = {};
    return empty;
  }
  return record;
}

function catalogItemEnabled(source: Record<string, Object>, metadata: Record<string, Object>): boolean {
  const value = source['enabled'];
  if (typeof value === 'boolean') {
    return value;
  }
  const metaValue = metadata['enabled'];
  if (typeof metaValue === 'boolean') {
    return metaValue;
  }
  return true;
}

function catalogItemDisabledReason(source: Record<string, Object>,
  metadata: Record<string, Object>): string | null {
  const reason = objGetOptString(source, 'disabledReason');
  if (reason !== null) {
    return reason;
  }
  return objGetOptString(metadata, 'disabledReason');
}

export function parseRemoteRuntimeCapabilityDetail(
  value: Record<string, Object>): RemoteRuntimeCapabilityDetail {
  const runtime = objGetOptString(value, 'runtime');
  const runtimeType = objGetOptString(value, 'runtimeType');
  const parameters = objGetRecord(value, 'parameters');
  const detail: RemoteRuntimeCapabilityDetail = {
    capabilityId: objGetString(value, 'capabilityId', ''),
    version: objGetString(value, 'version', '1'),
    scope: objGetString(value, 'scope', 'runtime'),
    runtime: runtime,
    runtimeId: objGetOptString(value, 'runtimeId'),
    runtimeType: runtimeType === null ? runtime : runtimeType,
    sessionId: objGetOptString(value, 'sessionId'),
    supported: objGetBool(value, 'supported', true),
    available: objGetBool(value, 'available', true),
    allowed: objGetBool(value, 'allowed', true),
    unavailableReason: objGetOptString(value, 'unavailableReason'),
    parameters: parameters === null ? metadataRecord(value) : parameters
  };
  return detail;
}

export function isRuntimeCapabilityUsable(capability: RemoteRuntimeCapabilityDetail | null): boolean {
  if (capability === null) {
    return false;
  }
  return capability.supported && capability.available && capability.allowed;
}

// Mirrors Android NewSessionRuntimeCapabilities.find: match by runtimeId,
// then legacy runtime field, then runtime type, then the generic entry.
export function findRuntimeCapability(capabilities: RemoteRuntimeCapabilityDetail[], capabilityId: string,
  runtimeId: string, runtimeType: string): RemoteRuntimeCapabilityDetail | null {
  const matches: RemoteRuntimeCapabilityDetail[] = [];
  for (const capability of capabilities) {
    if (capability.capabilityId === capabilityId) {
      matches.push(capability);
    }
  }
  for (const capability of matches) {
    if (capability.runtimeId === runtimeId) {
      return capability;
    }
  }
  for (const capability of matches) {
    if (capability.runtimeId === null && capability.runtime === runtimeId) {
      return capability;
    }
  }
  for (const capability of matches) {
    if (capability.runtimeId === null && capability.runtimeType === runtimeType) {
      return capability;
    }
  }
  for (const capability of matches) {
    if (capability.runtimeId === null && capability.runtimeType === null && capability.runtime === null) {
      return capability;
    }
  }
  return null;
}

export function parseRemoteReasoningItem(value: Record<string, Object>): RemoteReasoningItem {
  const metadata = metadataRecord(value);
  const item: RemoteReasoningItem = {
    id: objGetString(value, 'id', ''),
    selectionId: objGetString(value, 'selectionId', ''),
    fullModelId: objGetOptString(value, 'fullModelId'),
    displayName: objGetString(value, 'displayName', ''),
    description: objGetOptString(value, 'description'),
    isDefault: objGetBool(value, 'default', false),
    metadata: metadata,
    enabled: catalogItemEnabled(value, metadata),
    disabledReason: catalogItemDisabledReason(value, metadata)
  };
  return item;
}

export function parseRemoteModelItem(value: Record<string, Object>): RemoteModelItem {
  const metadata = metadataRecord(value);
  const reasoningItems: RemoteReasoningItem[] = [];
  for (const raw of recordsFromArray(objGetArray(value, 'reasoningItems'))) {
    reasoningItems.push(parseRemoteReasoningItem(raw));
  }
  const item: RemoteModelItem = {
    id: objGetString(value, 'id', ''),
    selectionId: objGetOptString(value, 'selectionId'),
    displayName: objGetString(value, 'displayName', ''),
    description: objGetOptString(value, 'description'),
    isDefault: objGetBool(value, 'default', false),
    reasoningItems: reasoningItems,
    metadata: metadata,
    enabled: catalogItemEnabled(value, metadata),
    disabledReason: catalogItemDisabledReason(value, metadata)
  };
  return item;
}

export function parseRemotePermissionItem(value: Record<string, Object>): RemotePermissionItem {
  const metadata = metadataRecord(value);
  const item: RemotePermissionItem = {
    id: objGetString(value, 'id', ''),
    selectionId: objGetString(value, 'selectionId', ''),
    displayName: objGetString(value, 'displayName', ''),
    description: objGetOptString(value, 'description'),
    isDefault: objGetBool(value, 'default', false),
    metadata: metadata,
    enabled: catalogItemEnabled(value, metadata),
    disabledReason: catalogItemDisabledReason(value, metadata)
  };
  return item;
}

function parseRemoteModelCatalog(response: Record<string, Object>,
  fallbackRuntimeId: string): RemoteModelCatalog {
  const catalog = objGetRecord(response, 'catalog');
  const catalogRecord: Record<string, Object> = catalog === null ? metadataRecord(response) : catalog;
  const runtime = objGetOptString(catalogRecord, 'runtime');
  const runtimeTypeRaw = objGetOptString(catalogRecord, 'runtimeType');
  const runtimeType = runtimeTypeRaw === null ? (runtime === null ? '' : runtime) : runtimeTypeRaw;
  const runtimeIdRaw = objGetOptString(catalogRecord, 'runtimeId');
  const runtimeId = runtimeIdRaw !== null ? runtimeIdRaw :
    (fallbackRuntimeId.length > 0 ? fallbackRuntimeId : runtimeType);
  const models: RemoteModelItem[] = [];
  for (const raw of recordsFromArray(objGetArray(catalogRecord, 'models'))) {
    models.push(parseRemoteModelItem(raw));
  }
  const result: RemoteModelCatalog = {
    runtime: runtime === null ? runtimeType : runtime,
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    revision: objGetNumber(catalogRecord, 'revision', 0),
    models: models,
    serverTime: objGetOptString(response, 'serverTime')
  };
  return result;
}

function parseRemotePermissionCatalog(response: Record<string, Object>,
  fallbackRuntimeId: string): RemotePermissionCatalog {
  const catalog = objGetRecord(response, 'catalog');
  const catalogRecord: Record<string, Object> = catalog === null ? metadataRecord(response) : catalog;
  const runtime = objGetOptString(catalogRecord, 'runtime');
  const runtimeTypeRaw = objGetOptString(catalogRecord, 'runtimeType');
  const runtimeType = runtimeTypeRaw === null ? (runtime === null ? '' : runtime) : runtimeTypeRaw;
  const runtimeIdRaw = objGetOptString(catalogRecord, 'runtimeId');
  const runtimeId = runtimeIdRaw !== null ? runtimeIdRaw :
    (fallbackRuntimeId.length > 0 ? fallbackRuntimeId : runtimeType);
  const permissions: RemotePermissionItem[] = [];
  for (const raw of recordsFromArray(objGetArray(catalogRecord, 'permissions'))) {
    permissions.push(parseRemotePermissionItem(raw));
  }
  const result: RemotePermissionCatalog = {
    runtime: runtime === null ? runtimeType : runtime,
    runtimeId: runtimeId,
    runtimeType: runtimeType,
    revision: objGetNumber(catalogRecord, 'revision', 0),
    permissions: permissions,
    serverTime: objGetOptString(response, 'serverTime')
  };
  return result;
}

export class DevicesApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async listDevices(serverUrl: string, authorizationToken: string): Promise<RemoteDevice[]> {
    const response = await this.client.getJson(serverUrl, '/connectors', authorizationToken);
    const devices: RemoteDevice[] = [];
    for (const item of recordsFromArray(objGetArray(response, 'connectors'))) {
      devices.push(parseRemoteDevice(item));
    }
    return devices;
  }

  async getDevice(serverUrl: string, authorizationToken: string, deviceId: string): Promise<RemoteDevice> {
    const response = await this.client.getJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}`, authorizationToken);
    return parseRemoteDevice(requireConnector(response));
  }

  async createDevice(serverUrl: string, authorizationToken: string,
    name: string): Promise<RemoteDeviceCredential> {
    const body: Record<string, Object> = { 'name': name };
    const response = await this.client.postJson(serverUrl, '/connectors', body, authorizationToken);
    return parseRemoteDeviceCredential(response);
  }

  async updateDevice(serverUrl: string, authorizationToken: string, deviceId: string,
    name: string): Promise<RemoteDevice> {
    const body: Record<string, Object> = { 'name': name };
    const response = await this.client.patchJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}`, body, authorizationToken);
    return parseRemoteDevice(requireConnector(response));
  }

  async deleteDevice(serverUrl: string, authorizationToken: string, deviceId: string): Promise<void> {
    await this.client.deleteJson(serverUrl, `/connectors/${encodeURIComponent(deviceId)}`,
      authorizationToken);
  }

  async revokeDevice(serverUrl: string, authorizationToken: string,
    deviceId: string): Promise<RemoteDeviceCredential> {
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/revoke`, null, authorizationToken);
    return parseRemoteDeviceCredential(response);
  }

  async listDeviceRuntimes(serverUrl: string, authorizationToken: string,
    deviceId: string): Promise<RemoteDeviceRuntimeList> {
    const response = await this.client.getJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes`, authorizationToken);
    return parseRemoteDeviceRuntimeList(response, deviceId);
  }

  // POST /connectors/{id}/runtimes/discover — asks the connector to rescan and
  // returns the full runtime list including newly found (unconfigured) ones.
  async discoverDeviceRuntimes(serverUrl: string, authorizationToken: string,
    deviceId: string): Promise<RemoteDeviceRuntimeList> {
    const response = await this.client.postJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/discover`, null, authorizationToken);
    return parseRemoteDeviceRuntimeList(response, deviceId);
  }

  // PUT /connectors/{id}/runtimes/{runtimeId}/config — saves the runtime
  // configuration. Mirrors android DevicesApi.putDeviceRuntimeConfig.
  async putDeviceRuntimeConfig(serverUrl: string, authorizationToken: string, deviceId: string,
    runtimeId: string, config: Record<string, Object>): Promise<RemoteDeviceRuntime> {
    const body: Record<string, Object> = { 'config': config };
    const response = await this.client.putJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(runtimeId)}/config`,
      body, authorizationToken);
    return parseRemoteDeviceRuntime(response, deviceId);
  }

  // PUT /connectors/{id}/runtimes/{runtimeId}/active — activates (or
  // deactivates) a configured runtime. Mirrors android setDeviceRuntimeActive.
  async setDeviceRuntimeActive(serverUrl: string, authorizationToken: string, deviceId: string,
    runtimeId: string, active: boolean): Promise<RemoteDeviceRuntime> {
    const body: Record<string, Object> = { 'active': active };
    const response = await this.client.putJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(runtimeId)}/active`,
      body, authorizationToken);
    return parseRemoteDeviceRuntime(response, deviceId);
  }

  // DELETE /connectors/{id}/runtimes/{runtimeId}/config — deletes the saved
  // runtime configuration and returns the runtime's final state.
  async deleteDeviceRuntimeConfig(serverUrl: string, authorizationToken: string,
    deviceId: string, runtimeId: string): Promise<RemoteDeviceRuntime> {
    const response = await this.client.deleteJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(runtimeId)}/config`,
      authorizationToken);
    return parseRemoteDeviceRuntime(response, deviceId);
  }

  // GET /connectors/{id}/runtimes/{runtimeId}/capabilities — live runtime
  // capability set. Mirrors android DevicesApi.getDeviceRuntimeCapabilities.
  async getDeviceRuntimeCapabilities(serverUrl: string, authorizationToken: string,
    deviceId: string, runtimeId: string): Promise<RemoteRuntimeCapabilities> {
    const response = await this.client.getJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(runtimeId)}/capabilities`,
      authorizationToken);
    const capabilitySet = objGetRecord(response, 'capabilitySet');
    const setRecord: Record<string, Object> = capabilitySet === null ? metadataRecord(response) : capabilitySet;
    const capabilities: RemoteRuntimeCapabilityDetail[] = [];
    for (const raw of recordsFromArray(objGetArray(setRecord, 'capabilities'))) {
      capabilities.push(parseRemoteRuntimeCapabilityDetail(raw));
    }
    const connectorIdRaw = objGetString(response, 'connectorId', deviceId);
    const result: RemoteRuntimeCapabilities = {
      connectorId: connectorIdRaw.length > 0 ? connectorIdRaw : deviceId,
      revision: objGetNumber(setRecord, 'revision', 0),
      capabilities: capabilities,
      serverTime: objGetOptString(response, 'serverTime')
    };
    return result;
  }

  // GET /connectors/{id}/runtimes/{runtimeId}/catalogs/model — live model
  // catalog. Mirrors android DevicesApi.getDeviceRuntimeModelCatalog.
  async getDeviceRuntimeModelCatalog(serverUrl: string, authorizationToken: string,
    deviceId: string, runtimeId: string): Promise<RemoteModelCatalog> {
    const response = await this.client.getJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(runtimeId)}/catalogs/model`,
      authorizationToken);
    return parseRemoteModelCatalog(response, runtimeId);
  }

  // GET /connectors/{id}/runtimes/{runtimeId}/catalogs/permission — live
  // permission catalog. Mirrors android DevicesApi.getDeviceRuntimePermissionCatalog.
  async getDeviceRuntimePermissionCatalog(serverUrl: string, authorizationToken: string,
    deviceId: string, runtimeId: string): Promise<RemotePermissionCatalog> {
    const response = await this.client.getJson(serverUrl,
      `/connectors/${encodeURIComponent(deviceId)}/runtimes/${encodeURIComponent(runtimeId)}/catalogs/permission`,
      authorizationToken);
    return parseRemotePermissionCatalog(response, runtimeId);
  }

  // /pairing/claim — mirrors android/feature/devices/DevicesController.claimDevicePairCode.
  async claimPairing(serverUrl: string, authorizationToken: string, code: string,
    name: string, deviceId: string, deviceToken: string): Promise<RemoteDevice> {
    const body: Record<string, Object> = {
      'code': code,
      'name': name,
      'serverUrl': serverUrl,
      'connectorId': deviceId,
      'connectorToken': deviceToken
    };
    const response = await this.client.postJson(serverUrl, '/pairing/claim', body, authorizationToken);
    return parseRemoteDevice(requireConnector(response));
  }
}

function requireConnector(response: Record<string, Object>): Record<string, Object> {
  const connector = response['connector'];
  if (typeof connector === 'object' && connector !== null && !Array.isArray(connector)) {
    return connector as Record<string, Object>;
  }
  throw new Error('The server returned an invalid response.');
}

function parseRemoteDeviceCredential(response: Record<string, Object>): RemoteDeviceCredential {
  const credential: RemoteDeviceCredential = {
    device: parseRemoteDevice(requireConnector(response)),
    deviceToken: objGetString(response, 'connectorToken', ''),
    tokenPrefix: objGetOptString(response, 'tokenPrefix')
  };
  return credential;
}
