// Device MeshCall link: HTTPS hello/ready for the token and connection generation, aa.device.v1.* registered on the
// Router (targeted, instance_id = deviceId), automatic recovery after disconnects, revocation and Router restarts;
// traffic goes through RouterBridge for proxies and system certificates.

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
export { connectOrigin, requestBytes, requestJson, uploadStream, HttpError, type BytesRequest, type JsonRequest, type UploadRequest } from './http.js'
export { deviceAttachmentFetcher, deviceTransferUploader, type BlobTransfer, type TransferUpload, type UploadFile } from './device-files.js'
export { blobLookup, blobSlices, type BlobLookupDeps, type BlobSlice, type FindAttachment, type LocalBlob } from './blobs.js'
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
export { MAX_COMMAND_CATALOGS, SessionCommandCatalog, type SessionCommand } from './session-commands.js'
export {
  TERMINAL_OUTPUT_ITEM_BYTES,
  TERMINAL_POLL_MS,
  TerminalWatchers,
  uploadPreparedDownload,
  type TerminalEventSink,
  type TerminalOutputItem,
  type TerminalOutputRequest,
  type TerminalSource,
  type WorkspaceServiceDeps,
} from './workspace.js'
export { CLIENT_SERVICE, DEFAULT_CLIENT_LIMITS, clientCall, clientRoute, clientSubscribe, type ClientLimits } from './client-call.js'
