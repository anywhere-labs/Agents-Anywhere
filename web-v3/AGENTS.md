# Agents Anywhere v3 Web Workbench (`web-v3`) — Agent Guidelines

`web-v3/` is the AA v3 Web Workbench & Portable Assistant (Pi Lite) built on **Next.js 16 (App Router) + Tailwind CSS v4 + Base UI + Anywhere UI + MeshCall v0.4 (`meshcall/web`)**.

Read [`.agents/skills/anywhere-ui/SKILL.md`](./.agents/skills/anywhere-ui/SKILL.md) before adding or modifying UI components.

## Architecture Map

- `lib/types/v3.ts` — Unified TypeScript types matching `contracts/aa-v3/1.0/*`, `connector-v3/src/core/timeline.ts`, and `server-v3`.
- `lib/storage/idb.ts` — Browser IndexedDB vault (`aa-v3-vault`) for client X25519 identity, multi-account sessions, immutable E2EE device trusts (`require_e2ee: true`, `trust_tier: "web_browser"`), offline session cache, assistant conversations, cached DEK, Cloud VFS, and user preferences.
- `lib/api/control-http.ts` — Typed HTTP + SSE client for `server-v3` (`/auth/*`, `/devices/register`, `/drive/*`, `/admin/drive/policies/*`, `/assistant/*`, `/mcp/grants`).
- `lib/auth/oidc.ts` — Browser OAuth 2.0 / OIDC PKCE S256 client (`oidc` auth mode).
- `lib/mesh/control-client.ts` & `lib/mesh/device-tunnel.ts` — `meshcall/web` control plane (`aa.v3.Control`) and dual-mode device tunnel manager (`Noise_IK` / `Noise_IKpsk2` + normal tunnels).
- `lib/mesh/pairing.ts` & `lib/mesh/session-merge.ts` — Out-of-band `aa-pair://v1/...` parser, SHA-256 key fingerprint formatter, and cross-client 5-rule session merger (verified against `../contracts/aa-v3/1.0/fixtures/session-merge.json`).
- `lib/assistant/{crypto,sync,tokens,vfs,mcp-client,runtime}.ts` — Lazy-loaded Pi Lite agent, arbitrary-password PBKDF2 + AES-256-GCM KEK/DEK encryption, dual-fingerprint sync, Tokens Anywhere PKCE + single-key reuse, OPFS/IDB Cloud VFS, and Streamable HTTP MCP client.
- `lib/terminal/{session,keys,touch,mesh-transport,bridge-transport}.ts` & `components/terminal/*` — Framework-free `aa.v3.Terminals` client (snapshot/seq resume, controller/generation rules, auto-claim, keep_size), key→sequence map, touch gesture state machine, MeshCall duplex and mobile `term.*` bridge transports, and the xterm.js view (`docs/v3/terminal-proposal.md`).
- `embed/` — Single-file mobile WebView render bundle (`aa.render/2`, `docs/v3/mobile-bridge.md`): `embed/src/protocol.ts` is the bridge's source of truth (`embed/protocol.schema.json` is generated from it); it reuses `components/conversation/*` and `components/terminal/terminal-view.tsx` as they are. Build with `corepack yarn embed:build`, check with `corepack yarn embed:smoke`.
- `lib/platform/{desktop,export-params,route-params}` & `components/desktop/*` — Desktop (`../desktop-v3`) integration: `window.aaDesktop` bridge (OS-keychain secrets, managed connector), green-lock trust tier, control-plane proxy URLs, and the `AA_DESKTOP_EXPORT=1` static export (dynamic routes pre-rendered for the placeholder `_`; read ids with `useRouteParams`, never `useParams`). All of it is inert in the browser.
- `lib/state/{workbench-context,assistant-context}.tsx` — Top-level providers wired into `components/providers.tsx`.
- `app/(workbench)/` — Every workbench page (home, `/new`, conversations, devices, Orches, `/settings`) shares one `WorkbenchShell` from `app/(workbench)/layout.tsx`, so the sidebar, Orches and their state survive navigation; pages render only their own content.
- `components/workbench/*` & `components/conversation/*` — Workbench chrome (`WorkbenchShell`, dual-mode `WorkbenchSidebar`, ⌘K `CommandPalette`, `SettingsDialog` (⌘, and the account menu), `NewConversation`, `FileBrowser`, `E2eeLockBadge`, `AssistantPanel` (Orches), `Dock` / `ResizeHandle` (right-hand panels), dialogs) and the conversation (timeline renderer shared with the mobile bundle, `Composer`, `ConfigPickers`, `ApprovalDock` (only a jump-to reminder: approvals are answered inline in the thread), `QueueRows`, `SidePanel`, `ConversationHeader`, `ShortcutsDialog`). Interaction logic follows the v2 Web client (`web-next/`) and, where they differ, the familiar patterns of mainstream agent apps (ChatGPT, Claude, Codex, Cursor: centred composer on an empty conversation, inline approvals, regenerate, drop anywhere, ⌘K / ⌘⇧O / ⌘/); layout follows `docs/v3/client-experience-proposal.md`.
- `lib/workbench/*` — Device → agent → project tree, per-account local UI memory (pins, last start, panel), cached device status/settings and drive quota, unified-diff parser.
- `lib/attachments/*` — Attachment transfer (RPC ≤ device cap, Cloud Drive + `fetch_drive_file` above it, one-time AES-GCM key for encrypted devices) and image preview cache.
- `lib/drive/*` & `components/drive/*` — The Cloud Drive page (`app/drive/page.tsx`, folder in the query string `?path=` so the static export needs no dynamic route): path helpers mirroring `server-v3` `core/drive.py` (names, joins, the server-created `/Transfers` and `/Orches` folders, `driveHref`), the row model and what each row allows, expiry / retention formatting, the upload pre-check and presigned upload into a folder, and the page components (`DriveBrowser`, entry table, breadcrumbs, name / move dialogs, upload queue). The server stays the authority on paths; client checks only give friendlier messages.

## Hard Product & Design Guardrails

- **AA v3 Auth Boundary**: AA only supports simple password login (`local` mode), role permissions (`admin` / `member`), and acting as an OAuth/OIDC client (`oidc` mode + Tokens Anywhere client). Do NOT add IdP or general OAuth provider UI to `web-v3`.
- **Web Grey Lock**: Encrypted devices in a browser MUST render the grey lock tier (`trust_tier: "web_browser"`), NEVER green lock, and NEVER fall back to plaintext when locally pinned (`require_e2ee: true`). Only the bundle shipped inside Desktop (`isDesktopApp()` in `lib/platform/desktop.ts`) is a verified app and renders the green lock (`verified_app`).
- **Any-Password Assistant E2EE**: NEVER enforce an artificial minimum password length or block weak passwords on assistant encryption; only show a calm advisory for short passwords.
- **Anywhere UI Discipline (enforced by `tests/design-discipline.test.ts` & `tests/i18n.test.ts`)**:
  - Zero hard-coded hex colors in `.tsx` files (except `viewport.themeColor` in `app/layout.tsx`).
  - Keep `app/globals.css` two-tier `superellipse(1.35)` / `round` geometry and `HarmonyOS Sans SC` CJK-only font stack verbatim.
  - Keep sidebar wordmark hover-free (`components/console/section-switcher.tsx`) and mobile sidebar trigger standalone (`components/console/collapsed-nav-bar.tsx`).
  - Language switcher lives ONLY inside Settings › General (never duplicated in the sidebar).
  - Never expose raw dotted claim keys (like `aa.drive_quota_mb`) to end users; render allowances with `DetailCard` / `DetailList` using rich localized copy.
  - Keep `lib/locales/en.ts` and `lib/locales/zh-CN.ts` in exact key + placeholder parity, and likewise each page module pair merged in `lib/i18n.ts` (`en-drive.ts` / `zh-CN-drive.ts`).
- **No Lockfile Commits**: Never commit `yarn.lock`.

- **Desktop static export**: `desktop-v3` ships this app as a static export (`AA_DESKTOP_EXPORT=1 corepack yarn build`). Do not add server-only features (route handlers, middleware/proxy, server actions, `cookies()`/`headers()`); new dynamic routes need a `layout.tsx` with `generateStaticParams() { return exportPlaceholderParams(...) }` plus `PathKeyed`, and their pages must use `useRouteParams`.

## 字号与层级 (type scale and hierarchy)

Hierarchy comes from a few steps used the same way everywhere, then weight and colour; not from many sizes.

| Size | Token | For |
| --- | --- | --- |
| 12px | `text-xs` | Meta only: timestamps, counts, keyboard hints, badges, a hint line under a row. Never text the user must read to act. |
| 14px | `text-sm` | UI text: sidebar rows, buttons, menus, form labels, settings rows, panel content, thinking and tool output (`Markdown size="compact"`). |
| 15px | `text-reading` (line height 1.7) | Conversation text: replies (`Markdown`), user bubbles, the composer on wide screens. Headings inside a reply stay within a step of the text (h1 1.25em, h2 1.125em, h3–h6 1em; `.aa-md` in `app/globals.css`). |
| 16px | `text-base` | Section and dialog titles; the composer on phones (keeps iOS from zooming on focus). |
| 18px | `text-lg` | Empty-state titles and the like. |
| 24px | `text-2xl` | Page titles (`PageHeader`). |

- No arbitrary sizes (`text-[11px]`, `text-[13px]`, …). The one exception is avatar initials sized to their circle.
- Secondary information keeps its size and turns `text-muted-foreground`; it is not shrunk a step.
- Weight: 400 for text, 500 for row names and bar titles, 600 for page and dialog titles.
- The brand wordmark is the Agents Anywhere handwriting (pre-shaped Caveat outlines in `components/brand-wordmark.tsx`, the same mark as v2); it is the one place a script face appears and is never swapped for a UI font.

## Panels

- The left sidebar (`components/ui/sidebar.tsx`, offcanvas) folds away with ⌘B or the button in its header; while folded, `SidebarReopen` keeps a sidebar button and a new-conversation button at the top left. Its width comes from the shell (`--sidebar-width`), dragged by the right edge, double-click for the default; both are kept in this browser (`aa.sidebar.*`).
- Right-hand panels use `Dock` (`components/workbench/dock.tsx`): docked beside the page (pushing it over) or, when there is no room, over it; they slide in and out whole with `DOCK_EASE` and are resized by the left edge. Orches docks from 1024px (⌘J or its sidebar row); the conversation side panel docks while the thread keeps 520px. Phones use bottom sheets.

## Verification

```bash
corepack yarn typecheck && corepack yarn lint && corepack yarn test && corepack yarn build
```

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
