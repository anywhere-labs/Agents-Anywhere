// Codex 伴随层（04 §5.2）：自动跟随、deeplink 交接、退出 App、未加载线程的权限、Windows 写锁退路。

export { CodexAutoFollow, type AutoFollowOptions } from './auto-follow.js'
export { deeplinkSupported, openerCommand, systemUrlOpener, threadDeeplink, type UrlOpener } from './deeplink.js'
export {
  DESKTOP_PROCESS_MARKERS,
  descendants,
  desktopAppProcesses,
  parsePsListing,
  parseWindowsListing,
  quitSupported,
  systemProcessTable,
  systemSignaller,
  type ProcessInfo,
  type ProcessSignaller,
  type ProcessTable,
} from './desktop-app.js'
export { CodexRuntimeHandle, resolveCodexHome, type CodexCompanionOptions, type CodexOpenRoute, type HandoffResult } from './handle.js'
export {
  blockedOnlyByUnknownLock,
  CODEX_INSPECT,
  CODEX_IPC_SESSIONS,
  heldElsewhere,
  inspectThread,
  parseInspection,
  type CodexInspection,
  type CodexWriterLockObservation,
} from './inspect.js'
export { lockDirectory, WRITER_LOCK_DIRECTORY, type LockDirectory, type LockEntry } from './lock-directory.js'
export {
  CodexAppQuitter,
  describeQuitPlan,
  type QuitConsent,
  type QuitOutcome,
  type QuitPlan,
  type QuitPrepareResult,
  type QuitStatus,
} from './quit-app.js'
export {
  findRollout,
  nativePermissionSelection,
  permissionSelectionFromSettings,
  permissionSettings,
  rolloutPermissionSettings,
  threadCreatedAt,
  type PermissionSettings,
} from './rollout-settings.js'
