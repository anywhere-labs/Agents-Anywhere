// 设备 MeshCall 连接：HTTPS hello/ready 取 token 与连接代次，在 Router 上注册 aa.device.v1.*（targeted，instance_id = deviceId），断线、吊销、Router 重启后自动恢复；经 RouterBridge 走代理与系统证书。连接循环移植自 effi-crew agentd mesh.ts（D10）。

export {
  NO_SYSTEM_PROXY,
  PROXY_ENV,
  isLoopbackUrl,
  localProxyAlive,
  noProxyMatches,
  normalizeProxyUrl,
  parseNoProxyEntry,
  parseScutilProxy,
  parseWindowsInternetSettings,
  readSystemProxySettings,
  redactProxy,
  resolveEgress,
  sanitizeNoProxy,
  systemBypass,
  type Egress,
  type ResolveOptions,
  type SystemProxySettings,
} from './egress.js'
export { ProxyError, egressAgent, openTunnel, trustedCAs } from './tunnel.js'
export { connectOrigin, requestJson, HttpError, type JsonRequest } from './http.js'
export { ControlPlane, CredentialRejected, MESH_MAX_FRAME_BYTES, meshGrant, type ControlPlaneOptions, type DeviceCredential, type MeshGrant } from './control-plane.js'
export { RouterBridge, rewriteUpgradeHead } from './bridge.js'
export { ATTACH_EVENTS, ATTACH_STALL_MS, AttachHub, HEARTBEAT_MS, MAX_PENDING_EVENTS, type AttachEnd, type AttachHubOptions } from './attach.js'
export {
  CONNECTION_METADATA,
  DEFAULT_LIMITS,
  DEFAULT_REGISTRATION,
  DeviceServices,
  callClass,
  connectionReplaced,
  type CallClass,
  type DeviceServicesDeps,
  type E2eeMode,
  type Registration,
  type SecureChannelHandler,
} from './services.js'
export {
  Backoff,
  DeviceLink,
  isAuthFailure,
  isDuplicateInstance,
  sleep,
  type DeviceLinkOptions,
  type DeviceLinkTiming,
  type Handshake,
  type LinkLogger,
  type LinkState,
} from './device-link.js'
export { secureChannelVia, type SecureChannelHubLike, type SecureChannelLike, type SecureChannelWire } from './secure.js'
