# web-next Refactor Agent Guide

This package is the Next.js rewrite target for the existing `web/` frontend.
Every change in this package must preserve the product behavior and business
flows of the current React/Vite implementation while improving engineering
structure. The local shadcn demo under `_reference/demo-shadcn` is now the
primary implementation baseline for the rewrite.

## Goal

Build a replacement web frontend with:

- Next.js App Router, TypeScript, React, Tailwind CSS, shadcn/Radix primitives.
- First-class i18n through `next-intl`.
- Componentized UI primitives and business components instead of repeated local
  modal, menu, form, and page-layout implementations.
- A migration path where the old `web/` package can keep running until
  `web-next/` reaches functional parity.

## Design Direction

The refactor no longer needs to look exactly like the current `web/` UI. The
new target is the shadcn/Radix implementation demonstrated in
`_reference/demo-shadcn`, wired to the real Agents Anywhere API, i18n, auth, and
session/runtime behavior.

- Prefer existing shadcn primitives before creating local UI shells:
  `Sidebar`, `DropdownMenu`, `Dialog`, `AlertDialog`, `Popover`, `Command`,
  `Select`, `Tabs`, `Table`, `Card`, `Avatar`, `Badge`, `ScrollArea`,
  `ResizablePanelGroup`, `Sheet`, `Tooltip`, `Button`, `Input`, and `Textarea`.
- Treat the demo's `components/ui/*` as an acceptable shadcn component set for
  this package. Reuse those components unless there is a clear incompatibility
  with our installed dependency versions or accessibility requirements.
- Treat demo business components as migration baselines:
  `AppSidebar`, `TaskComposer`, `SessionView`, `WorkspacePicker`,
  `PairDeviceDialog`, `FloatingWindow`, `CascadingSelector`, `AttachmentInput`,
  `PanelHeader`, `FilesPanel`, `TerminalPanel`, `PreviewPanel`, and the
  settings/team/service/device pages.
- Use the old `web/` frontend as the source for product behavior, business
  states, route coverage, and backend contracts, not as a strict visual target.
- Replace demo mock data with real domain APIs and typed mock adapters; do not
  redesign the UI from scratch while doing that wiring.
- The former yellow accent is intentionally being removed in `web-next`.
  Emphasis actions should use shadcn semantic tokens such as `primary`,
  `secondary`, `muted`, `accent`, and `destructive`.
- Keep the app utilitarian and workflow-focused. Do not turn core product pages
  into marketing pages or decorative dashboards.
- When old behavior conflicts with shadcn conventions, prefer shadcn behavior
  unless the product flow would break.

## Package Boundaries

- Do not edit `web/` while implementing `web-next/` unless the task explicitly
  asks for shared behavior changes.
- Do not import runtime code from `web/` directly. Port reusable logic into
  `web-next/src/lib` with clear ownership.
- Keep `web-next/` runnable on its own with `yarn dev`.
- Do not automatically start the dev server unless the user asks. For testing,
  provide the command or run non-server checks such as `yarn typecheck` and
  `yarn build`.

## Architecture

Use this structure:

```text
src/app/[locale]/        App Router pages and layouts
src/components/ui/       shadcn-compatible primitives
src/components/common/   project-wide composed UI built on shadcn
src/components/layout/   app shell, sidebar, headers
src/components/auth/     auth-specific UI
src/components/session/  session list, timeline, composer
src/components/device/   device, workspace, agent management
src/components/runtime/  files, terminal, file preview
src/components/admin/    team, service, settings surfaces
src/lib/                 api, utilities, domain helpers
src/i18n/                locale routing and request config
messages/                locale message catalogs
```

Page files should stay thin. Data loading, SSE synchronization, optimistic UI,
and mutation flows belong in hooks or domain modules.

## Components To Standardize

Before or while porting pages, replace repeated one-off UI with shared
components:

- `Dialog`/`AlertDialog` wrappers for all modal shells and confirmation flows.
- `WizardDialog` for multi-step flows such as pairing a device.
- `DropdownActionMenu`, `PopoverSelect`, and `Combobox` for all anchored menus.
- `PageHeader`, `SettingsShell`, `SettingsCard`, `KeyValueList`, `SettingRow`.
- `IconButton`, `StatusBadge`, `RuntimeBadge`, `CopyField`, `CommandBlock`.
- `EmptyState`, `LoadingState`, `InlineAlert`, `FormError`, `SkeletonRow`.
- `PasswordField`, `PasswordStrength`, `AvatarPicker`.
- `AttachmentPicker`, `AttachmentChip`, `ComposerBar`.
- `RuntimePanelShell`, `PanelHeader`, `ResizableSplit`.

Use shadcn/Radix primitives for accessibility and behavior. Do not hand-roll
outside-click listeners, Escape handling, popover positioning, or focus traps
when a Radix primitive fits. Existing custom components should be reduced to
business composition over shadcn primitives. Prefer adapting the demo component
to real data over keeping parallel hand-written implementations.

## i18n Rules

- All user-visible strings must use `next-intl`.
- Use domain namespaces such as `common`, `auth`, `sessions`, `devices`,
  `settings`, `team`, and `service`.
- Do not concatenate translated fragments when grammar or pluralization may
  differ across locales. Use formatter arguments instead.
- Product names such as Codex, Claude, and Agents Anywhere are not translated.
- Backend error strings may be displayed as returned until the API exposes
  stable error codes.

## Migration Order

1. Promote the demo shadcn component set and app shell into `src`.
2. Wire auth pages to real auth APIs and i18n.
3. Wire dashboard shell, sidebar, session list, filters, and row menus.
4. Wire new-session composer and workspace picker.
5. Wire device page, pair-device flow, add-agent flow, and workspace page.
6. Wire settings, account, team, and service pages.
7. Wire session detail, timeline, approvals, runtime settings, files,
   terminal, and file preview.
8. Run functional checks and replace production references only after approval.

## Verification

For each migrated page:

- Run `yarn typecheck`.
- Run `yarn build` when the page is intended to compile end-to-end.
- Compare business behavior against the old `web/` UI when needed.
- Compare composition and interaction patterns against `_reference/demo-shadcn`.
- Verify light and dark themes.
- Verify English and Chinese locales.
- Verify keyboard navigation for dialogs, menus, popovers, and forms.

## Current Baseline

The package now contains a shadcn demo baseline under `_reference/demo-shadcn`.
The demo can replace large parts of the current rewrite direction. Move or adapt
demo components into `src` deliberately, then connect them to real APIs, i18n,
and backend state.
