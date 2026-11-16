// 设备 MeshCall 连接：经 HTTP hello/ready 取 token，在 Router 上注册 aa.device.v1.* 服务，退避重连；实现 DeviceMesh 端口。移植自 effi-crew agentd mesh.ts（D10）。

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
