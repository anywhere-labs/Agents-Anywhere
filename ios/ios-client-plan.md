# Agents Anywhere iOS Client Plan

## Goal

Build a native iOS client for Agents Anywhere focused on quick mobile control:
check agent state, approve blocked actions, continue errored sessions, send short
instructions, and manage connected devices.

The app should feel native on iOS 26 and later. The visual system is black and
white, with color reserved for semantic status only: online, pending approval,
error, destructive actions, and runtime badges when needed.

## Platform Direction

- SwiftUI first.
- Minimum target: iOS 26 if we decide to fully lean into the new system design.
  If we need wider device support later, keep the code modular enough to add
  availability fallbacks.
- Prefer system components that automatically adopt Liquid Glass:
  `NavigationStack`, `NavigationSplitView`, `TabView`, `List`, `Form`,
  `ToolbarItem`, `Sheet`, `Alert`, `confirmationDialog`, `Menu`, `Picker`,
  `Toggle`, `Button`, and `.searchable`.
- Avoid heavy custom panels and card stacks. Let content scroll under native
  bars and toolbars.
- Use custom Liquid Glass effects only for persistent high-value controls, such
  as the session composer bar or a floating approval action group.

## Product Scope

### MVP

1. Server connection and sign-in
   - Enter server URL.
   - Sign in with user ID and password.
   - Scan mobile sign-in QR generated from the web account modal.
   - Store token in Keychain.
   - Support sign out and server switching.

2. Sessions
   - List active sessions grouped by recency.
   - Search sessions by title, workspace, runtime, and device.
   - Filter by status: active, waiting for approval, error, archived.
   - Open session detail.
   - Mark sessions read when opened.

3. Session detail
   - Timeline reader for user, assistant, tool, and system/error items.
   - Composer for sending short instructions.
   - Takeover toggle.
   - Interrupt current run.
   - Resolve approvals.
   - Continue an errored session with a confirmation prompt.
   - Attachment send from Photos / Files can be phase 1.5 if the API is ready
     enough on mobile.

4. Devices
   - List connectors with online/offline state.
   - Show runtimes attached to each device.
   - Show workspaces and sessions under a device.
   - Add device flow that creates connector credentials and presents the command
     for running the connector on the target machine.
   - iOS does not run the connector itself in MVP.

5. Notifications
   - Local in-app approval center in MVP.
   - Push notifications for approvals and errors in the next phase, because it
     needs server-side push token registration.

6. Settings
   - Account and sign out.
   - Server URL.
   - Theme: system / light / dark, but visual language remains black and white.
   - Optional Face ID / device passcode gate before opening the app.

## Navigation

### iPhone

Use a bottom `TabView`:

- Sessions
- Devices
- Approvals
- Settings

The tab bar should stay minimal and monochrome. Status counts can appear as
badges, especially pending approvals and errors.

### iPad

Use `NavigationSplitView`:

- Sidebar: Sessions, Devices, Approvals, Settings.
- Content column: selected list.
- Detail column: selected session or device.

This should make iPad feel like a control console rather than a stretched phone
layout.

## Screens

### 1. Launch / Server Setup

Purpose: connect to a self-hosted Agents Anywhere server.

Layout:

- Large app mark and name.
- Server URL field.
- Continue button.
- Recent servers list if available.

Components:

- `NavigationStack`
- `Form`
- `TextField`
- `Button`
- `ProgressView`
- `Alert` for invalid URL or connection failure

Design:

- White or black background based on system appearance.
- No decorative gradients.
- Use system grouped form spacing.

### 2. Sign In

Purpose: authenticate quickly.

Layout:

- User ID field.
- Password field.
- Sign in button.
- Secondary action: Scan QR from web.

Components:

- `Form`
- `SecureField`
- `Button`
- Camera scanner view for QR login
- `Sheet` for scanner

Interactions:

- Successful login stores token in Keychain.
- Failed login shows inline form error.
- QR scan validates payload, calls mobile login API, then stores token.

### 3. First Device Onboarding

Purpose: match the web onboarding behavior.

Trigger:

- After login, if the server returns zero connectors and this device has not
  completed onboarding for this account/server.

Layout:

- Native confirmation sheet or alert:
  "You don't have a device yet. Add one?"
- Primary action: Add device.
- Secondary action: Not now.

Components:

- `confirmationDialog` or `.sheet` depending on final copy density.

Behavior:

- Store an onboarded flag locally per server + user.
- If connectors exist, mark onboarded immediately.
- Add device opens the Add Device flow.

### 4. Sessions List

Purpose: fast triage.

Layout:

- Search field in navigation/tool bar.
- Filter menu in toolbar.
- List rows with:
  - title
  - runtime
  - device
  - workspace
  - status badge
  - unread indicator
  - last activity

Components:

- `List`
- `.searchable`
- `Menu`
- `Picker`
- `ToolbarItem`
- `NavigationLink`
- Pull to refresh

Interactions:

- Swipe actions: pin, archive, mark read.
- Tap opens detail.
- Long press opens quick actions menu.

Design:

- Dense but readable list.
- Use SF Symbols for runtime/status where possible.
- Avoid large cards; session rows are list rows.

### 5. Session Detail

Purpose: inspect and control a running agent.

Layout:

- Top area: title, device, runtime, workspace, status.
- Scrollable timeline.
- Pending approval block appears above composer.
- Composer pinned to bottom.

Components:

- `ScrollView` / `List` depending on timeline performance.
- `ToolbarItem` for sync, takeover, more menu.
- `Menu` for runtime/session actions.
- `TextEditor` or multiline text field for composer.
- `PhotosPicker` / document picker for attachments later.
- `confirmationDialog` for error-session send.

Interactions:

- Send message.
- If status is `error`, confirm before sending.
- If status is `running`, show interrupt action.
- If status is `waiting_approval`, foreground approval controls.
- Takeover toggle controls whether composer is active.
- Pull to refresh and SSE/live update where available.

Design:

- Timeline content is the main surface.
- Composer can use a subtle native glass background on iOS 26.
- Toolbars should stay monochrome; use semantic color only for error and danger.

### 6. Approval Center

Purpose: handle blockers without hunting through sessions.

Layout:

- List pending approvals grouped by session/device.
- Each row shows command/tool summary, cwd/workspace, and risk text.
- Detail sheet shows full approval context.

Components:

- `List`
- `NavigationLink`
- `Sheet`
- `Button`
- `confirmationDialog` for deny / destructive choices

Interactions:

- Approve.
- Deny.
- Open related session.

Design:

- Pending approvals get the clearest visual priority.
- Approval and deny buttons should be grouped in a native toolbar/action area.

### 7. Devices List

Purpose: understand available machines.

Layout:

- Search.
- Device rows with online/offline, last seen, runtimes, workspace count.
- Add device button in toolbar.

Components:

- `List`
- `.searchable`
- `ToolbarItem`
- `NavigationLink`
- `Menu`

Interactions:

- Tap device opens detail.
- Swipe offline device: remove/revoke where allowed.
- Add device opens pairing flow.

### 8. Device Detail

Purpose: manage one connector.

Layout:

- Header: device name, status, connector ID.
- Runtime capability section.
- Workspaces section.
- Sessions section.
- Danger area for revoke/remove.

Components:

- `Form` or `List` with sections.
- `Button`
- `Menu`
- `confirmationDialog`

Interactions:

- Rename device.
- Refresh runtime scan.
- Open workspace sessions.
- Revoke connector.

### 9. Add Device

Purpose: create credentials and guide the user to run a connector elsewhere.

Layout:

- Device name field.
- Generated connector command.
- Copy button.
- Share button.
- Optional QR for command transfer.

Components:

- `Form`
- `TextField`
- `Button`
- `ShareLink`
- `Sheet`

Design:

- Command block should be readable in monospace.
- Keep the flow practical; the phone is controlling setup, not running the
  connector.

### 10. Settings

Purpose: app and account control.

Sections:

- Account.
- Server.
- Appearance.
- Security.
- Notifications.
- About.

Components:

- `Form`
- `Picker`
- `Toggle`
- `Button`

## Data And API Layer

Suggested modules:

- `APIClient`
  - wraps REST calls with `URLSession`.
  - async/await.
  - typed request and response models matching `web/src/lib/api.ts`.

- `AuthStore`
  - token storage in Keychain.
  - current server URL.
  - current user.

- `DashboardStore`
  - connector list.
  - session list.
  - dashboard event stream.

- `SessionStore`
  - session state.
  - timeline items.
  - approvals.
  - send / interrupt / takeover / approval actions.

- `OnboardingStore`
  - local onboarded flag by server + user.

Live updates:

- Prefer server-sent events if the current backend endpoints work cleanly with
  `URLSession.bytes`.
- Keep polling fallback for background/foreground transitions and flaky networks.

## Implementation Phases

### Phase 1: Native Read / Approve Client

- Project cleanup and app structure.
- Server URL + login + QR login.
- Keychain session persistence.
- Sessions tab.
- Session detail timeline.
- Approvals and approve/deny.
- Devices list.
- First-device onboarding prompt.

### Phase 2: Mobile Control

- Composer send.
- Takeover toggle.
- Interrupt.
- Continue errored session confirmation.
- Runtime settings needed for mobile send.
- Device detail and add device.

### Phase 3: Mobile Completeness

- Attachments from Photos / Files.
- File browser for workspaces.
- Terminal view for sessions that expose terminal capability.
- Push notifications for approvals/errors.
- Widgets / Live Activities if the product direction calls for ambient status.

## Open Questions

- Should the iOS app require iOS 26, or should it support iOS 18/19 with
  availability fallbacks?
- Should mobile allow creating brand-new sessions, or only operate on sessions
  already discovered from connectors?
- How much terminal/filesystem control should be exposed on a phone versus kept
  for iPad/web?
- Should push notifications be part of the first public iOS release?
- What is the expected App Store distribution path: TestFlight only first, or
  public App Store?

