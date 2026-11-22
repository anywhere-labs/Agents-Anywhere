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
- `lib/assistant/js-sandbox/*` — Experimental `js_run` tool: QuickJS-WASM (`quickjs-emscripten-core` + `@jitl/quickjs-singlefile-browser-release-sync`) inside a throwaway dedicated Worker, with the workspace bridge (`workspace-bridge.ts`) as the only way out. **Never** evaluate model-generated code as JavaScript of this origin (page, same-origin Worker, `eval`, `new Function`, blob/script injection); all checks on paths and sizes live on the host side of the bridge.
- `lib/assistant/controlled-mode.ts` — Experimental controlled mode (browser assistant as a temporary `aa.v3.Sessions` instance). Serving needs a `BrowserServiceHost`; none exists while `meshcall/web` is call-only, so the toggle stays disabled. Never publish presence for an instance that cannot serve.
- `lib/state/{workbench-context,assistant-context}.tsx` — Top-level providers wired into `components/providers.tsx`.
- `components/workbench/*` & `components/conversation/*` — Workbench chrome (`WorkbenchShell`, dual-mode `WorkbenchSidebar`, `E2eeLockBadge`, `AssistantPanel`, dialogs) and timeline conversation renderer.

## Hard Product & Design Guardrails

- **AA v3 Auth Boundary**: AA only supports simple password login (`local` mode), role permissions (`admin` / `member`), and acting as an OAuth/OIDC client (`oidc` mode + Tokens Anywhere client). Do NOT add IdP or general OAuth provider UI to `web-v3`.
- **Web Grey Lock**: Encrypted devices in Web MUST render the grey lock tier (`trust_tier: "web_browser"`), NEVER green lock, and NEVER fall back to plaintext when locally pinned (`require_e2ee: true`).
- **Any-Password Assistant E2EE**: NEVER enforce an artificial minimum password length or block weak passwords on assistant encryption; only show a calm advisory for short passwords.
- **Anywhere UI Discipline (enforced by `tests/design-discipline.test.ts` & `tests/i18n.test.ts`)**:
  - Zero hard-coded hex colors in `.tsx` files (except `viewport.themeColor` in `app/layout.tsx`).
  - Keep `app/globals.css` two-tier `superellipse(1.35)` / `round` geometry and `HarmonyOS Sans SC` CJK-only font stack verbatim.
  - Keep sidebar wordmark hover-free (`components/console/section-switcher.tsx`) and mobile sidebar trigger standalone (`components/console/collapsed-nav-bar.tsx`).
  - Language switcher lives ONLY inside Settings › Appearance (never duplicated in the sidebar).
  - Never expose raw dotted claim keys (like `aa.drive_quota_mb`) to end users; render allowances with `DetailCard` / `DetailList` using rich localized copy.
  - Keep `lib/locales/en.ts` and `lib/locales/zh-CN.ts` in exact key + placeholder parity.
- **No Lockfile Commits**: Never commit `yarn.lock`.

## Verification

```bash
corepack yarn typecheck && corepack yarn lint && corepack yarn test && corepack yarn build
```

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
