# Desktop Workbench

Agents Anywhere Desktop combines the web workbench and a locally managed
Connector in one Electron application.

The Connector, its logs, the Desktop settings and the local binding live in an
independent backend process (`child_process.fork` with `ELECTRON_RUN_AS_NODE`).
It never touches the window, so a blocked or crashed backend cannot freeze the
user interface. The backend serves a loopback HTTP + SSE API; Electron Main
re-exposes it under `/desktop-api` on the app origin, so the renderer keeps
talking to one same-origin endpoint and never sees the port or the per-launch
token. Native shell concerns — window, tray, updates, notifications, OAuth and
file dialogs — stay in Main over IPC.

```text
Renderer -> /desktop-api (same origin) -> Electron Main -> loopback HTTP+SSE -> Desktop backend -> anywhere-cli rpc -> Server
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

## Run

From the repository root, the local Desktop launcher starts Docker-backed
PostgreSQL and Redis, the Server on fixed port `8000`, the Web app on fixed port
`5174` (Desktop's development sign-in page), and Desktop on fixed port `5184`.
It releases existing listeners on those three application ports, always points
Desktop at the local Server, and stays in the foreground like `./local-up.sh`,
streaming prefixed Server, Web, and Desktop logs (also written to
`.local-dev/logs/`). Press Ctrl-C to stop everything it started; `down` stops a
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

Development runs the repo-level `../connector` project with the same `uv` the
packaged app ships, so a dev launch never depends on the developer's PATH.
`yarn dev` and `yarn start` download that uv into
`build/uv/<platform>-<arch>/uv[.exe]` on first use (once, then cached under
`.cache/uv`); `yarn ensure:uv` does the same without starting the app.

`uv` resolution order is the saved `uvPath` setting, then the bundled
`build/uv/<platform>-<arch>/uv[.exe]` (packaged builds read the same directory
from `resources/uv`), then `uv` on PATH. `yarn bundle:uv` re-bundles explicitly
after changing `UV_BUNDLE_VERSION` and also fetches the third-party license
notices that packaging ships. Override the connector source or launcher when
needed:

```bash
WORKBENCH_CONNECTOR_DIR=/absolute/path/to/connector yarn dev
WORKBENCH_CONNECTOR_CLI=/absolute/path/to/anywhere-cli yarn dev
WORKBENCH_UV_BUNDLE_DIR=/absolute/path/to/uv-bundle yarn dev
WORKBENCH_PYTHON_BUNDLE_DIR=/absolute/path/to/python-bundle yarn dev
```

The Python interpreter is resolved as the saved `pythonPath` setting, then the
bundled CPython at `build/python/<platform>-<arch>/` (`python.exe` on Windows,
`bin/python3` elsewhere; packaged builds read `resources/python`). The result
is passed to `uv run --python`, so uv neither searches for nor downloads an
interpreter. Development does not download the bundle automatically: without
`yarn bundle:python` (or a previous `yarn pack`), uv picks an interpreter
itself and may download one. Once the bundle exists, development uses it too,
and uv rebuilds the repo's `connector/.venv` on it once.

The first launch after that also runs `uv sync`, which downloads every
Connector dependency (and the interpreter, without a bundled one). The window
shows a preparing screen while the ownership probe waits for it; that probe
alone allows up to 15 minutes, while every later RPC keeps its 30-second
deadline. The same applies when the existing environment was created by another
interpreter, such as the Python uv downloaded before Desktop bundled one: uv
replaces that environment. The saved `uvPypiIndexUrl` mirror covers
package downloads through `UV_DEFAULT_INDEX`, `UV_INDEX_URL` and `PIP_INDEX_URL`.
The saved `uvPythonInstallMirror` sets `UV_PYTHON_INSTALL_MIRROR` for the Python
interpreter download (GitHub python-build-standalone when empty); it only
matters without a bundled or saved interpreter, and Settings hides it otherwise.
`UV_HTTP_TIMEOUT` defaults to 60 seconds.

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

`test:main` covers Desktop provisioning, account isolation, local disconnect,
local-versus-remote reconnect behavior, quit handling, API routing, and credential
redaction in logs. Renderer tests cover pairing, project resolution and ordering,
preferences, clipboard fallbacks, and terminal inventory/restore behavior. These
checks run headlessly without starting Electron or a development server.

## Packaging

The release build bundles the Connector source (`pyproject.toml`, `README.md` and
the `connector/` package only, like the DSH plugin; no `uv.lock`, tests or caches),
a platform-specific `uv`, and a platform-specific CPython. Dependencies are
installed on first run; Python is never downloaded.
The packaged app never runs `uv` inside its own bundle: it first mirrors the
bundled source to `userData/connector-source/<content-hash>/` (as the DSH plugin
does), so `uv.lock` is written there and the signed bundle stays untouched:

```bash
yarn dist:mac               # universal macOS DMG (Apple Silicon + Intel)
yarn dist:mac --universal   # one DMG for Apple Silicon and Intel
yarn dist:win               # Windows NSIS installer (x64)
yarn pack                   # unpacked Electron application
yarn dist                   # host-platform release (universal on macOS)
```

`dist`, `dist:mac` and `dist:win` read the signing environment, run the `uv` and
Python bundles and the app build with those secrets stripped, and hand them to electron-builder
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

Set `UV_BUNDLE_TARGETS=all` or a comma-separated target list for multi-platform
artifact preparation; `dist:mac --universal` prepares both macOS `uv` builds
automatically. Packaged builds keep the Connector virtual environment, uv cache,
config, binding, and logs under Electron `userData`; signed resources are never
modified at runtime. `bundle:uv` verifies the upstream archive checksum before
copying it into `build/uv`.

`bundle:python` places a python-build-standalone CPython (`install_only_stripped`,
version pinned in `scripts/prepare-python.mjs`) under `build/python/<platform>-<arch>/`,
verified against the release's `SHA256SUMS` and cached under `.cache/python`.
It removes what the Connector never loads (Tk/Tcl, IDLE, turtle demos, and the
interpreter's own pip) and ships CPython's license under `THIRD_PARTY_LICENSES`.
`PYTHON_BUNDLE_TARGETS` selects targets like `UV_BUNDLE_TARGETS`, and
`dist`/`dist:mac`/`dist:win` prepare the same targets as `uv`. macOS and Linux
interpreters contain symlinks, so prepare them on macOS or Linux.
`PYTHON_BUNDLE_VERSION` and `PYTHON_BUNDLE_RELEASE` select another build, and
`PYTHON_BUNDLE_MIRROR` downloads from a mirror with the same release layout, e.g.
`https://registry.npmmirror.com/-/binary/python-build-standalone`. The bundle
adds roughly 40 MB per architecture before installer compression; the universal
macOS app carries both architectures.

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

Set `updates.downloadUrl` in `config.json` to the fixed HTTPS installer address
before distribution. The `.invalid` URL is an explicit placeholder and does not
download an installer. Downloads stream into `<Electron userData>/updates/downloads`
with progress, remove incomplete files on failure/quit, and open the completed
installer with the OS. Installing the new app remains an installer operation.

## Shared local machine record

On every launch, including `yarn dev`, Main validates its actual installation
and publishes only the `desktop` field in
`<OS user home>/.agents-anywhere/connector-runtime.json`. Unchanged installation
metadata is not rewritten. Development records contain the Electron executable,
project path and launch arguments; packaged records contain the installed app
and executable paths. The DSH plugin reads this metadata without modifying it.

Python Connector alone maintains the ordered `connectorIds` history and runtime
ownership. Every accepted start, including CLI and reconnection, appends a missing
ID once. Desktop writes installation metadata under the same short file transaction
as Python, preserving IDs, runtime ownership and unknown fields. Hosts read legacy
records without migrating them; Python performs the migration on a successful write.
When the OS refuses the transaction's loopback port and nobody listens on it (for
example a Windows excluded port range), both writers log a warning and write
without the lease instead of failing startup; see the shared record contract.

Desktop and the DSH plugin match local IDs against the signed-in user's server
device list. First-login provisioning and pairing after a deleted device reuse the
first matching ID in local order and rotate its token. An empty intersection creates
a device; list or token-rotation failures stop provisioning for retry. Private
bindings and credentials are retained when Python rejects startup, so a retry does
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

Startup exclusion is implemented entirely in Python and includes CLI, Desktop and
DSH plugin Connectors. Main calls `connector.acquireOwnership` before provisioning;
Python records its actual PID and startup source, and verifies that any recorded
PID still identifies that Connector process. It never treats the Electron or uv
parent as the owner. RPC conflicts use `-32009 / connector_already_running`.
Desktop displays a retryable conflict and stops automatic restart attempts. The RPC
channel remains usable, and retry asks Python again. `connector.stop` stops the
backend connection; ownership remains while that Python process is alive. Explicit
Quit terminates it. The next start can replace records left by a crashed process.

Until the first probe answers, ownership is `checking`, which the renderer shows
as progress rather than as a failure. Any other failure opens a blocking dialog
that quotes the underlying error and offers to copy it or open the logs folder.
When the RPC process exits or times out before answering, the error includes its
last stderr lines, where uv and Python explain a failed launch; stderr is logged
in whole lines. Every failed acquisition, including a retry, is logged. If the
backend stops before the Connector is owned, the dialog quotes the backend's exit
code, last reported error and output. The backend owns the log, so Main appends
to it directly whenever no ready backend is running. A launch whose backend never
becomes ready shows a native error box with the log directory before quitting.

- Successful Desktop login reuses a matching local device or provisions a
  `connectorKind: "desktop"` device with the user-authenticated Connector API.
- Successful local connection, reconnection, CLI pairing and pair-code completion
  refresh the device list without opening an Agent quick-setup dialog.
- Electron Main persists the returned `connectorId` and `connectorToken`, then
  sends them to `anywhere-cli rpc` through `connector.saveConfig`.
- Closing the window on macOS keeps the app and Connector running in the
  background. Explicit Quit stops the runtime and terminates the full process
  tree.
- Open-at-login, silent launch, automatic Connector start, `uv` path, Python
  path, PyPI mirror, Python download mirror, and log retention are Desktop
  settings. Settings shows the resolved uv and Python, and hides the Python
  download mirror while a bundled or saved interpreter is in use.
- On first initialization without a saved mirror choice, Main checks the OS
  preferred languages and selects Aliyun PyPI and npmmirror Python builds for
  Chinese systems, or the official sources otherwise. It persists the choice before any `uv` provisioning process and
  applies it through `UV_DEFAULT_INDEX`, `UV_INDEX_URL`, and `PIP_INDEX_URL`,
  without a renderer prompt. Existing choices, including official PyPI, are
  preserved; factory reset reapplies the system default.
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
and Intel by default, bundling uv for both architectures. Explicit `--arm64` or
`--x64` builds remain available for diagnostics. Both commands use the same
signing and notarization credential checks.

Use `yarn dist:mac --skip-build` to retry packaging after a completed app build;
it requires existing compiled output and both uv bundles. Run a full build after
changing application source. Yarn installs both CPU variants of optional native
dependencies for universal packaging.

For an offline packaging retry, set `WORKBENCH_ELECTRON_DIST` to a directory
containing the matching Electron ZIPs for both macOS architectures.
