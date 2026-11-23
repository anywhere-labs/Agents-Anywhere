// Agents Anywhere v3 Connector: public API for Desktop (Electron) embedding and programmatic use.
//
//   import { ConnectorHost } from "@anywhere-labs/aa-connector-v3";
//   const host = new ConnectorHost({ routers: [{ url: "ws://127.0.0.1:7600" }] });
//   await host.start();
//
// The CLI (`aa-connector`) is a thin layer over the same `ConnectorHost`.

// Host
export { CONNECTOR_VERSION, ConnectorHost, type ConnectorHostOptions, type ConnectorLogger, type RouterTarget } from "./host/connector-host.js";
export {
  LocalRouterHost,
  resolveLocalRouterBinary,
  type LocalRouterDescriptor,
  type LocalRouterHostOptions,
} from "./host/local-router.js";
export {
  backoffDelay,
  ControlHttpError,
  ControlPresenceClient,
  fetchDeviceRouterTokens,
  registerDeviceWithControlPlane,
  type ControlPresenceOptions,
  type DeviceRouterTokens,
  type FetchRouterTokensOptions,
  type PresenceReport,
  type PresenceSummary,
  type PushAck,
  type PushRequest,
  type RegisterDeviceOptions,
  type RegisteredDevice,
  type RouterTokenEntry,
} from "./host/control-client.js";

// RPC services
export { DeviceAdminService, TunnelStreamTracker, type DeviceAdminHooks, type TrackedStream } from "./rpc/device-admin-service.js";
export { DeviceService, rpcGuard, toRpcError, type DeviceServiceHost } from "./rpc/device-service.js";
export { SessionsService, type SessionsServiceDeps } from "./rpc/sessions-service.js";
export { terminalClientIdentity, TerminalsService, type TerminalClientIdentity, type TerminalsServiceDeps } from "./rpc/terminals-service.js";

// Runtime
export {
  AcpConnection,
  AcpRequestError,
  AcpRuntime,
  AcpRuntimeHost,
  defaultAcpPresets,
  turnReplyText,
  type AcpRuntimeHostOptions,
  type AcpRuntimeOptions,
  type AgentRuntime,
  type PreparedAgent,
  type PreparedInfo,
  type PushEvent,
  type StartedSession,
  type StartSessionInput,
  type TurnResult,
} from "./runtime/acp-host.js";
export * as deviceOps from "./runtime/device-ops.js";
export {
  atomicWriteFile,
  defaultDataDir,
  defaultSettings,
  StateStore,
  StateStoreError,
  STATE_FILES,
  type ConnectorSettings,
  type DeviceIdentity,
} from "./runtime/state-store.js";
export {
  loadNodePty,
  TerminalError,
  TerminalManager,
  type AttachOptions,
  type ClaimOptions,
  type CreateTerminalOptions,
  type PtyModule,
  type PtyProcess,
  type TerminalAttachment,
  type TerminalController,
  type TerminalEvent,
  type TerminalInfo,
  type TerminalManagerOptions,
  type TerminalMode,
} from "./runtime/terminal-manager.js";

// Core (portable)
export * from "./core/config.js";
export {
  DeviceGate,
  DEFAULT_PAIRING_TTL_MS,
  encodePairingUri,
  isPairingExpired,
  META_MCP_CLIENT,
  META_ON_BEHALF_OF,
  META_VIA,
  PAIRING_URI_PREFIX,
  PairingError,
  parsePairingUri,
  type DeviceGateOptions,
  type GateCallContext,
  type GateDecision,
  type GateDenyReason,
  type PairingHint,
  type PairingPayload,
} from "./core/gate.js";
export { SessionStore, SessionStoreError, type SessionStoreOptions } from "./core/session-store.js";
export * from "./core/timeline.js";
export { AcpTimelineProjector } from "./core/acp-protocol.js";
