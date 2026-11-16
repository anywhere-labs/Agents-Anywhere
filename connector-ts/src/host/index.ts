// 宿主：单实例租约、本地控制接口、配置、日志与网络出口。

export {
  CONNECTOR_ALREADY_RUNNING,
  ConnectorAlreadyRunning,
  RuntimeLease,
  arbitrate,
  compareVersions,
  ownerAlive,
  type Arbitration,
  type ClaimResult,
  type HostKind,
  type LeaseIdentity,
  type OwnerView,
  type RuntimeLeaseOptions,
} from './lease.js'
export { agentsAnywhereHome, dataDir, ensurePrivateDir, legacyDataDir, runtimeRecordPath, systemHome } from './paths.js'
export { commandDigest, identityMatches, isV2ConnectorCommand, legacyIdentity, parseLstart, systemProbe, ticksToEpoch, type ProcessProbe } from './processes.js'
export { RuntimeRecordError, readRuntimeState, runtimeTransaction, type RuntimeOwnerRecord, type RuntimeState } from './runtime-record.js'
export { machineStateLockRecordPath, ownerAlive as lockOwnerAlive, withMachineStateLock, type MachineStateLockOptions, type MachineStateLockRecord } from './state-lock.js'
export { BRIDGE_PROTOCOL, DshBridgeListener, checkHello, type DshBridgeListenerOptions, type DshHello, type DshHostConnection, type RejectCode, type Rendezvous } from './dsh-socket.js'
export { LogStore, cleanRecord, type LogEntry, type LogPage, type LogPolicy, type LogRecord, type LogSource, type LogWrite } from './logs.js'
export { redact } from './redact.js'
export { ConfigError, ConfigFile, defaultConfigPath, defaultSettings, settingsFrom, type ConnectorSettings } from './config.js'
export {
  ConnectorBusy,
  ConnectorClosing,
  ConnectorController,
  isCredentialFailure,
  type ConnectorRuntime,
  type ConnectorState,
  type ConnectorStatus,
  type ControllerOptions,
  type HandoverPolicy,
  type HandoverRequester,
  type PairingStatus,
  type RuntimeFactory,
  type RuntimeHooks,
} from './controller.js'
export { CONNECTOR_ERROR, ControlEvents, controlService, handoverPath, handoverRequester, logsService, publishHandover, type ControlEvent, type HandoverRendezvous } from './control-service.js'
export { EventHub, type Sequenced } from './events.js'
export {
  CONTROL_SERVICE,
  DSH_BRIDGE_SERVICE,
  DSH_SYNC_SERVICE,
  LOGS_SERVICE,
  LocalHub,
  REGISTRY_SERVICE,
  ROLE_PERMISSIONS,
  apiKey,
  routerDirectory,
  sweepStaleSockets,
  writePrivateJson,
  type LocalDescriptor,
  type LocalEndpoint,
  type LocalHubOptions,
  type LocalRole,
} from './local-hub.js'
export { pollPairing, resolvePairServerUrl, startPairing, type FetchJson, type HttpFailure, type PairingStart } from './pairing.js'
