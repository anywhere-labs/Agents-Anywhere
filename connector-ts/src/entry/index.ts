// 组合根：compose.ts 装配本地库、用例、设备连接与 Runtime；host-process.ts 是 rpc、Desktop 与 CLI 共用的进程骨架；
// 只有这里把各层装配在一起。

export { activeTurns, connectorRuntime, type ComposeOptions, type Log } from './compose.js'
export { builtinProviders, nativeSessionId, RuntimeRegistry, runtimeSpecFrom, type RuntimeInstanceSpec, type RuntimeRegistryOptions } from './runtimes.js'
export { CONNECTOR_VERSION, fetchJsonViaEgress, startHostProcess, type HostProcess, type HostProcessOptions } from './host-process.js'
export { READY_KIND, READY_VERSION, runRpc } from './rpc.js'
export { runDesktopHost, type DesktopHostMessage, type DesktopParentMessage, type ParentPort } from './desktop-host.js'
export { runCli, type ClientPairing, type CliIo, type CliOptions } from './cli.js'
