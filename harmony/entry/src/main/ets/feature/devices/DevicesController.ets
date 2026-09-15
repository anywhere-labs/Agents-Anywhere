import { DevicesApi, DeviceCredential } from '../../api/DevicesApi';
import {
  RemoteDeviceRuntime, RemoteDeviceRuntimeList, RemoteRuntimeTypeList,
} from '../../api/DevicesDtos';
import {
  RuntimeModelCatalog, RuntimePermissionCatalog,
} from '../../api/RuntimeCatalogDtos';
import { RemoteRuntimeCapabilitySet } from '../../api/RuntimeDtos';
import { AgentDevice } from '../../model/AgentSession';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { DeviceSetupCredential } from './DevicePairingFlow';

/**
 * Device workflows.
 *
 * Port of the list-side portion of `feature/devices/DevicesController.kt`.
 *
 * Only the runtime inventory is here for now: the devices page needs it for its
 * agent counts, while discovery, configuration and pairing arrive with the device
 * detail and setup screens.
 */
export class DevicesController {
  private readonly devicesApi: DevicesApi;
  private readonly sessionStore: AuthSessionStore;

  constructor(devicesApi: DevicesApi, sessionStore: AuthSessionStore) {
    this.devicesApi = devicesApi;
    this.sessionStore = sessionStore;
  }

  private serverUrl(): string {
    return this.sessionStore.readServerUrl();
  }

  private token(): string {
    return this.sessionStore.readAccessToken();
  }

  /** Creates a connector and returns the credential the CLI needs. */
  async createCredential(name: string): Promise<DeviceSetupCredential> {
    const credential: DeviceCredential = await this.devicesApi.create(
      this.serverUrl(), this.token(), name,
    );
    return {
      device: credential.device,
      serverUrl: this.serverUrl(),
      connectorToken: credential.connectorToken,
    };
  }

  /** Rotates a device's connector token, returning the replacement credential. */
  async revoke(deviceId: string): Promise<DeviceCredential> {
    return await this.devicesApi.revoke(this.serverUrl(), this.token(), deviceId);
  }

  /** Reads one device, which is how the wizard watches for it to come online. */
  async get(deviceId: string): Promise<AgentDevice> {
    return await this.devicesApi.get(this.serverUrl(), this.token(), deviceId);
  }

  /** Claims the pair code shown by the connector CLI. */
  async claimPairing(
    credential: DeviceSetupCredential,
    code: string,
    name: string,
  ): Promise<AgentDevice> {
    return await this.devicesApi.claimPairing(
      this.serverUrl(), this.token(), code, name, credential.device.id, credential.connectorToken,
    );
  }

  /** The device's runtime inventory; used for its online-agent count. */
  async listDeviceRuntimes(deviceId: string): Promise<RemoteDeviceRuntimeList> {
    return await this.devicesApi.listRuntimes(this.serverUrl(), this.token(), deviceId);
  }

  /** Starts or stops one runtime and returns the authoritative row. */
  async setRuntimeActive(
    deviceId: string,
    runtimeId: string,
    active: boolean,
  ): Promise<RemoteDeviceRuntime> {
    return await this.devicesApi.setRuntimeActive(
      this.serverUrl(), this.token(), deviceId, runtimeId, active,
    );
  }

  /** Deletes a runtime's saved configuration. */
  async deleteRuntimeConfig(deviceId: string, runtimeId: string): Promise<RemoteDeviceRuntime> {
    return await this.devicesApi.deleteRuntimeConfig(
      this.serverUrl(), this.token(), deviceId, runtimeId,
    );
  }

  /** The runtime types this device can still add. */
  async listRuntimeTypes(deviceId: string): Promise<RemoteRuntimeTypeList> {
    return await this.devicesApi.listRuntimeTypes(this.serverUrl(), this.token(), deviceId);
  }

  /** Re-runs discovery and returns the types it found. */
  async discoverRuntimeTypes(deviceId: string): Promise<RemoteRuntimeTypeList> {
    return await this.devicesApi.discoverRuntimeTypes(this.serverUrl(), this.token(), deviceId);
  }

  /** Adds a runtime instance and returns the Server's authoritative row. */
  async createRuntime(
    deviceId: string,
    runtimeType: string,
    name: string,
    config: Object,
    active: boolean,
  ): Promise<RemoteDeviceRuntime> {
    return await this.devicesApi.createRuntime(
      this.serverUrl(), this.token(), deviceId, runtimeType, name, config, active,
    );
  }

  /** Saves one runtime's configuration and returns the updated row. */
  async saveRuntimeConfig(
    deviceId: string,
    runtimeId: string,
    config: Object,
  ): Promise<RemoteDeviceRuntime> {
    return await this.devicesApi.putRuntimeConfig(
      this.serverUrl(), this.token(), deviceId, runtimeId, config,
    );
  }

  /**
   * A runtime's capability set.
   *
   * Android keeps these three loaders in `SessionsController` because the
   * new-session page is their only caller; they are device/runtime endpoints, so
   * this port files them with the other runtime calls. The behaviour — one
   * authenticated GET per call, errors propagated with the Server's message — is
   * unchanged.
   */
  async runtimeCapabilities(deviceId: string, runtimeId: string): Promise<RemoteRuntimeCapabilitySet> {
    return await this.devicesApi.getRuntimeCapabilities(
      this.serverUrl(), this.token(), deviceId, runtimeId,
    );
  }

  /** The runtime's model catalog. */
  async runtimeModelCatalog(deviceId: string, runtimeId: string): Promise<RuntimeModelCatalog> {
    return await this.devicesApi.getRuntimeModelCatalog(
      this.serverUrl(), this.token(), deviceId, runtimeId,
    );
  }

  /** The runtime's permission catalog. */
  async runtimePermissionCatalog(
    deviceId: string,
    runtimeId: string,
  ): Promise<RuntimePermissionCatalog> {
    return await this.devicesApi.getRuntimePermissionCatalog(
      this.serverUrl(), this.token(), deviceId, runtimeId,
    );
  }
}
