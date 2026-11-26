---
name: anywhere-ui
description: Design system rules, token discipline, geometry, typography, controls, content copywriting, TanStack Query guardrails, ViewTransition motion, and shadcn registry usage for Anywhere Labs web consoles and admin dashboards.
---

# Anywhere UI Design System

Use this skill whenever creating or modifying web interfaces styled with **Anywhere UI** (Next.js + Tailwind CSS v4 + Base UI + shadcn). Full human-readable specification: `docs/design-system.md` (中文) / `docs/design-system.en.md` (English).

## 1. Visual Philosophy & Surface Hierarchy

Anywhere UI is a calm, monochrome, dark-first console aesthetic (dark is the default theme; light is a full first-class sibling):

- **Never hard-code hex colors in `.tsx` files.** Always use semantic CSS variable utilities (`bg-background`, `bg-card`, `bg-surface-raised`, `bg-surface-hover`, `bg-secondary`, `bg-popover`, `text-foreground`, `text-foreground-secondary`, `text-muted-foreground`, `border-border`, `border-border-strong`).
- **Dark palette**:
  - Canvas `--background`: `#000000` (pure black)
  - Borderless card `--card`: `#141414`
  - Raised surface / popover / sidebar active `--surface-raised` / `--popover` / `--sidebar-accent`: `#191919`
  - Hover surface `--surface-hover` / `--accent`: `#252525`
  - Secondary pill / active tile `--secondary`: `#262626`
  - Wireframe border `--border-strong`: `#303030`
- **Light palette**:
  - Canvas `--background`: `oklch(1 0 0)` (`#ffffff`)
  - Borderless card `--card`: `#f3f3f3`
  - Raised surface `--surface-raised`: `#ececec`
  - Secondary / hover `--secondary` / `--surface-hover`: `#e4e4e4`
  - Sidebar canvas `--sidebar`: `oklch(0.985 0 0)`
  - Sidebar active pill `--sidebar-accent`: `oklch(0.92 0 0)` (keeps clear contrast on `#fafafa` sidebar)
- **Borderless surfaces**:
  - Cards (`rounded-card bg-card`), theme selection tiles (`rounded-2xl bg-card`), nested value panels (`rounded-xl bg-background` inside `bg-card`), and user avatars (`UserAvatar`) are **borderless** — separated by tonal steps, never heavy borders.
  - **Standalone icons are borderless**: never wrap a lone status/empty-state/hero icon inside a gray circular or square container (`rounded-full bg-surface-raised`). Render the icon cleanly at `size-6`–`size-8 stroke-[1.5] text-muted-foreground` (or `text-destructive` / `text-success`).
  - **Icon-only action buttons** (pagination arrows, table row actions, copy button, mobile drawer trigger) use `variant="ghost"` (`size="icon-sm"` or `size="icon-xs"`), never boxed outlines.

## 2. Typography (Mixed Latin + CJK)

- **English / Latin / digits**: keep the native system stack — `"SF Pro Text"` / `"SF Pro Display"` on Apple, `"Segoe UI"` on Windows.
- **Chinese (Simplified Chinese / CJK punctuation)**: use self-hosted variable **HarmonyOS Sans SC** (`@luzixu/harmonyos-sans`, variable weight `40 900`), loaded via `app/harmonyos-sans-sc.css` containing **only** the CJK/punctuation WOFF2 subsets (`sc-*`) and **omitting** the Latin `font-text-*` slice.
- Place `"HarmonyOS Sans SC"` **before** `"SF Pro Text"` / `-apple-system` in `--font-sans` and `--font-display`:
  - ASCII/Latin glyphs do not match `"HarmonyOS Sans SC"`'s `unicode-range`, so English falls straight through to native SF Pro / Segoe UI (and pure English pages download 0 bytes of CJK fonts).
  - Chinese glyphs match `"HarmonyOS Sans SC"` immediately, preventing macOS `-apple-system` from intercepting CJK with PingFang SC.
- **Monospace discipline (`font-mono`)**: reserve strictly for operator/developer identifiers (admin claim keys, client IDs, slugs, callback URIs, JSON editors, `CopyableValue`). Use `tabular-nums` for all quotas, counts, pagination indices, and timestamps.

## 3. Two-Tier Corner Geometry (`corner-shape`)

- Base radius scale: `--radius: 0.75rem` (12px), `--radius-card-max: 32px`, `--radius-card: min(var(--radius-4xl), var(--radius-card-max))` (~31.2px).
- Under `@supports (corner-shape: superellipse(1.35))`:
  1. **Multi-line rounded rectangles** (cards, dialogs, popovers, multi-item menus, textareas, tiles, card skeletons) use `corner-shape: superellipse(1.35)` (subtle G2-continuous smoothing — never boxy `squircle` / `superellipse(2)`).
  2. **Circles & capsules/pills** (`[class*="rounded-full"]`, `button`, `input`, single-line `input-group`, `badge`, `switch`, `switch-thumb`, `sidebar-menu-button`, pill `tabs-list`/`tabs-trigger`, `user-avatar`, `avatar`, `radio-group-*`) MUST remain strictly `corner-shape: round`. Symmetric `superellipse(K > 1)` flattens vertical capsule end-caps into rounded rectangles.
  3. **Never write `[class*="-full"]`** in CSS selectors — it accidentally matches `w-full` and `h-full`. Always write `[class*="rounded-full"]`.
- `Skeleton` defaults to `rounded-card` (override to `rounded-full` for single-line text/button skeletons and `rounded-2xl` for table row skeletons).

## 4. Controls & Information Display Patterns

- **Pill Buttons** (`components/ui/button.tsx`):
  - Two primary visual hierarchies:
    - **Emphasized**: `variant="default"` (`bg-foreground text-background`) — solid high-contrast pill for the single primary action.
    - **Non-emphasized wireframe**: `variant="outline"` (`border-border-strong bg-transparent text-foreground hover:bg-surface-raised`) — calm pill for secondary actions and quick-filter chips.
  - Optical pill padding: `sm` = `h-8 px-4`, `default` = `h-9 px-4`, `lg` = `h-10 px-5`, matching `Input` (`h-9 px-4`) and `Badge` (`h-5 px-2.5`).
  - Use `nativeButton={false}` whenever passing `render={<Link ... />}` to Base UI `Button`.
- **Pill-in-Pill Switch** (`components/ui/switch.tsx`, adapted from shadcn `base-luma`):
  - `44×20` track (`h-5 w-11`) with `24×16` pill thumb (`h-4 w-6`, checked translate `translate-x-[calc(100%-8px)]`).
  - Checked/unchecked contrast on pure black dark canvas: checked track `bg-foreground`, checked thumb `bg-background dark:bg-secondary`; unchecked track `bg-input dark:bg-surface-raised`, unchecked thumb `bg-secondary dark:bg-muted-foreground`.
- **Single-Select Dropdown**: prefer `DropdownSelect` (`components/dropdown-select.tsx`) over native `<select>` for consistent pill trigger + floating menu styling.
- **Confirmation**: destructive actions go through `ConfirmDialog` (`components/console/confirm-dialog.tsx`).
- **Detail & Entitlement Cards (`DetailCard` / `DetailList` in `components/console/detail-list.tsx`)**:
  - Render plans, quotas, entitlements, and structured account attributes inside a borderless `rounded-card bg-card p-6` card with hairline-divided `<dl>` rows: human-readable localized title + rich multi-line explanation on the left, right-aligned `font-semibold tabular-nums` value with localized unit on the right, stacking cleanly on mobile.

## 5. Console Chrome & Information Architecture

- **Top Sidebar Wordmark (`SectionSwitcher`)**:
  - Must **never** show a hover/selected pill background (`hover:bg-sidebar-accent` is forbidden on the wordmark). Only clicking triggers the console-switcher popover (or navigates home when there is only one section).
  - Keyboard accessibility (`focus-visible:ring-2 focus-visible:ring-sidebar-ring`) remains intact.
- **Mobile Top Bar (`CollapsedNavBar`)**:
  - The sidebar expand trigger (`PanelLeftIcon`) is a **standalone ghost icon button** (`Button variant="ghost" size="icon-sm"`).
  - The `BrandWordmark` sits beside it as a separate, non-button sibling with zero hover/selected background.
- **Sidebar Grouping & Footer Account Switcher (`AccountSwitcher`)**:
  - Keep `Home` (`/account`) in its own standalone top group with no section label; place dedicated `Profile` and `Plan` pages cleanly under the `Account` group.
  - Keep domain pages strictly non-overlapping (e.g., `Security` owns credentials, passkeys, 2FA, sessions, activity & deletion; `Connected accounts` owns OAuth provider linking only).
  - Place the signed-in account pill at the **bottom of the sidebar footer** (`AccountSwitcher`) replacing any standalone Sign Out button — clicking opens an upward floating menu (`side="top"`) to switch accounts, add another account, sign out, or sign out of all accounts.
  - When an `Appearance` page already controls display language, do not duplicate a separate language selector in the sidebar footer (keep language switching in `SignInShell`'s top-right header for signed-out visitors).
- **Conditional Navigation**:
  - Hide domain sections (e.g., Organizations) completely from the sidebar, quick pills, and home search when the user has no access or belongs to zero items.
- **Account Home (`/account`)**:
  - Centered editorial hero (avatar with edit pencil, plan pill badge, display name, email), working `/` keyboard-shortcut search pill with floating pill results, wireframe quick-action pills, a single borderless `rounded-card bg-card` contextual spotlight card, and a quiet privacy footer.
- **Sign-In (`SignInShell`)**:
  - Clean centered heading (`Sign in` / `登录` — avoid long redundant subtitles when obvious), split identifier-first or password step, `animate-in duration-700 fade-in slide-in-from-bottom-3`.

## 6. Content, Copywriting & State Guardrails

- **Never expose raw technical keys to end users**:
  - End-user plan/entitlement/settings pages MUST NEVER display raw dotted field keys (e.g. `aa.drive_quota_mb`) or raw technical slugs (e.g. `free`) as badges or subtitles.
  - Always resolve human-friendly, rich, localized titles, descriptions, and localized units (ideally runtime-configurable by admins in the Admin console, where technical claim keys remain visible strictly to operators).
- **Bilingual parity**: update both `en` and `zh-CN` dictionaries together with identical keys and `{placeholder}` sets (`tests/i18n.test.ts`).
- **TanStack Query cache-shape safety**:
  - Export **one canonical hook per shared `queryKey`** (in `lib/queries.ts` or `lib/session.ts`) instead of duplicating inline `useQuery` calls across pages.
  - Never return a wrapped object (`{ items }`) on one route and an unwrapped array (`items[]`) on another under the same `queryKey` (statically enforced by `tests/design-discipline.test.ts`).

## 7. ViewTransition Motion

- Use React `<ViewTransition>` via `PageTransition` (`components/console/page-transition.tsx`) and `useRevealInTransition` (`components/console/use-reveal-in-transition.ts`):
  - `console-enter` (420ms): mounting the console shell after sign-in or reload (wrap gate reveal with `useRevealInTransition` so the mount happens inside `startTransition`).
  - `page-rise` (360ms): navigating between sidebar pages inside the same console section.
  - `nav-forward` / `nav-back` (320ms): switching between console hierarchy levels (`account` ↔ `org` ↔ `admin`).
  - `NAV_STILL`: links inside the mobile drawer so snapshots never bleed through the closing sheet.
- Respect `prefers-reduced-motion: reduce` on all keyframes and view transitions.

## 8. Installing Components via shadcn GitHub Registry

```bash
# Full console kit (theme + UI primitives + console components including DetailList)
npx shadcn@latest add anywhere-labs/anywhere-ui/anywhere-console

# Base theme + core pill primitives
npx shadcn@latest add anywhere-labs/anywhere-ui/anywhere-base

# AI guardrails (AGENTS.md + SKILL.md + design-discipline.test.ts)
npx shadcn@latest add anywhere-labs/anywhere-ui/anywhere-ai-kit

# Individual primitives or console modules
npx shadcn@latest add anywhere-labs/anywhere-ui/button
npx shadcn@latest add anywhere-labs/anywhere-ui/switch
npx shadcn@latest add anywhere-labs/anywhere-ui/detail-list
npx shadcn@latest add anywhere-labs/anywhere-ui/data-table
```
