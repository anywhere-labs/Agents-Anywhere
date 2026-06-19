# web-next Refactor Agent Guide

This package is the Next.js rewrite target for the existing `web/` frontend.
Every change in this package must preserve the product behavior and visual
language of the current React/Vite implementation while improving engineering
structure.

## Goal

Build a replacement web frontend with:

- Next.js App Router, TypeScript, React, Tailwind CSS, shadcn/Radix primitives.
- First-class i18n through `next-intl`.
- Componentized UI primitives and business components instead of repeated local
  modal, menu, form, and page-layout implementations.
- A migration path where the old `web/` package can keep running until
  `web-next/` reaches parity.

## Non-Negotiable Visual Parity

The refactor must look exactly like the current `web/` UI unless a later task
explicitly approves a design change.

- Reuse the current design tokens from `web/src/styles/tokens.css`.
- Preserve current dark/light colors, typography scale, border radii, shadows,
  scrollbar styling, spacing density, and interaction timing.
- Recreate existing page layouts before improving internals.
- Do not introduce a new visual theme, larger marketing-style layout, gradient
  decoration, oversized cards, or generic SaaS template styling.
- When porting a page, compare it against the old `web/` page at desktop and
  mobile widths. Any visible difference must be intentional and documented.

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
src/components/common/   project-wide composed UI
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

- `AppDialog` and `ConfirmDialog` for all modal shells and confirmation flows.
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
when a Radix primitive fits.

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

1. Establish app shell, tokens, shadcn primitives, and i18n.
2. Port auth pages.
3. Port dashboard shell, sidebar, session list, filters, and row menus.
4. Port new-session composer and workspace picker.
5. Port device page, pair-device flow, add-agent flow, and workspace page.
6. Port settings, account, team, and service pages.
7. Port session detail, timeline, approvals, runtime settings, files,
   terminal, and file preview.
8. Run parity checks and replace production references only after approval.

## Verification

For each migrated page:

- Run `yarn typecheck`.
- Run `yarn build` when the page is intended to compile end-to-end.
- Compare against the old `web/` UI with screenshots at common desktop and
  mobile widths.
- Verify light and dark themes.
- Verify English and Chinese locales.
- Verify keyboard navigation for dialogs, menus, popovers, and forms.

## Current Baseline

The initial package intentionally contains only the framework skeleton, design
tokens, i18n setup, and a minimal placeholder page. Do not treat the placeholder
as product UI. Replace it page by page with parity implementations from `web/`.
