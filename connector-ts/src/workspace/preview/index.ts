// Port preview, device side (PV-2 in 09-port-preview.md): PortShare rules, port-to-session association and the frpc
// data plane behind `PreviewTransport`.
export { previewCommands, type PreviewCommandDeps, type PreviewOpenResult } from './commands.js'
export { parseFrpsAddr, renderFrpcConfig, type FrpcConfig, type FrpsEndpoint, type PreviewProxy } from './frpc-config.js'
export { FrpcManager, freeLoopbackPort, type ChildLike, type FrpcManagerOptions, type PreviewSpec, type PreviewTransport } from './frpc-manager.js'
export { MAX_OPEN_PREVIEWS, decidePortShare, loopbackTarget, type PortShareDecision } from './port-share.js'
export {
  annotatePorts,
  localUrlsIn,
  parsePs,
  processParents,
  sessionOfProcess,
  type AnnotatedPort,
  type ProcessParents,
  type SessionHints,
} from './session-ports.js'
export { PORT_REFRESH_MS, previewHost, type AttachTarget, type PreviewHost, type PreviewHostOptions } from './host-wiring.js'
