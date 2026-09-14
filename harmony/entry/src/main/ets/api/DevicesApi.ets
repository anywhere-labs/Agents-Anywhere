import { HttpTransport } from './HttpTransport';
import { encodeUrlComponent } from './ApiUrls';
import {
  parseRemoteDeviceEnvelope, parseRemoteDeviceList, parseRemoteDeviceRuntime,
  parseRemoteDeviceRuntimeList, RemoteDeviceEnvelopeDto, RemoteDeviceListDto,
  RemoteDeviceRuntime, RemoteDeviceRuntimeDto, RemoteDeviceRuntimeEnvelopeDto,
  RemoteDeviceRuntimeList, RemoteDeviceRuntimeListDto,
} from './DevicesDtos';
import { AgentDevice } from '../model/AgentSession';
import {
  parseRuntimeModelCatalog, parseRuntimePermissionCatalog, RuntimeModelCatalog, RuntimeModelCatalogDto,
  RuntimePermissionCatalog, RuntimePermissionCatalogDto,
} from './RuntimeCatalogDtos';
import { parseRuntimeCapabilitySet, RemoteRuntimeCapabilitySet } from './RuntimeDtos';

/** `{ "active": bool }` body of the runtime activation endpoint. */
interface RuntimeActiveRequest {
  active: boolean;
}

/** `{ capabilitySet: … }` body of the runtime capabilities endpoint. */
interface RuntimeCapabilitiesEnvelopeDto {
  connectorId?: string;
  capabilitySet?: Object;
  serverTime?: string;
}

/** `{ catalog: … }` body of the model catalog endpoint. */
interface RuntimeModelCatalogEnvelopeDto {
  catalog?: RuntimeModelCatalogDto;
  serverTime?: string;
}

/** `{ catalog: … }` body of the permission catalog endpoint. */
interface RuntimePermissionCatalogEnvelopeDto {
  catalog?: RuntimePermissionCatalogDto;
  serverTime?: string;
}

/**
 * Reads the runtime an activation or deletion answered with.
 *
 * The Server wraps a single runtime either in `{ "runtime": … }` or directly, so
 * both shapes are accepted the way Android's `toRemoteDeviceRuntime` does.
 */
function parseRemoteDeviceRuntimeEnvelope(
  dto: Object,
  fallbackConnectorId: string,
): RemoteDeviceRuntime {
  const envelope: RemoteDeviceRuntimeEnvelopeDto = dto as RemoteDeviceRuntimeEnvelopeDto;
  const nested: RemoteDeviceRuntimeDto | undefined = envelope.runtime;
  const payload: RemoteDeviceRuntimeDto = nested === undefined
    ? dto as RemoteDeviceRuntimeDto
    : nested;
  return parseRemoteDeviceRuntime(payload, fallbackConnectorId);
}

/**
 * Connector (device) resource client.
 *
 * Port of the device portion of `api/DevicesApi.kt`.
 *
 * The runtime inventory is here because the devices list needs it for its agent
 * preview; discovery, configuration and catalogs arrive with the device detail
 * screen.
 */
export class DevicesApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /** `GET /connectors`. */
  async list(serverUrl: string, token: string): Promise<AgentDevice[]> {
    const body: Object = await this.transport.getJson(serverUrl, '/connectors', token);
    return parseRemoteDeviceList(body as RemoteDeviceListDto);
  }

  /** `GET /connectors/{id}/runtimes` — the device's runtime inventory. */
  async listRuntimes(
    serverUrl: string,
    token: string,
    deviceId: string,
  ): Promise<RemoteDeviceRuntimeList> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}/runtimes`, token,
    );
    return parseRemoteDeviceRuntimeList(body as RemoteDeviceRuntimeListDto, deviceId);
  }

  /** `POST /connectors/{id}/runtimes/discover` — re-runs runtime discovery. */
  async discoverRuntimes(
    serverUrl: string,
    token: string,
    deviceId: string,
  ): Promise<RemoteDeviceRuntimeList> {
    const body: Object = await this.transport.postEmpty(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}/runtimes/discover`, token,
    );
    return parseRemoteDeviceRuntimeList(body as RemoteDeviceRuntimeListDto, deviceId);
  }

  /** `POST /connectors/{id}/runtimes/{runtimeId}/active` — start or stop one. */
  async setRuntimeActive(
    serverUrl: string,
    token: string,
    deviceId: string,
    runtimeId: string,
    active: boolean,
  ): Promise<RemoteDeviceRuntime> {
    const request: RuntimeActiveRequest = { active: active };
    const body: Object = await this.transport.postJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/runtimes/${encodeUrlComponent(runtimeId)}/active`,
      token, request,
    );
    return parseRemoteDeviceRuntimeEnvelope(body as RemoteDeviceRuntimeEnvelopeDto, deviceId);
  }

  /** `DELETE /connectors/{id}/runtimes/{runtimeId}/config` — drops the config. */
  async deleteRuntimeConfig(
    serverUrl: string,
    token: string,
    deviceId: string,
    runtimeId: string,
  ): Promise<RemoteDeviceRuntime> {
    const body: Object = await this.transport.deleteJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/runtimes/${encodeUrlComponent(runtimeId)}/config`,
      token,
    );
    return parseRemoteDeviceRuntimeEnvelope(body as RemoteDeviceRuntimeEnvelopeDto, deviceId);
  }

  async get(serverUrl: string, token: string, deviceId: string): Promise<AgentDevice> {
    const body: Object = await this.transport.getJson(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}`, token,
    );
    return parseRemoteDeviceEnvelope(body as RemoteDeviceEnvelopeDto);
  }

  /**
   * `GET /connectors/{id}/runtimes/{runtimeId}/capabilities`.
   *
   * The set is nested under `capabilitySet`; a missing one reads as revision 0
   * with no capabilities, which is what Android's `optJSONObject` produces.
   */
  async getRuntimeCapabilities(
    serverUrl: string,
    token: string,
    deviceId: string,
    runtimeId: string,
  ): Promise<RemoteRuntimeCapabilitySet> {
    const body: Object = await this.transport.getJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/runtimes/${encodeUrlComponent(runtimeId)}/capabilities`,
      token,
    );
    const envelope: RuntimeCapabilitiesEnvelopeDto = body as RuntimeCapabilitiesEnvelopeDto;
    return parseRuntimeCapabilitySet(envelope.capabilitySet);
  }

  /** `GET /connectors/{id}/runtimes/{runtimeId}/catalogs/model`. */
  async getRuntimeModelCatalog(
    serverUrl: string,
    token: string,
    deviceId: string,
    runtimeId: string,
  ): Promise<RuntimeModelCatalog> {
    const body: Object = await this.transport.getJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/runtimes/${encodeUrlComponent(runtimeId)}/catalogs/model`,
      token,
    );
    const envelope: RuntimeModelCatalogEnvelopeDto = body as RuntimeModelCatalogEnvelopeDto;
    const dto: RuntimeModelCatalogDto = envelope.catalog === undefined
      ? {} as RuntimeModelCatalogDto : envelope.catalog;
    return parseRuntimeModelCatalog(dto, runtimeId);
  }

  /** `GET /connectors/{id}/runtimes/{runtimeId}/catalogs/permission`. */
  async getRuntimePermissionCatalog(
    serverUrl: string,
    token: string,
    deviceId: string,
    runtimeId: string,
  ): Promise<RuntimePermissionCatalog> {
    const body: Object = await this.transport.getJson(
      serverUrl,
      `/connectors/${encodeUrlComponent(deviceId)}/runtimes/${encodeUrlComponent(runtimeId)}/catalogs/permission`,
      token,
    );
    const envelope: RuntimePermissionCatalogEnvelopeDto = body as RuntimePermissionCatalogEnvelopeDto;
    const dto: RuntimePermissionCatalogDto = envelope.catalog === undefined
      ? {} as RuntimePermissionCatalogDto : envelope.catalog;
    return parseRuntimePermissionCatalog(dto, runtimeId);
  }

  /** `POST /connectors` — creates a connector and returns its one-time token. */
  async create(serverUrl: string, token: string, name: string): Promise<DeviceCredential> {
    const body: DeviceNameRequest = { name: name };
    const response: Object = await this.transport.postJson(serverUrl, '/connectors', token, body);
    const envelope: DeviceCredentialDto = response as DeviceCredentialDto;
    return {
      device: parseRemoteDeviceEnvelope(envelope),
      connectorToken: envelope.connectorToken ?? '',
      tokenPrefix: envelope.tokenPrefix ?? null,
    };
  }

  async rename(serverUrl: string, token: string, deviceId: string, name: string): Promise<AgentDevice> {
    const body: DeviceNameRequest = { name: name };
    const response: Object = await this.transport.patchJson(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}`, token, body,
    );
    return parseRemoteDeviceEnvelope(response as RemoteDeviceEnvelopeDto);
  }

  async delete(serverUrl: string, token: string, deviceId: string): Promise<void> {
    await this.transport.deleteJson(serverUrl, `/connectors/${encodeUrlComponent(deviceId)}`, token);
  }

  /** `POST /connectors/{id}/revoke` — rotates the connector token. */
  async revoke(serverUrl: string, token: string, deviceId: string): Promise<DeviceCredential> {
    const response: Object = await this.transport.postEmpty(
      serverUrl, `/connectors/${encodeUrlComponent(deviceId)}/revoke`, token,
    );
    const envelope: DeviceCredentialDto = response as DeviceCredentialDto;
    return {
      device: parseRemoteDeviceEnvelope(envelope),
      connectorToken: envelope.connectorToken ?? '',
      tokenPrefix: envelope.tokenPrefix ?? null,
    };
  }

  /**
   * `POST /pairing/claim` — swaps a connector's pair code for the pairing.
   *
   * The body carries the connector's own credentials because the Server matches
   * the code against the connector it was issued to; the bearer token alone is
   * not enough.
   */
  async claimPairing(
    serverUrl: string,
    token: string,
    code: string,
    name: string,
    deviceId: string,
    deviceToken: string,
  ): Promise<AgentDevice> {
    const body: PairingClaimRequest = {
      code: code,
      name: name,
      serverUrl: serverUrl,
      connectorId: deviceId,
      connectorToken: deviceToken,
    };
    const response: Object = await this.transport.postJson(
      serverUrl, '/pairing/claim', token, body,
    );
    return parseRemoteDeviceEnvelope(response as RemoteDeviceEnvelopeDto);
  }
}

/** `POST /pairing/claim` body. */
interface PairingClaimRequest {
  code: string;
  name: string;
  serverUrl: string;
  connectorId: string;
  connectorToken: string;
}

/** A device plus the one-time credential used to start its connector. */
export interface DeviceCredential {
  device: AgentDevice;
  connectorToken: string;
  tokenPrefix: string | null;
}

interface DeviceNameRequest {
  name: string;
}

interface DeviceCredentialDto extends RemoteDeviceEnvelopeDto {
  connectorToken?: string;
  tokenPrefix?: string;
}
