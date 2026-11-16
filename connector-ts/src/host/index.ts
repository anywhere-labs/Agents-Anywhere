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
export { agentsAnywhereHome, dataDir, ensurePrivateDir, runtimeRecordPath, systemHome } from './paths.js'
export { commandDigest, identityMatches, isV2ConnectorCommand, legacyIdentity, parseLstart, systemProbe, ticksToEpoch, type ProcessProbe } from './processes.js'
export { RuntimeRecordError, readRuntimeState, runtimeTransaction, type RuntimeOwnerRecord, type RuntimeState } from './runtime-record.js'
export { machineStateLockRecordPath, ownerAlive as lockOwnerAlive, withMachineStateLock, type MachineStateLockOptions, type MachineStateLockRecord } from './state-lock.js'
export { LogStore, cleanRecord, type LogEntry, type LogPage, type LogPolicy, type LogRecord, type LogSource, type LogWrite } from './logs.js'
export { redact } from './redact.js'
