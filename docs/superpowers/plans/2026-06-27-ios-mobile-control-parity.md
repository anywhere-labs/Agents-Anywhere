# iOS Mobile Control Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the native iOS client up to the Android client's mobile-control feature level, starting with Session Detail bug fixes, then Devices/Connectors and Me/Settings.

**Architecture:** Keep the existing iOS SwiftUI app and visual language, but translate Android's completed `api / feature / model / ui` responsibilities into iOS-native domain API extensions, small stores/helpers, and focused SwiftUI views. Use Android for behavior and interaction reference, not for visual cloning.

**Tech Stack:** SwiftUI, async/await, URLSession, Keychain, PhotosUI, QuickLook, MarkdownUI, Xcode iOS project, FastAPI backend endpoints already present in this repository.

## Global Constraints

- Work only on the iOS client unless a backend contract mismatch is proven.
- Android is already complete and is reference-only.
- Preserve iOS-native controls and existing black/white visual language.
- Create and work on a standalone branch before implementation; do not merge into `main`.
- Do not commit, push, publish, or merge without explicit user approval.
- Do not use Computer Use unless explicitly authorized.
- Do not implement Terminal parity in this phase unless the user expands scope.
- High-risk file write/delete/rename operations from iOS file browsing are excluded from MVP.

---

## Source Requirements From User Images

- "来写 iOS"; Android has already been written.
- Backend APIs are confirmed ready.
- Fix bugs in the iOS Session Detail page.
- Improve connector/device and me/settings pages.
- Reference Android interaction and functionality, while keeping iOS native components.
- Build on the current iOS implementation.
- Work in a separate branch and do not merge first.
- If needed, run the Android app in Android Studio emulator or on a device to understand behavior.

## Current Baseline

- Repository: `/Users/apple/极光推送/Agents-Anywhere`
- Base commit: `ff0781e` (`Bump connector to 0.1.4`)
- Branch for this work: `ios/mobile-control-parity`
- iOS key file sizes:
  - `ios/Agents Anywhere/Agents Anywhere/Views/Dashboard/SessionDetailView.swift`: 3134 lines
  - `ios/Agents Anywhere/Agents Anywhere/Views/Dashboard/DashboardView.swift`: 1459 lines
  - `ios/Agents Anywhere/Agents Anywhere/API/APIClient.swift`: 479 lines
  - `ios/Agents Anywhere/Agents Anywhere/Models/APIModels.swift`: 512 lines

## Android Reference Map

- `android/app/src/main/java/com/agentsanywhere/app/api/SessionsApi.kt`
  - Session list/create/patch/bulk archive/state/events/message/attachments/takeover/approval/runtime settings.
- `android/app/src/main/java/com/agentsanywhere/app/api/DevicesApi.kt`
  - Device list/create/rename/delete/revoke/runtime scan/detach/device runtime settings.
- `android/app/src/main/java/com/agentsanywhere/app/api/FilesApi.kt`
  - Directory listing and text file reading.
- `android/app/src/main/java/com/agentsanywhere/app/feature/sessions/SessionsController.kt`
  - Session state derivation, pin/archive, create session, workspace directory selection.
- `android/app/src/main/java/com/agentsanywhere/app/feature/devices/DevicesController.kt`
  - Device setup, rename/delete, runtime scan/detach/settings.
- `android/app/src/main/java/com/agentsanywhere/app/feature/sessiondetail/SessionDetailController.kt`
  - Paginated state load, SSE reconnect loop, optimistic messages, takeover, runtime settings, approvals.
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/devices/DeviceDetailScreen.kt`
  - Device detail interactions, bulk archive, runtime actions, setup sheet.
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/profile/ProfileSettingsDrawer.kt`
  - Account, avatar, password, appearance, language, version, server, sign out.

## Target iOS File Structure

Keep changes incremental. Do not split everything in one commit-sized step.

- API domain extensions:
  - `ios/Agents Anywhere/Agents Anywhere/API/APIClient+Sessions.swift`
  - `ios/Agents Anywhere/Agents Anywhere/API/APIClient+Devices.swift`
  - `ios/Agents Anywhere/Agents Anywhere/API/APIClient+Files.swift`
  - `ios/Agents Anywhere/Agents Anywhere/API/APIClient+AuthAccount.swift`
- Session Detail:
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionDetailView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionTimelineView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionMessageViews.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionToolCards.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionApprovalViews.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionComposer.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/RuntimeSettingsSheet.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/SessionDetail/SessionAttachmentViews.swift`
- Devices:
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/DevicesView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/DeviceDetailView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/DeviceActionsSheet.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/DeviceSetupSheet.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/AddRuntimeSheet.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/DeviceRuntimeSettingsSheet.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Devices/DeviceConfirmDialog.swift`
- Settings:
  - `ios/Agents Anywhere/Agents Anywhere/Views/Settings/SettingsView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Settings/AccountSettingsView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Settings/AppearanceSettingsView.swift`
  - `ios/Agents Anywhere/Agents Anywhere/Views/Settings/PasswordChangeSheet.swift`
- Files:
  - `ios/Agents Anywhere/Agents Anywhere/Views/Files/RemoteTextPreviewView.swift`

## Task 0: Branch And Baseline

**Files:**
- Modify: none, unless Xcode project metadata must be normalized after adding files in later tasks.

- [ ] Confirm branch is `ios/mobile-control-parity`.
- [ ] Confirm working tree status before implementation.
- [ ] Inspect Xcode project schemes and deployment target.
- [ ] Run baseline build only after user authorization.
- [ ] Record baseline result in the handoff response.

## Task 1: API Domain Parity

**Files:**
- Modify: `ios/Agents Anywhere/Agents Anywhere/API/APIClient.swift`
- Modify/Create: domain API extension files listed above
- Modify: `ios/Agents Anywhere/Agents Anywhere/Models/APIModels.swift`

**Interfaces:**
- Produces session methods: `patchSession`, `bulkArchiveSessions`, `bulkMarkSessionsRead`, `syncSession`, `dashboardEventsURL`.
- Produces device methods: `createConnector`, `updateConnector`, `deleteConnector`, `revokeConnector`, `getConnectorPreferences`, `getConnectorRuntimeCapabilities`, `scanConnectorRuntime`, `deleteConnectorRuntime`, `getConnectorAgentSettings`, `patchConnectorAgentSettings`, `archiveAllConnectorSessions`.
- Produces file methods: `connectorFsReadText`, plus download transfer support if QuickLook needs binary files.
- Produces account methods: `updateAvatar`, `clearAvatar`, `changePassword`.

- [ ] Add request/response models matching backend and Android DTO coverage.
- [ ] Move or duplicate API surface into domain extensions while keeping request internals centralized.
- [ ] Keep JSON decoding tolerant of optional backend fields.
- [ ] Add merge/update helpers so changed sessions/connectors refresh one source of truth.
- [ ] Build.

## Task 2: Session Detail Bug Pass

**Files:**
- Modify/split: existing `SessionDetailView.swift`
- Create: Session Detail files listed in target structure

**Interfaces:**
- Consumes `APIClient+Sessions` methods.
- Produces reusable `SessionApprovalViews` for Approvals/Device surfaces.

- [ ] Mechanically split `SessionDetailView.swift` into focused views without changing behavior.
- [ ] Keep container state and async side effects out of child view bodies.
- [ ] Add SSE reconnect loop behavior based on Android `SessionDetailController.streamEvents`.
- [ ] Keep polling as fallback, not as permanent downgrade after one SSE failure.
- [ ] Add error-session send confirmation.
- [ ] Add Files picker attachment path in addition to Photos and Camera.
- [ ] Tighten read-only/takeover send flow to prevent accidental writes.
- [ ] Verify approval resolve, takeover, interrupt, send, attachment upload, runtime settings, and scroll-to-bottom behavior.

## Task 3: Devices / Connectors

**Files:**
- Create/modify Devices files listed in target structure.
- Modify current `DashboardView.swift` only as a temporary integration point, then reduce it.

**Interfaces:**
- Consumes `APIClient+Devices`, `APIClient+Sessions`, and file browsing helpers.
- Produces device detail state and actions.

- [ ] Replace current minimal Devices list with a navigable `DevicesView`.
- [ ] Add `DeviceDetailView` with agents/runtimes and sessions sections.
- [ ] Add active/archived/all session filter in device detail.
- [ ] Add device setup sheet showing connector command after create/revoke.
- [ ] Add rename/delete/revoke actions with confirmation.
- [ ] Add runtime scan/detach/settings sheet.
- [ ] Add selected/all archive/unarchive for device sessions.
- [ ] Verify state refresh after every mutation.

## Task 4: Me / Settings

**Files:**
- Replace/expand current `MeView` inside `DashboardView.swift`.
- Create Settings files listed in target structure.

**Interfaces:**
- Consumes `APIClient+AuthAccount`.
- Produces account settings, appearance settings, password change, sign out.

- [ ] Rename tab from `Me` to `Settings` if product copy allows.
- [ ] Show user id, role, avatar, server URL, version.
- [ ] Add avatar update and clear using `/auth/me/avatar`.
- [ ] Add change password using `/auth/change-password`.
- [ ] Add appearance setting: system/light/dark.
- [ ] Preserve sign-out behavior and ensure token/server state clears correctly.
- [ ] Keep language setting out of MVP unless user asks for localization parity.

## Task 5: Sessions Home And New Session Polish

**Files:**
- Modify/split `DashboardView.swift`.
- Reuse/extend `RemoteFileBrowserSheet.swift`.

**Interfaces:**
- Consumes sessions/devices/files APIs.

- [ ] Add search over title/workspace/runtime/device.
- [ ] Add active/archived filter with iOS-native segmented or menu UI.
- [ ] Add session row actions: rename, pin/unpin, archive/unarchive, mark read.
- [ ] Add new session flow: select device, runtime, workspace cwd, optional title.
- [ ] Use file browser to choose cwd.
- [ ] Keep tabs iOS-native; do not blindly copy Android Home tabs if it makes iOS navigation worse.

## Task 6: Workspace Files

**Files:**
- Modify: `RemoteFileBrowserSheet.swift`
- Create: `RemoteTextPreviewView.swift`

**Interfaces:**
- Consumes `connectorFsList` and `connectorFsReadText`.

- [ ] Support directory navigation for device and new session flows.
- [ ] Add text file preview with truncation/binary handling.
- [ ] Add copy/share for text content.
- [ ] Keep write/delete/rename out of MVP.

## Task 7: Verification

**Commands:**
- `git status --short --branch`
- XcodeBuildMCP scheme/defaults inspection.
- Xcode build after authorization.
- Optional local Docker stack smoke after authorization.

- [ ] Confirm project still builds.
- [ ] Confirm newly created Swift files are included in the Xcode project.
- [ ] Manual smoke: auth, sessions, session detail, approvals, devices, settings.
- [ ] Compare key Android flows where behavior is ambiguous.
- [ ] Report residual risk before asking for merge/commit/push.

## Stop Conditions

- Backend contract mismatch that cannot be resolved in iOS only.
- Need for credentials/login.
- Need to run Android Studio GUI, iOS Simulator UI, or Computer Use without explicit authorization.
- Any request to commit, push, publish, or merge.
- Discovery of a durable new problem that should be recorded in `~/.cunzhi-knowledge/problems.md`.
