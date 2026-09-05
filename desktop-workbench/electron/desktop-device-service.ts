import type { DesktopBindingStore } from "./desktop-binding";
import type { ConnectorSupervisor } from "./connector-supervisor";
import { systemDeviceName } from "./system-device-name";
import type {
  DesktopDeviceAuthInput,
  DesktopDeviceProvisionInput,
  DesktopDeviceReconnectInput,
  PublicLocalDesktopBinding,
} from "./connector-types";

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

type DesktopDeviceServiceOptions = {
  binding: DesktopBindingStore;
  connector: ConnectorSupervisor;
  fetcher: Fetcher;
  defaultServerUrl: () => string;
  apiNamespace: () => string;
};

type ConnectorCredentialResponse = {
  connector: {
    id: string;
    name?: string;
  };
  connectorToken: string;
};

export class DesktopDeviceService {
  constructor(private readonly options: DesktopDeviceServiceOptions) {}

  getLocalBinding(): PublicLocalDesktopBinding | null {
    return this.options.binding.getPublic(this.options.connector.hasCredential());
  }

  updateLocalBindingName(name: string): PublicLocalDesktopBinding {
    this.options.binding.updateName(name);
    this.options.connector.bindingChanged();
    return this.requirePublicBinding();
  }

  async createAndConnect(
    input: DesktopDeviceProvisionInput,
  ): Promise<PublicLocalDesktopBinding> {
    const userId = requireUserId(input?.userId);
    const serverUrl = this.resolveServerUrl(input?.serverUrl);
    const existing = this.options.binding.get();
    if (existing && existing.ownerUserId === userId && existing.serverUrl === serverUrl) {
      const state = this.options.connector.publicState();
      if (!this.options.connector.hasCredential() && !existing.manualDisconnected) {
        // Make an interrupted/migrated local binding explicitly recoverable via
        // the reconnect UI instead of silently returning a non-working device.
        this.options.binding.save({ ...existing, manualDisconnected: true });
        this.options.connector.bindingChanged();
      }
      if (
        this.options.connector.hasCredential() &&
        !existing.manualDisconnected &&
        !state.authFailed &&
        !state.running
      ) {
        await this.options.connector.start();
      }
      return this.requirePublicBinding();
    }

    const previousBinding = existing;
    const previousConfig = this.options.connector.loadPrivateConfig();
    const replacingLocalConnector = Boolean(previousBinding || previousConfig);
    const previousState = this.options.connector.publicState();
    const resumePrevious = Boolean(previousConfig && previousState.running && !previousState.authFailed);
    if (replacingLocalConnector) {
      // Stop the old runtime without deleting its credential. Provisioning the
      // new account/Server is transactional: a failed POST can resume the old
      // local Connector instead of stranding its binding without a token.
      await this.options.connector.stop();
    }

    try {
      await this.options.connector.preflightProvisioning();
    } catch (error) {
      await this.resumePreviousConnector(resumePrevious);
      throw error;
    }

    const name = input?.name?.trim() || await systemDeviceName();
    let credential: ConnectorCredentialResponse;
    try {
      credential = await this.requestCredential(
        serverUrl,
        "/connectors",
        input?.userToken,
        { name, connectorKind: "desktop" },
      );
    } catch (error) {
      await this.resumePreviousConnector(resumePrevious);
      throw error;
    }
    const nextBinding = {
      connectorId: credential.connector.id,
      serverUrl,
      name: credential.connector.name?.trim() || name,
      ownerUserId: userId,
      manualDisconnected: false,
    };
    try {
      this.options.binding.save(nextBinding);
    } catch (error) {
      const rollbackError = await this.tryRollbackCreatedConnector(
        serverUrl,
        credential.connector.id,
        input?.userToken,
      );
      await this.resumePreviousConnector(resumePrevious);
      throw combinedProvisioningError(error, rollbackError);
    }
    try {
      await this.options.connector.saveCredentials({
        serverUrl,
        connectorId: credential.connector.id,
        connectorToken: credential.connectorToken,
      });
    } catch (error) {
      // saveCredentials persists the config before asking the RPC process to
      // acknowledge it. Only roll back when even that recovery copy is absent.
      const persisted = this.options.connector.loadPrivateConfig();
      const recoveredNewCredential = Boolean(
        persisted?.connectorId === credential.connector.id && persisted.serverUrl === serverUrl,
      );
      if (recoveredNewCredential) {
        this.options.connector.bindingChanged();
        throw error;
      }
      if (previousBinding) this.options.binding.save(previousBinding);
      else this.options.binding.clear();
      this.options.connector.bindingChanged();
      const rollbackError = await this.tryRollbackCreatedConnector(
        serverUrl,
        credential.connector.id,
        input?.userToken,
      );
      await this.resumePreviousConnector(resumePrevious);
      throw combinedProvisioningError(error, rollbackError);
    }
    this.options.connector.bindingChanged();
    await this.options.connector.start();
    return this.requirePublicBinding();
  }

  async reconnectAndConnect(
    input: DesktopDeviceReconnectInput,
  ): Promise<PublicLocalDesktopBinding> {
    const binding = this.requireBinding();
    this.assertOwner(input, binding.ownerUserId);
    if (input.connectorId && input.connectorId !== binding.connectorId) {
      throw new Error("A different Desktop can only be reconnected on that Desktop.");
    }
    const serverUrl = this.resolveServerUrl(input.serverUrl || binding.serverUrl);
    const credential = await this.requestCredential(
      serverUrl,
      `/connectors/${encodeURIComponent(binding.connectorId)}/revoke`,
      input.userToken,
    );
    if (credential.connector.id !== binding.connectorId) {
      throw new Error("The server returned credentials for a different Connector.");
    }
    await this.options.connector.saveCredentials({
      serverUrl,
      connectorId: binding.connectorId,
      connectorToken: credential.connectorToken,
    });
    this.options.binding.save({
      ...binding,
      serverUrl,
      name: credential.connector.name?.trim() || binding.name,
      manualDisconnected: false,
    });
    this.options.connector.bindingChanged();
    await this.options.connector.restart();
    return this.requirePublicBinding();
  }

  async disconnectLocal(
    input: DesktopDeviceAuthInput,
  ): Promise<PublicLocalDesktopBinding> {
    const binding = this.requireBinding();
    this.assertOwner(input, binding.ownerUserId);
    const serverUrl = this.resolveServerUrl(input.serverUrl || binding.serverUrl);

    // The existing revoke endpoint rotates the server-side credential. The new
    // token is deliberately discarded so this Desktop remains disconnected.
    await this.requestCredential(
      serverUrl,
      `/connectors/${encodeURIComponent(binding.connectorId)}/revoke`,
      input.userToken,
    );
    await this.options.connector.clearCredentials();
    this.options.binding.save({
      ...binding,
      serverUrl,
      manualDisconnected: true,
    });
    this.options.connector.bindingChanged();
    return this.requirePublicBinding();
  }

  private async requestCredential(
    serverUrl: string,
    path: string,
    userToken: unknown,
    body?: Record<string, unknown>,
  ): Promise<ConnectorCredentialResponse> {
    const token = typeof userToken === "string" ? userToken.trim() : "";
    if (!token) throw new Error("A signed-in user session is required.");
    const response = await this.options.fetcher(this.apiUrl(serverUrl, path), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Keep authentication credentials and arbitrary response bodies out of logs.
    }
    if (!response.ok) {
      throw new Error(userFacingApiError(response.status, payload));
    }
    return parseCredentialResponse(payload);
  }

  private async rollbackCreatedConnector(
    serverUrl: string,
    connectorId: string,
    userToken: unknown,
  ): Promise<void> {
    const token = typeof userToken === "string" ? userToken.trim() : "";
    if (!token) throw new Error("Could not roll back the newly created Connector without a user session.");
    const response = await this.options.fetcher(
      this.apiUrl(serverUrl, `/connectors/${encodeURIComponent(connectorId)}`),
      {
        method: "DELETE",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`Could not roll back the newly created Connector (HTTP ${response.status}).`);
    }
  }

  private async tryRollbackCreatedConnector(
    serverUrl: string,
    connectorId: string,
    userToken: unknown,
  ): Promise<unknown | null> {
    try {
      await this.rollbackCreatedConnector(serverUrl, connectorId, userToken);
      return null;
    } catch (error) {
      return error;
    }
  }

  private async resumePreviousConnector(shouldResume: boolean): Promise<void> {
    if (!shouldResume) return;
    try {
      await this.options.connector.start();
    } catch {
      // Preserve the original provisioning error. The old credential and
      // binding remain intact and can still be started explicitly later.
    }
  }

  private resolveServerUrl(input: string | undefined): string {
    const raw = input?.trim() || this.options.defaultServerUrl().trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("The Agents Anywhere server URL is invalid.");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("The Agents Anywhere server URL must be an http(s) origin.");
    }
    const namespace = normalizeNamespace(this.options.apiNamespace());
    if (namespace && url.pathname.replace(/\/+$/, "") === namespace) url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  }

  private apiUrl(serverUrl: string, requestPath: string): string {
    const url = new URL(serverUrl);
    const namespace = normalizeNamespace(this.options.apiNamespace());
    url.pathname = `${namespace}/${requestPath.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
    return url.toString();
  }

  private assertOwner(input: DesktopDeviceAuthInput, ownerUserId: string): void {
    const userId = requireUserId(input?.userId);
    if (!ownerUserId || ownerUserId !== userId) {
      throw new Error("This local Desktop Connector belongs to a different signed-in account.");
    }
  }

  private requireBinding() {
    const binding = this.options.binding.get();
    if (!binding) throw new Error("This Desktop has not created its local Connector yet.");
    return binding;
  }

  private requirePublicBinding(): PublicLocalDesktopBinding {
    const binding = this.getLocalBinding();
    if (!binding) throw new Error("This Desktop has not created its local Connector yet.");
    return binding;
  }
}

function parseCredentialResponse(value: unknown): ConnectorCredentialResponse {
  if (!value || typeof value !== "object") throw new Error("The server returned an invalid Connector response.");
  const candidate = value as {
    connector?: { id?: unknown; name?: unknown };
    connectorToken?: unknown;
  };
  if (
    !candidate.connector ||
    typeof candidate.connector.id !== "string" ||
    !candidate.connector.id.trim() ||
    typeof candidate.connectorToken !== "string" ||
    !candidate.connectorToken.trim()
  ) {
    throw new Error("The server did not return complete Connector credentials.");
  }
  return {
    connector: {
      id: candidate.connector.id.trim(),
      name: typeof candidate.connector.name === "string" ? candidate.connector.name : undefined,
    },
    connectorToken: candidate.connectorToken.trim(),
  };
}

function requireUserId(value: unknown): string {
  const userId = typeof value === "string" ? value.trim() : "";
  if (!userId) throw new Error("A signed-in user ID is required.");
  return userId;
}

function normalizeNamespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function userFacingApiError(status: number, payload: unknown): string {
  if (status === 401) return "Your login session has expired. Please sign in again.";
  if (status === 403) return "This account cannot manage the selected Connector.";
  if (status === 404) return "The selected Connector no longer exists.";
  if (status === 409) return "The Connector changed on another client. Refresh and try again.";
  if (payload && typeof payload === "object") {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length <= 300) return detail;
  }
  return `The Connector request failed (HTTP ${status}).`;
}

function combinedProvisioningError(primary: unknown, rollback: unknown | null): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  if (!rollback) return primaryError;
  const rollbackError = rollback instanceof Error ? rollback : new Error(String(rollback));
  return new AggregateError(
    [primaryError, rollbackError],
    `${primaryError.message} The new Connector could not be rolled back automatically; remove it from the device list if it appears there.`,
  );
}
