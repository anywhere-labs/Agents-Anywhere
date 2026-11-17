// Composition root: compose.ts wires the local store, use cases, device link and Runtimes; host-process.ts is the
// process skeleton shared by rpc, Desktop and the CLI. Only this layer puts the others together.

export { activeTurns, connectorRuntime, type ComposeOptions, type Log } from './compose.js'
export { builtinProviders, nativeSessionId, RuntimeRegistry, runtimeSpecFrom, type RuntimeInstanceSpec, type RuntimeRegistryOptions } from './runtimes.js'
export { CONNECTOR_VERSION, fetchJsonViaEgress, startHostProcess, type HostProcess, type HostProcessOptions } from './host-process.js'
export { READY_KIND, READY_VERSION, runRpc } from './rpc.js'
export { runDesktopHost, type DesktopHostMessage, type DesktopParentMessage, type ParentPort } from './desktop-host.js'
export { runCli, type CliConfirm, type CliIo, type CliOptions } from './cli.js'
