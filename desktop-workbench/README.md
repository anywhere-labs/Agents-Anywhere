# Desktop Workbench

Agents Anywhere Desktop combines the web workbench and a locally managed
Connector in one Electron application.

The Connector supervisor, Desktop startup logs, settings and local binding live in an
independent backend process (`child_process.fork` with `ELECTRON_RUN_AS_NODE`).
It never touches the window, so a blocked or crashed backend cannot freeze the
user interface. The backend serves a loopback HTTP + SSE API; Electron Main
re-exposes it under `/desktop-api` on the app origin, so the renderer keeps
talking to one same-origin endpoint and never sees the port or the per-launch
token. Native shell concerns — window, tray, updates, notifications, OAuth and
file dialogs — stay in Main over IPC.

```text
Renderer -> /desktop-api (same origin) -> Electron Main -> loopback HTTP+SSE -> Desktop backend -> embedded TS Connector -> Server
Renderer -> narrow preload IPC --------------------------------------------------> Electron Main (window, updates, OAuth, dialogs)
```

The backend reports ready as soon as its loopback server is listening. Connector
ownership, the login-shell environment snapshot and installation bookkeeping run
afterwards, so none of them delay the window. Connector log lines are coalesced
into batches before they reach the renderer, which keeps one chatty Connector
from causing a render per line.

On Windows, closing the window hides it to the system tray and keeps the local
Connector running. Click the tray icon or choose **打开 Agents Anywhere** to
reopen the window. Choose **退出** from the tray menu to confirm exit and stop
the local Connector; cancelling keeps the app running.

## Add projects by dropping folders

Drop one local folder anywhere over the Desktop sidebar to add it as a project
on this computer's online local Connector. The name comes from the folder name;
automatically discovered projects keep their existing names when added manually.
A successful drop switches to the project list and expands it.

An already-added folder displays an informational message without creating a
second project. Ordinary files and unavailable paths display a folder-required
message. Dropping multiple items (including a mixture of files and folders)
displays “Drop one folder at a time” and adds none of them. The drop cue remains
centered in the sidebar while its project list scrolls. This native drop action
is unavailable in a browser, where local filesystem paths cannot be resolved.
The cue appears only when drag metadata confirms a directory. If the OS hides
that information until drop, the sidebar stays unobstructed and still accepts
the drop for native directory validation. Cancelling a drag, leaving the window,
or dropping elsewhere clears the cue; an idle timeout also clears it if an
external drag ends without sending a cancellation event to the app.

## Run

From the repository root, the local Desktop launcher starts Docker-backed
PostgreSQL and Redis, the Server on fixed port `8000`, the Web app on fixed port
`5174` (Desktop's development sign-in page), and Desktop on fixed port `5184`.
It releases existing listeners on those three application ports, always points
Desktop at the local Server, and stays in the foreground like `./local-up.sh`,
streaming prefixed Server, Web, and Desktop logs (also written to
`.local-dev/logs/`). Press Ctrl-C to stop its application processes (with a 5-second shutdown
timeout); shared PostgreSQL and Redis containers stay running for the next launch.
`down` stops a
launcher still running in another terminal:

```bash
./desktop-local-up.sh
./desktop-local-up.sh down
```

Use `./desktop-local-up.sh --skip-install` to reuse existing dependencies.

To run Desktop by itself:

```bash
cd desktop-workbench
yarn install
yarn dev
```

`yarn dev` starts the bundled `renderer` Next app on the first available local port from `5184`, waits for it, then opens Electron.
By default, the embedded web app talks to `https://web.agents-anywhere.com`.
The desktop shell uses the `/api/v2` API namespace by default.

## Login and server configuration

The login page offers **Agents Anywhere Cloud** and an expandable self-hosted
server form. Both check `GET /api/v2/health` and require `status: "ok"` before
opening sign-in. HTTP errors, invalid responses, and a 10-second timeout stay on
the login page so the address can be corrected and retried.

`config.json` is the shared source for the official Cloud backend/Web origins,
API namespace, health timeout, and Desktop OAuth client settings. The build and
development launchers read the same file. The OAuth protocol must also match the
registered scheme in `package.json` and the server's first-party client registry.

Like iOS, Desktop assumes a self-hosted server exposes its Web app at the same
origin. It opens `WEB_ORIGIN/#/desktop-oauth` with `response_type=code`, the
Desktop client ID/redirect URI, a random `state`, and an S256 PKCE challenge.
After `agents-anywhere-desktop://oauth/callback`, Main verifies `state` and
exchanges the code and original verifier at the selected backend's
`/api/v2/oauth/token`. Health does not provide or discover the Web origin.

The packaged app uses the system browser. Development uses a separate Web
window with the same OAuth flow, intercepting the callback without installing
an OS protocol handler. After sign-in succeeds, the server is remembered in
`desktop-server.json` in Electron's user-data directory; API requests, downloads,
and WebSockets follow that server. Cloud sign-in always selects the official
Cloud address, regardless of a previously entered self-hosted address.

For separate API/Web deployments, set `WORKBENCH_API_ORIGIN` and
`WORKBENCH_OAUTH_WEB_ORIGIN` to the matching pair, then enter that API origin in
the self-hosted form. The override applies only to that backend. In development,
loopback API port `8000` defaults to Web port `5174`.

## Renderer startup

To point Electron at an already running web app:

```bash
cd desktop-workbench
WORKBENCH_WEB_URL=http://127.0.0.1:5184 yarn start
```

To run against a static export:

```bash
cd desktop-workbench
yarn build:web
yarn start
```

To use a different backend with the default `/api/v2` namespace, provide the
matching Web origin used for browser-based Desktop OAuth. Local development
defaults an API on port `8000` to the Web app on port `5174`:

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 WORKBENCH_OAUTH_WEB_ORIGIN=http://127.0.0.1:5174 yarn dev
```

To use a backend with root API paths, explicitly provide an empty namespace:

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 WORKBENCH_API_NAMESPACE= yarn dev
```

Desktop runs the v3 TypeScript Connector (`../connector-ts`) inside the app: no
Python, uv or package download is involved. `yarn bundle:connector` bundles its
Desktop entry with esbuild into `dist/connector/` (`desktop-main.js` and the
store's `worker-entry.js`); Main forks it as an Electron utility process when
the backend asks, and the Connector posts its control endpoint and host key over
the parent port. Desktop then drives it over `aa.local.v2.Control` and `Logs`
on the Connector's local MeshCall Router, exactly as before. It needs the
Connector's dependencies installed once (`cd ../connector-ts && yarn install`).

`yarn bundle:router` builds that Router into
`build/meshcall-router/<platform>-<arch>/meshcall-router[.exe]` from the MeshCall
commit `vendor/meshcall` pins (0.4.0 has no release binaries yet), so it needs
Go and git; `MESHCALL_SOURCE_DIR` points at an existing checkout instead of
cloning into `.cache/meshcall`. `yarn dev` and `yarn start` run these steps
and `bundle:frpc` first. Overrides:

```bash
WORKBENCH_CONNECTOR_ENTRY=/absolute/path/to/desktop-main.js yarn dev
MESHCALL_ROUTER_BINARY=/absolute/path/to/meshcall-router yarn dev
```

Desktop's Connector entry is `connector-entry/desktop-main.mts`: connector-ts's
desktop-host plus port preview (`previewHost` from
`connector-ts/src/workspace/preview`), which registers the `preview.open` /
`preview.close` commands and sends `port.listening` / `port.closed` on
`Link/attach`. Previews run on the frp client `yarn bundle:frpc` places in
`build/frpc/<platform>-<arch>/` (frp 0.72.0, sha256 pinned in
`scripts/prepare-frpc.mjs`, cached under `.cache/frp`; packaged as
`resources/frpc`, `FRPC_BUNDLE_TARGETS` like the Router). Without it every
preview is refused. A custom proxy in the Connector network setting is frpc's
proxy too; the system proxy is not applied to frpc yet. `bundle:connector`
type-checks the entry with connector-ts's TypeScript before bundling.

The Connector keeps using Desktop's `userData/connector/connector.json`, so an
upgraded Desktop keeps its device credential and binding. Its data lives in the
machine-wide `~/.agents-anywhere/v3`, shared with the command-line Connector
and the DSH plugin; v2 session files under `~/.agents-anywhere/` are imported by
the Connector on its first start and left in place. On the first launch Desktop
deletes what the Python Connector left under `userData/connector` (`.venv`,
`uv-cache`, `connector-source` and the environment receipts). The saved
`connectorProxy` is the Connector config's `proxy` (`system` when empty), see
[Connector network](../docs/connector-network.md).

Do not start a second Connector with the same Desktop config while the app is
running. Standalone CLI devices remain supported and should use their own
config.

## Checks

```bash
yarn typecheck
yarn test:main
yarn renderer:typecheck
yarn workspace agents-anywhere-desktop-renderer test
yarn workspace agents-anywhere-desktop-renderer protocol:check
```

`test:main` covers the embedded Connector's lifecycle and version arbitration, Desktop provisioning, account isolation, local disconnect,
local-versus-remote reconnect behavior, quit handling, API routing, and credential
redaction in logs. Renderer tests cover pairing, project resolution and ordering,
preferences, clipboard fallbacks, and terminal inventory/restore behavior. These
checks run headlessly without starting Electron or a development server.

## Packaging

The release build carries the bundled Connector (`dist/connector/`, unpacked from
the asar because its store starts a worker thread from a file) and the
platform's MeshCall Router under `resources/meshcall-router`. Nothing is
installed or downloaded on first run:

```bash
yarn dist:mac               # universal macOS DMG (Apple Silicon + Intel)
yarn dist:mac --universal   # one DMG for Apple Silicon and Intel
yarn dist:win               # Windows NSIS installer (x64)
yarn pack                   # unpacked Electron application
yarn dist                   # host-platform release (universal on macOS)
```

`dist`, `dist:mac` and `dist:win` read the signing environment, run the Router,
frpc and Pi bundles and the app build with those secrets stripped, and hand them to electron-builder
only. The signing material is therefore never visible to a build or test
subprocess. Add `--arm64`, `--x64` or `--universal` (macOS) to select the
architecture, or `--dir` for an unpacked build. `dist:mac` must run on macOS and
`dist:win` on Windows.

| Environment | Effect |
| --- | --- |
| `MAC_CERT_P12_BASE64` + `MACOS_SIGN_IDENTITY` + `CSC_KEY_PASSWORD` | macOS signing from a Base64 PKCS#12, mapped to `CSC_LINK`/`CSC_NAME` |
| `CSC_LINK` + `CSC_KEY_PASSWORD` (`CSC_NAME` optional) | Signing from a certificate file or URL |
| `CSC_NAME` | Select a Keychain identity; without it auto-discovery picks one |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | Notarize through notarytool |
| `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | Notarize through an App Store Connect API key |
| `APPLE_KEYCHAIN_PROFILE` (`APPLE_KEYCHAIN` optional) | Notarize through a stored keychain profile |
| `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`, or `WIN_CERT_P12_BASE64` + `WIN_CSC_KEY_PASSWORD` | Authenticode signing |
| `CSC_IDENTITY_AUTO_DISCOVERY=false` | Force an unsigned build |

A credential group is all-or-nothing: a half-configured release fails before
anything is packaged. With no credentials the artifact is built unsigned and the
script says which step was skipped. After a signed macOS build the script runs
`codesign --verify` (and `xcrun stapler validate` when notarized).

`ROUTER_BUNDLE_TARGETS` selects Router targets (`darwin-arm64,darwin-x64`);
`dist:mac --universal` builds both macOS Routers automatically, and Go
cross-compiles them from any host. Packaged builds keep config, binding and logs
under Electron `userData`; signed resources are never modified at runtime.

`bundle:pi` pre-installs the Pi ACP adapter and SDK into `build/pi-runtime/`
from the Connector's `connector/runtimes/acp/profiles/pi/dependencies.json`,
with the same npm flags the Connector uses (no install scripts, no lockfile).
It keeps only the prebuilt native modules of `PI_BUNDLE_TARGETS` (set by
`dist` like the other bundles) and drops `.bin` shims; `PI_BUNDLE_NPM_REGISTRY`
installs from a mirror such as `https://registry.npmmirror.com`. The
`afterPack` hook (`scripts/after-pack.cjs`) copies it to `resources/pi-runtime`
before signing, because electron-builder drops `node_modules` from
`extraResources`. It adds about 160 MB on disk (about 28 MB compressed). At
runtime the Connector copies it into its npm cache when the dependency list
matches and runs Pi on the Desktop executable with `ELECTRON_RUN_AS_NODE=1`, so
Pi needs neither a Node download nor npm. Without a matching bundle it falls
back to a compatible system Node or a download. (This is the v2 Connector's Pi
runtime; the embedded TS Connector does not start Pi yet, and the bundle stays
until it does.)

## Desktop updates

After authentication finishes and the workbench opens, Main checks the saved
server's `/api/v2/health`. The authenticated session must match the saved server;
login screens, missing server records, and default configuration never trigger
an update check. Signing out cancels pending work and clears the update dialog.
The server's `version` is compared numerically with the Server version recorded
at build time, not with `app.getVersion()`. `yarn build:main` (and therefore
`yarn dev`, `yarn build` and `yarn dist:*`) runs `scripts/write-build-info.mjs`,
which copies `server/pyproject.toml`'s version into the generated
`build-info.json`. A live Server newer than that baseline means a newer Desktop
build exists; Desktop and Server PATCH versions may otherwise differ (see
[versioning](../docs/versioning.md)). No dedicated release API is used.

A Desktop built against an older Server opens an update dialog with **Ignore this version** and
**Update now**. Outside clicks and Escape do not dismiss it; there is no close
icon. Ignoring persists the exact server version in
`<Electron userData>/updates/state.json`, scoped to the server. A newer server
version prompts again. The download icon beside the account avatar remains
visible whenever the Server is ahead of the build baseline, including after ignoring a version.

`updates.downloadUrls` in `config.json` maps `process.platform` to the fixed
HTTPS installer address. `darwin` and `win32` point at
`https://www.agents-anywhere.com/api/download/<mac|windows>/latest`, which the
official site redirects to the latest installer. The site has no Linux
installer, so Linux and `.invalid` placeholder addresses report that the
download is not available. Downloads stream into `<Electron userData>/updates/downloads`
with progress, remove incomplete files on failure/quit, and open the completed
installer with the OS. Installing the new app remains an installer operation.

## Shared local machine record

On every launch, including `yarn dev`, Main validates its actual installation
and publishes only the `desktop` field in
`<OS user home>/.agents-anywhere/connector-runtime.json`. Unchanged installation
metadata is not rewritten. Development records contain the Electron executable,
project path and launch arguments; packaged records contain the installed app
and executable paths. The DSH plugin reads this metadata without modifying it.

The Connector alone maintains the ordered `connectorIds` history and runtime
ownership. Every accepted start, including CLI and reconnection, appends a missing
ID once. Desktop writes installation metadata under the same short file transaction
as the Connector, preserving IDs, runtime ownership and unknown fields. Hosts read legacy
records without migrating them; the Connector performs the migration on a successful write.
When the OS refuses the transaction's loopback port and nobody listens on it (for
example a Windows excluded port range), both writers log a warning and write
without the lease instead of failing startup; see the shared record contract.

Desktop and the DSH plugin match local IDs against the signed-in user's server
device list. First-login provisioning and pairing after a deleted device reuse the
first matching ID in local order and rotate its token. An empty intersection creates
a device; list or token-rotation failures stop provisioning for retry. Private
bindings and credentials are retained when the Connector rejects startup, so a retry does
not create a duplicate device. Tokens remain private. See the
[shared record contract](../contracts/local-machine/2.0/README.md).

Sidebar devices use fixed Chinese pinyin/name ordering and an ID tie-breaker,
so polling, presence changes and same-name devices do not reorder the list.

## Desktop onboarding

Desktop owns its onboarding at `#/onboarding`: four pages (认识 Agent → 配置设备
→ 连接手机 → 准备就绪) copied unchanged from
`web-next/src/components/onboarding/reference`. Only the data source differs —
Desktop provisions its own local device instead of reading one handed over by
the plugin. The complete page records completion through
`workbench:onboarding:complete`; entering the flow never records it.

| Entry | Behavior |
| --- | --- |
| The user launches Desktop normally | Shown once, until `onboarding.completedAt` exists in the shared record. |
| `agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=<id>` from the DSH plugin | Always shown, flag or not. A redelivered `flowId` is ignored; every new click starts a new flow. |
| A silent login-item launch | Never shown and never recorded. |

The flag lives in `<OS user home>/.agents-anywhere/connector-runtime.json` under
`onboarding`, is written by the backend under the same short file transaction
as the installation metadata, and is read by Main before the window is created.
The plugin neither reads nor writes it. Onboarding entries bypass the Connector
ownership gate, so a user can finish setup before the local Connector is ready.
Development builds do not register the OS protocol, so a plugin entry arrives
through argv instead of `open-url`.

## Connector lifecycle

Startup exclusion and version arbitration live in the Connector and include CLI,
Desktop and DSH plugin Connectors. Main calls `connector.acquireOwnership` before
provisioning. RPC conflicts use `-32009 / connector_already_running`, and their
`decision` says what Desktop does:

- `conflict` (a v2 Connector, or one of unknown version): Desktop shows a
  retryable conflict with the owner and stops automatic restart attempts. The
  control channel stays usable, and retry asks the Connector again.
- `request_handover` is handled inside the Connector: an older v3 Connector is
  asked to hand over and waited for (up to five minutes, so the ownership probe
  allows that long).
- `use_existing` (a newer Connector already serves the machine): Desktop stops
  its own Connector, does not restart it, and reports ownership `external`.
  The gate lets the app through: sign-in, sessions, devices and settings go
  through the Server. The sidebar and the Desktop settings tab say which
  Connector (source, version, PID, and its device's server status) connects
  the computer; starting, stopping, pairing, the proxy and the connection
  settings of the local Connector are unavailable, and nothing is provisioned.
  Desktop has no key for that Connector's control channel (the keys it
  publishes only request a handover or a client pairing), so the details come
  from `connector-runtime.json` and the owner's `<instanceId>.handover.json`.

A Desktop Connector that hands over to a newer one (`stopped` with
`handed_over`) is treated the same way. While `external`, Desktop reads the
lease record every 5 seconds; once the owner's process is gone it claims the
machine again (launching its own Connector), backing off from 5 to 60 seconds
while claims keep finding a newer Connector, plus a claim every 5 minutes in
case the record is stale or unreadable. Taking the machine back restarts
Desktop's runtime if it was running when it stepped aside, or follows
"start the Connector on launch" otherwise. Only `conflict` and failures block
the window. `connector.stop` stops the server
connection; ownership remains while that Connector process is alive. Explicit
Quit asks it to shut down (and kills it after five seconds); a utility process
also ends with Main, and the Connector stops when its parent port closes.

Until the first probe answers, ownership is `checking`, which the renderer shows
as progress rather than as a failure. Any other failure opens a blocking dialog
that quotes the underlying error and offers to copy it or open the logs folder.
When the Connector fails to start (`failed` with a code), exits, or times out
before answering, the error includes its last output lines; output is logged in
whole lines. Every failed acquisition, including a retry, is logged. If the
backend stops after it became ready, owned or not, the dialog quotes the
backend's exit code, last reported error and output, and its **Restart** starts a
new backend, which probes ownership again; Main kills the old backend's Connector. The backend owns the log, so Main appends to it directly
whenever no ready backend is running. A launch whose backend never becomes ready
shows a native error box with the log directory before quitting.

Startup work after `ready` (shell environment, ownership, installation record,
binding adoption, the launch auto-start) reports failures where the renderer
looks: the gate while ownership is not settled, the Connector's `lastError` once
it is. A Connector that exits without being stopped also records its exit and
last output lines in `lastError` until a new process reports its own state.

- Successful Desktop login reuses a matching local device or provisions a
  `connectorKind: "desktop"` device with the user-authenticated Connector API.
- Successful local connection, reconnection, CLI pairing and pair-code completion
  refresh the device list without opening an Agent quick-setup dialog.
- Electron Main persists the returned `connectorId` and `connectorToken`, then
  sends them to the Connector through `connector.saveConfig`.
- Closing the window on macOS keeps the app and Connector running in the
  background. Explicit Quit stops the runtime and terminates the full process
  tree.
- Open-at-login, silent launch, automatic Connector start, the Connector
  network and log retention are Desktop settings. Settings of the Python
  Connector (uv and Python paths, package mirrors) are dropped.
- An authentication failure is surfaced to the renderer and is not retried
  automatically. Reconnection must be confirmed on that physical Desktop.
- Factory reset revokes the current Desktop credential on the Server first. A
  failed revoke does not silently erase the only local binding. After an
  explicit second confirmation, `forceLocal: true` permits an offline local
  reset without a login session; it also clears Electron web storage and cache.

## Workbench terminals

Terminals use the same Connector lifecycle as Web. Opening the terminal tool
queries the selected device and workspace before creating a shell. Reloading the
renderer restores existing terminal IDs and output from the Connector; local
storage holds only view preferences, scoped to the actual server and account.
Closing a terminal tab closes that terminal. Leaving the page, signing out, or
quitting Desktop does not send terminal-close requests.

Electron does not track terminal credentials, promote terminals to persistent
mode, or renew their leases. Ordinary Connector cleanup remains in charge:
30 minutes of inactivity by default, with exited records retained for 15 minutes.
The bundled local Connector still stops when Desktop quits, so its terminals
end with that process. Terminals on a separately running Connector can remain
available under its normal cleanup rules.

## Token boundary

- The renderer supplies its user token only for an explicit create, reconnect,
  disconnect, or factory-reset call.
- The user token is used transiently by Electron Main. It is never written to
  disk, logged, or passed to the Connector process.
- `connectorToken` is persisted with restricted file permissions, but is never
  returned through preload IPC.
- The Connector receives only `serverUrl`, `connectorId`, and
  `connectorToken`, and continues to use Connector-scoped authentication.

## Notes

- This package embeds a copied Next renderer under `renderer`.
- The original repo-level `../web-next` app is not started or modified by the desktop dev script.
- Treat `../web-next` as the upstream source for shared renderer code. Sync source, messages, public assets, scripts, tests, and shared configuration into `renderer`, then reapply the small Desktop-owned integration layer.
- Desktop-owned behavior includes the Electron window and protocol bridge, renderer package identity and port, nested-workspace Next configuration, native title-bar spacing, window drag regions, the shell header, and Desktop sidebar behavior.
- Do not copy generated or installed content such as `.next`, `node_modules`, `.yarn`, or `out` from `../web-next`.
- Production/static mode expects `renderer/out`, or a custom `WORKBENCH_WEB_OUT_DIR`.

Shared Web fixes synchronized on 2026-09-06 include device pairing, compact
settings sections, project/directory defaults and creation, project ordering and
expansion persistence, tool cards, file editing safeguards, and terminal restore.
See the [frontend/Desktop handoff](../docs/migrations/main-to-v2/frontend-desktop-follow-up.md)
for scope and verification. Pairing and mobile login use the selected public
server address; native renderer URLs are never shared as connection addresses.

### Universal macOS installers

On macOS, `yarn dist` and `yarn dist:mac` build a universal DMG for Apple Silicon
and Intel by default, bundling the Router for both architectures. Explicit `--arm64` or
`--x64` builds remain available for diagnostics. Both commands use the same
signing and notarization credential checks.

Use `yarn dist:mac --skip-build` to retry packaging after a completed app build;
it requires existing compiled output and both Router builds. Run a full build after
changing application source. Yarn installs both CPU variants of optional native
dependencies for universal packaging.

For an offline packaging retry, set `WORKBENCH_ELECTRON_DIST` to a directory
containing the matching Electron ZIPs for both macOS architectures.

Runtime logs are persisted by Connector under `~/.agents-anywhere/logs/` as rotating
JSONL segments. Desktop reads, follows, clears and exports them through the local
`aa.local.v2.Logs` service; receiving a runtime log never writes another Desktop
copy. Log storage settings apply to Desktop startup diagnostics only. When no
Connector channel is available, the log view and export use those local startup
diagnostics. Runtime retention and RPC semantics are documented in
[the log contract](../contracts/dsh-bridge/2.0/logs.md).
