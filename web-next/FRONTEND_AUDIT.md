# web-next Frontend Audit and Migration Plan

This document is the working specification for rebuilding the current `web/`
frontend in `web-next/`.

The goal is not a redesign. The first accepted version of `web-next` must look
and behave the same as the current Vite/React app while replacing one-off page
implementations with shared, typed, accessible components.

## Hard Requirement: Visual Parity

The refactor must preserve the existing UI exactly unless a later product task
explicitly approves a visual change.

- Keep the current dark and light themes.
- Keep the current type scale, density, border radii, shadows, scrollbars,
  hover states, focus states, loading states, and animation timing.
- Keep current page layouts and information hierarchy before improving code.
- Do not introduce a generic SaaS design system look.
- Do not use new decorative gradients, oversized cards, new brand surfaces, or
  marketing-style sections.
- A page is not considered migrated until screenshots match the old `web/`
  implementation at desktop and mobile widths.

The existing source of visual truth is:

- `web/src/styles/tokens.css`
- `web/src/pages/auth/auth.css`
- `web/src/pages/dashboard/dashboard.css`
- `web/src/pages/dashboard/session_detail.css`
- `web/src/pages/dashboard/session-detail/runtime/runtime.css`
- `web/src/pages/dashboard/RuntimeSettingsForm.css`
- `web/src/pages/dashboard/RunModeGuide.css`

`web-next/src/app/globals.css` already starts by porting the token layer. All
future styling should either use those tokens directly or expose component
variants that compile to the same visual output.

## Current Frontend Shape

The old frontend is a single Vite/React app with these major surfaces:

| Surface | Current files | Responsibility | Migration risk |
| --- | --- | --- | --- |
| App/auth gate | `web/src/App.tsx` | stored token restore, auth state, theme, demo runtime entry | medium |
| Auth | `pages/auth/*` | login, register, bootstrap, OAuth finalize, password verifier | medium |
| Dashboard shell | `SessionsPage.tsx`, `Sidebar.tsx`, `dashboard.css` | routing, sidebar, SSE dashboard refresh, modals, top-level page selection | high |
| Session list | `Sidebar.tsx`, `SessionRowMenu.tsx`, `FilterMenu.tsx`, `NoSessionsEmpty.tsx` | devices, pinned sessions, recents, filters, row actions | high |
| New session | `NewSessionPage.tsx`, `NewSessionModal.tsx` | composer, device/runtime picker, workspace picker, files, runtime settings | high |
| Session detail | `SessionDetailView.tsx`, `session_detail.css` | timeline, SSE, optimistic sends, approvals, composer, runtime panel | very high |
| Runtime panels | `session-detail/runtime/*` | files, file preview, terminal, popout windows, resizable layout | high |
| Device | `DevicePage.tsx`, `AddAgentModal.tsx`, `PairDeviceModal.tsx`, `RuntimeSettingsForm.tsx`, `RunModeGuide.tsx` | device status, agents, workspaces, sessions, pair/rotate/delete flows | high |
| Workspace | `WorkspacePage.tsx` | workspace grouping by device and activity | medium |
| Account/settings | `AccountModal.tsx`, `SettingsPage.tsx`, `AgentDefaultsPanel.tsx` | profile, password reset, mobile sign-in QR, theme/account settings, agent defaults | high |
| Team | `TeamPage.tsx` | user table, role/status filters, user CRUD | medium |
| Service | `ServicePage.tsx` | server health and OAuth provider configuration | medium |
| Shared display | `MessageAttachments.tsx`, `SessionMessageMarkdown.tsx`, `AnsiText.tsx`, `Identicon.tsx`, `Icons.tsx` | markdown, code panels, attachment previews, ANSI rendering, icons | medium |

The largest files by line count are also the places where component extraction
matters most:

- `dashboard.css`: about 5010 lines
- `SessionDetailView.tsx`: about 3382 lines
- `session_detail.css`: about 1956 lines
- `NewSessionPage.tsx`: about 1364 lines
- `DevicePage.tsx`: about 1225 lines
- `TeamPage.tsx`: about 923 lines
- `SessionsPage.tsx`: about 788 lines
- `AccountModal.tsx`: about 620 lines

## Main Problems to Fix

### Repeated Modal Implementations

Current examples:

- `ConfirmModal.tsx`
- `RenameSessionModal.tsx`
- `AccountModal.tsx` nested password reset modal
- `AccountModal.tsx` mobile sign-in modal
- `PairDeviceModal.tsx`
- `AddAgentModal.tsx`
- `DevicePage.tsx` runtime config modal
- `SessionDetailView.tsx` takeover confirmation modal
- `SessionDetailView.tsx` run-mode preview modal
- `RuntimeWindow.tsx` popup-blocked modal
- `UnsavedChangesDialog.tsx`

Target abstraction:

- `components/common/AppDialog`
- `components/common/ConfirmDialog`
- `components/common/WizardDialog`
- `components/common/DialogActions`

Implementation rule:

- Use Radix Dialog for focus trap, Escape behavior, aria wiring, and portal.
- Preserve old CSS dimensions, backdrop color, radius, shadow, and button
  density.
- Dialog content may have domain-specific children, but the shell, close
  button, actions, destructive button styling, and loading/disabled states must
  be shared.

### Repeated Menus and Popovers

Current examples:

- `FilterMenu.tsx`
- `SessionRowMenu.tsx`
- `UserMenu.tsx`
- `TeamPage.tsx` row menu
- `NewSessionPage.tsx` permission menu
- `NewSessionPage.tsx` device/runtime menu
- `NewSessionPage.tsx` model/effort menu
- `SessionDetailView.tsx` composer menus
- workspace picker and file browser popovers in `NewSessionPage.tsx`

Target abstraction:

- `components/common/ActionMenu`
- `components/common/PopoverPanel`
- `components/common/PopoverSelect`
- `components/common/NestedPopoverMenu`
- `components/common/WorkspacePicker`
- `components/common/FileBrowserPopover`

Implementation rule:

- Use Radix Dropdown Menu / Popover where possible.
- Do not duplicate outside-click, hover-delay, Escape, and viewport collision
  logic in each page.
- Preserve the compact `kl-*` menu look: small text, tight rows, `bg-panel`,
  `border-md`, `shadow-pop`, 6-8px radius, and 0.12s hover transitions.

### Repeated Forms

Current examples:

- auth login/register/bootstrap forms
- OAuth finalize card
- account password reset form
- team create/edit user form
- service OAuth provider form
- runtime settings form
- agent defaults editor
- workspace/manual path inputs

Target abstraction:

- `components/common/FormField`
- `components/common/TextInput`
- `components/common/PasswordField`
- `components/common/PasswordStrength`
- `components/common/FormError`
- `components/common/InlineAlert`
- `components/common/SegmentedControl`
- `components/common/SettingRow`
- `components/common/SettingsSection`

Implementation rule:

- Preserve the existing `aa-input`, `aa-field`, `aa-submit`, `aa-error`,
  segmented-control, and compact settings styles.
- Use React Hook Form only if it removes real duplication; do not add a form
  framework before the migrated pages need it.
- All labels, placeholders, button text, validation text, empty states, and
  status strings must move into `next-intl` messages.

### Repeated Status and Metadata Display

Current examples:

- device online/offline/active status
- session waiting/unread/archived state
- runtime badges for Codex/Claude/openCode/Cursor
- team active/disabled/admin/member badges
- service health and OAuth provider states
- approval status buttons
- QR login state labels

Target abstraction:

- `components/common/StatusBadge`
- `components/common/RuntimeBadge`
- `components/common/DeviceStatus`
- `components/common/RoleBadge`
- `components/common/ActivityTime`
- `components/common/KeyValueList`

Implementation rule:

- Runtime colors must come from the existing runtime tokens:
  `--agent-claude`, `--agent-codex`, `--agent-opencode`, `--agent-cursor`.
- Badge height, radius, dot size, mono font usage, and background/border
  treatment must match the old UI.

### Page Files Are Too Broad

The old pages often combine data synchronization, mutations, layout, styling
decisions, and leaf UI in the same file.

Target split:

- `src/app/[locale]/...`: route entry only.
- `src/features/*/api.ts`: domain API calls and DTO helpers.
- `src/features/*/hooks.ts`: stateful flows, SSE, optimistic updates.
- `src/features/*/components/*`: domain components.
- `src/components/common/*`: cross-domain composed components.
- `src/components/ui/*`: shadcn/Radix primitive wrappers.

Do not over-split tiny components. Split where it removes duplicated behavior or
isolates high-risk state transitions.

## Style System

### Token Contract

These token groups are stable and should not be renamed without a dedicated
visual migration:

- Surface: `--bg`, `--bg-panel`, `--bg-elev`, `--bg-hover`, `--bg-active`,
  `--bg-input`
- Borders: `--border`, `--border-md`, `--border-lg`
- Text: `--text`, `--text-mid`, `--text-mut`, `--text-faint`
- Accent: `--accent`, `--accent-soft`, `--accent-ink`
- Runtime colors: `--agent-claude`, `--agent-codex`, `--agent-opencode`,
  `--agent-cursor`
- Radius: `--r-sm`, `--r`, `--r-md`, `--r-lg`
- Fonts: `--sans`, `--mono`, `--serif`
- Font sizes: `--fs-micro`, `--fs-2xs`, `--fs-xs`, `--fs-sm`, `--fs-ui`,
  `--fs-base`, `--fs-md`, `--fs-lg`, `--fs-xl`, `--fs-2xl`, `--fs-3xl`
- Shadow: `--shadow-pop`

All shadcn component variants must map back to these tokens rather than
introducing a second visual language.

### Current Naming Families

The current CSS has two major naming families:

- `aa-*`: auth, account, team, service, brand-adjacent surfaces.
- `kl-*`: dashboard shell, sidebar, session list, session detail, composer,
  runtime surfaces.

During migration, component names should be semantic, but the generated classes
or Tailwind utilities must preserve these visual families:

- Auth should keep the centered, narrow `aa-card` feel.
- Dashboard should keep the `kl-app` density and floating-sidebar layout.
- Session detail should keep the `kl-main-detail` chat/runtime split.
- Runtime panels should keep the terminal/file-tool density and dark surfaces.

### Buttons

Required shared button variants:

- `primary`: current accent-filled call to action.
- `default`: elevated neutral action.
- `ghost`: transparent icon/text action.
- `danger`: destructive action.
- `icon`: fixed square icon button.
- `rowAction`: compact list/table menu trigger.

Rules:

- Icon buttons must have stable square dimensions.
- Do not use text-only rounded pills when a common icon action exists.
- Use lucide icons where possible, mapped to the existing icon choices.
- Disabled states must keep the current muted text and no-hover behavior.

### Layout Surfaces

Required shared surfaces:

- `AppShell`
- `SidebarShell`
- `MainPanel`
- `PageHeader`
- `Toolbar`
- `SurfaceCard`
- `TableSurface`
- `SettingsShell`
- `DetailHeader`

Rules:

- Do not nest cards inside cards.
- Dashboard sections should use full-width panels or unframed layouts unless
  the old UI already used a card.
- Stable dimensions are required for rows, icon buttons, table columns, chips,
  and fixed-format controls.

## Page-by-Page Migration Notes

### App Gate and Routing

Current:

- `App.tsx` restores stored sessions, validates `/auth/me`, owns theme, and
  switches between auth and dashboard.
- Routing is currently hash-based inside the dashboard.

Target:

- Use Next App Router with locale prefix.
- Keep auth token storage behavior compatible with the old frontend until the
  backend contract changes.
- Put auth/session bootstrap in `features/auth/useAuthSession`.
- Keep page files thin and redirect/render based on auth state.

Routes to create:

- `/[locale]/login`
- `/[locale]/register` only if registration remains a separate URL
- `/[locale]/sessions`
- `/[locale]/sessions/[sessionId]`
- `/[locale]/devices/[deviceId]`
- `/[locale]/devices/[deviceId]/workspaces`
- `/[locale]/team`
- `/[locale]/service`
- `/[locale]/settings`

### Auth

Current components:

- `AuthChrome`
- `LoginForm`
- `RegisterForm`
- `BootstrapForm`
- `OAuthFinalizeCard`
- `AAWord`

Target components:

- `AuthShell`
- `AuthCard`
- `LoginForm`
- `RegisterForm`
- `BootstrapForm`
- `OAuthFinalizeForm`
- `PasswordField`
- `PasswordStrength`
- `ThemeSegment`

Style requirements:

- Preserve full-screen `aa-auth`, top bar, centered 400px card, 40px inputs,
  compact labels, and existing password-strength bars.
- Preserve the loading boot state with spinner and short text.
- Preserve OAuth secondary button treatment.

i18n namespaces:

- `auth.login.*`
- `auth.register.*`
- `auth.bootstrap.*`
- `auth.oauth.*`
- `auth.errors.*`

### Dashboard Shell and Sidebar

Current components:

- `SessionsPage`
- `Sidebar`
- `SessionRowMenu`
- `FilterMenu`
- `UserMenu`
- `NoSessionsEmpty`

Target components:

- `DashboardShell`
- `DashboardSidebar`
- `SidebarSection`
- `SessionNavRow`
- `DeviceNavRow`
- `SidebarEmpty`
- `SessionFilterMenu`
- `SessionRowActionMenu`
- `UserActionMenu`

Behavior to preserve:

- floating sidebar card width and collapse/flyout behavior
- devices/pinned/recents sections
- unread/waiting attention dot behavior
- row action menu
- dashboard SSE refresh and retry behavior
- onboarding prompt when there are no connectors

State split:

- `useDashboardData`: connectors, sessions, SSE dashboard events, retry sync.
- `useDashboardNavigation`: active route, selected device/session/workspace.
- `useSessionFilters`: status/device/agent/workspace filters.
- `useDashboardModals`: pair, rename, confirm, onboard prompt.

### New Session

Current file:

- `NewSessionPage.tsx`

Target components:

- `NewSessionView`
- `SessionComposer`
- `ComposerTextarea`
- `AttachmentPicker`
- `AttachmentChip`
- `PermissionModeMenu`
- `DeviceRuntimeMenu`
- `ModelEffortMenu`
- `WorkspacePicker`
- `RemoteFileBrowser`
- `CreateSessionProgress`

Behavior to preserve:

- rotating prompt title
- last selected device/runtime persistence
- attachment drag/drop and paste handling
- image preview object URL handling
- max file count and max bytes validation
- manual workspace mode
- remote filesystem browser
- slow-create hint after delay
- runtime settings payload mapping

Shared logic to extract:

- attachment normalization from pasted images
- data-transfer file detection
- workspace label/key helpers
- composer popover positioning or Radix equivalent
- runtime field option labels and effective values

### Session Detail

Current file:

- `SessionDetailView.tsx`

Target modules:

- `features/session-detail/useSessionTimeline`
- `features/session-detail/useSessionComposer`
- `features/session-detail/useApprovals`
- `features/session-detail/useRuntimeSettings`
- `components/session-detail/SessionHeader`
- `components/session-detail/Timeline`
- `components/session-detail/TimelineEntry`
- `components/session-detail/ToolCard`
- `components/session-detail/ApprovalRequest`
- `components/session-detail/SessionComposer`
- `components/session-detail/SessionRuntimeBadge`

Behavior to preserve:

- initial state fetch and paged timeline cursor
- SSE delta application without full refetch per event
- fallback polling only when SSE is not open
- optimistic outgoing user messages
- interrupt optimistic state
- approval resolution states and exit animation
- streaming markdown reveal cadence
- composer attachments, paste, drag/drop
- permission/model/effort menus
- takeover confirmation
- Claude run-mode prompt flow

This page should migrate late. It is the highest-risk page and depends on many
shared components from earlier phases.

### Runtime Panels

Current files:

- `RuntimePanel.tsx`
- `FilesPanel.tsx`
- `FilePreviewPanel.tsx`
- `TerminalPanel.tsx`
- `RuntimeWindow.tsx`
- `runtimeApi.ts`
- `useRuntimeLayout.ts`
- `useResizeGrip.ts`
- `useTerminalSocket.ts`

Target components:

- `RuntimePanelShell`
- `RuntimeTab`
- `RuntimeToolbar`
- `FilesPanel`
- `FilePreviewPanel`
- `TerminalPanel`
- `RuntimePopoutWindow`
- `ResizableSplit`

Behavior to preserve:

- files/terminal/preview layout
- popout window style copying
- popup-blocked fallback modal
- terminal websocket lifecycle
- file read/write and unsaved changes dialog
- stored runtime panel width/ratio

### Device and Workspace

Current files:

- `DevicePage.tsx`
- `WorkspacePage.tsx`
- `AddAgentModal.tsx`
- `PairDeviceModal.tsx`
- `RuntimeSettingsForm.tsx`
- `RunModeGuide.tsx`

Target components:

- `DeviceOverview`
- `DeviceHeader`
- `AgentList`
- `AgentRow`
- `AgentSettingsDialog`
- `AddAgentDialog`
- `PairDeviceWizard`
- `PairCommandBlock`
- `WorkspaceList`
- `DeviceSessionList`
- `BulkSessionActions`
- `RuntimeSettingsForm`
- `RunModeGuide`

Behavior to preserve:

- inline device rename
- delete/rotate credential confirmations
- add/remove runtime agents
- runtime health/reason display
- Claude default run-mode prompt
- session filter tabs
- bulk archive/unarchive selection mode
- workspace grouping and latest-activity sorting
- pair command generation and copy affordances

### Account and Settings

Current files:

- `AccountModal.tsx`
- `SettingsPage.tsx`
- `AgentDefaultsPanel.tsx`

Target components:

- `SettingsShell`
- `AccountPanel`
- `AvatarPicker`
- `PasswordResetDialog`
- `MobileSignInPanel`
- `MobileSignInDialog`
- `AgentDefaultsPanel`
- `AgentCatalogEditor`

Behavior to preserve:

- avatar upload/resize to data URL
- account modal shell
- two-step password reset confirmation
- QR mobile sign-in risk confirmation and polling
- theme switch behavior
- agent default/catalog editing

### Team

Current file:

- `TeamPage.tsx`

Target components:

- `TeamPage`
- `TeamToolbar`
- `UserTable`
- `UserRow`
- `UserActionMenu`
- `UserEditorDialog`
- `CreateUserDialog`
- `DeleteUserDialog`

Behavior to preserve:

- role filter counts
- search by user ID
- row click opens edit
- self badge
- role/status badges
- disable/promote/delete actions
- relative created/updated timestamps

### Service

Current file:

- `ServicePage.tsx`

Target components:

- `ServiceStatusPanel`
- `OAuthProviderSettings`
- `OAuthFieldGrid`
- `CallbackUrlCopy`

Behavior to preserve:

- service health/uptime display
- database badge
- OAuth provider form
- copy callback URL behavior
- normalized base URL behavior

## Public Component Inventory

The first component batch should be built before migrating full pages:

| Component | Layer | Used by |
| --- | --- | --- |
| `Button` | ui | all pages |
| `IconButton` | common | sidebar, headers, tables, composer |
| `AppDialog` | common | all modal flows |
| `ConfirmDialog` | common | destructive/session/account/device flows |
| `ActionMenu` | common | row menus, user menu, team menu |
| `PopoverSelect` | common | filters, runtime/model/permission pickers |
| `SegmentedControl` | common | filters, settings, theme |
| `FormField` | common | auth, settings, service, team |
| `TextInput` | common | auth, settings, service, team |
| `PasswordField` | common | auth, account, team |
| `InlineAlert` | common | all error/success messages |
| `StatusBadge` | common | device, team, service, sessions |
| `RuntimeBadge` | common | device, session header, composer |
| `SurfaceCard` | common | settings, service, empty states |
| `EmptyState` | common | session list, tables, workspace/device pages |
| `SkeletonRow` | common | sidebar, tables, timelines |
| `CopyField` | common | pair command, callback URL, code blocks |
| `CommandBlock` | common | pair device, terminal/code display |
| `AttachmentPicker` | session | new session and session detail composer |
| `ComposerBar` | session | new session and session detail |
| `RuntimePanelShell` | runtime | session detail runtime side panel |

## i18n Plan

The current frontend has many hardcoded English strings. `web-next` must move
all user-visible strings into `messages/*.json`.

Initial locale set:

- `en`
- `zh-CN`

Recommended namespace layout:

```text
common
auth
dashboard
sessions
sessionDetail
composer
devices
runtime
workspaces
settings
account
team
service
errors
time
```

Rules:

- Never concatenate translated fragments for sentences.
- Use ICU arguments for names, counts, roles, statuses, dates, and durations.
- Keep product/runtime names untranslated: Agents Anywhere, Codex, Claude,
  openCode, Cursor.
- Keep raw backend error strings only where the API does not yet provide stable
  error codes.
- Shared components receive message strings from callers unless the string is
  truly global, such as common action labels.

Examples:

```json
{
  "common": {
    "actions": {
      "cancel": "Cancel",
      "confirm": "Confirm",
      "delete": "Delete",
      "copy": "Copy"
    }
  },
  "sessions": {
    "empty": {
      "title": "No sessions yet",
      "action": "Start a session"
    }
  }
}
```

## API and State Plan

The old `web/src/lib/api.ts` is broad and can be ported first for compatibility,
then split by domain after routes stabilize.

Recommended structure:

```text
src/lib/api/client.ts
src/lib/api/errors.ts
src/features/auth/api.ts
src/features/dashboard/api.ts
src/features/sessions/api.ts
src/features/devices/api.ts
src/features/runtime/api.ts
src/features/admin/api.ts
```

Stateful flows should live in hooks:

- `useAuthSession`
- `useDashboardData`
- `useDashboardEvents`
- `useSessionTimeline`
- `useSessionComposer`
- `useRuntimeLayout`
- `useTerminalSocket`
- `useRemoteFileBrowser`
- `useMobileSignIn`
- `useUserAdmin`

The migration should not change backend API behavior. Rewrites in
`next.config.ts` should keep the current same-origin frontend behavior.

## Migration Order

### Phase 0: Baseline

Already started:

- Next.js package scaffold.
- Tailwind/shadcn baseline.
- `next-intl` routing and message catalog.
- token-compatible global CSS.
- placeholder page only.

### Phase 1: Audit and Component Foundation

Deliverables:

- this document
- common dialog/menu/form/status components
- shared button/icon-button variants
- Storybook or a lightweight component preview route if needed
- initial `common`, `auth`, and `dashboard` message namespaces

Acceptance:

- `yarn typecheck` passes.
- `yarn build` passes.
- component examples match old CSS visually.

### Phase 2: Auth

Deliverables:

- auth shell
- login/register/bootstrap
- OAuth finalize
- auth errors and password strength

Acceptance:

- auth screens visually match old `web`.
- auth strings available in English and Chinese.
- token restore behavior remains compatible.

### Phase 3: Dashboard Shell

Deliverables:

- dashboard route shell
- sidebar
- session nav rows
- filters and row action menus
- user menu
- onboarding prompt

Acceptance:

- shell and sidebar match old dashboard.
- dashboard SSE refresh behavior preserved.
- collapsed/flyout behavior preserved.

### Phase 4: New Session

Deliverables:

- new-session composer
- attachment picker
- device/runtime/permission/model menus
- workspace picker and remote file browser

Acceptance:

- create-session payloads match old frontend.
- drag/drop and paste image handling work.
- workspace behavior matches old frontend.

### Phase 5: Device, Workspace, Settings, Admin

Deliverables:

- device page and agent flows
- pair device wizard
- runtime settings form
- workspace page
- account/settings
- team
- service

Acceptance:

- all existing management flows preserve behavior.
- shared dialog/menu/form components are used instead of local shells.

### Phase 6: Session Detail and Runtime

Deliverables:

- session timeline
- composer
- approvals
- runtime settings
- files/terminal/preview
- popout windows

Acceptance:

- timeline SSE behavior matches old frontend.
- optimistic send and approval behavior match old frontend.
- runtime panels match old frontend.

### Phase 7: Parity Cutover

Deliverables:

- route parity checklist
- screenshot comparison set
- production build check
- cutover plan

Acceptance:

- approved by product/maintainer after visual comparison.
- old `web/` can remain as fallback until deployment proves stable.

## Validation Checklist for Every Migrated Page

- TypeScript compiles with `yarn typecheck`.
- Production build compiles with `yarn build`.
- Dark theme matches old UI.
- Light theme matches old UI.
- Desktop width matches old UI.
- Mobile/narrow width matches old UI.
- Dialogs trap focus and close with Escape.
- Menus/popovers close on outside click and Escape.
- Keyboard navigation works for dialogs, menus, and forms.
- Loading, empty, error, disabled, hover, active, and destructive states exist.
- English and Chinese messages exist for all user-visible strings.
- Backend errors are handled without crashing.
- No local dev server is auto-started during agent work unless explicitly
  requested.

## Definition of Done

A page/component is done only when:

1. It is implemented in `web-next` using the shared component layers.
2. It preserves the old visual output.
3. It preserves the old behavior.
4. It has i18n coverage.
5. It compiles in production.
6. Any intentional visual/behavior difference is documented and approved.

Until all six are true, treat the page as partially migrated.
