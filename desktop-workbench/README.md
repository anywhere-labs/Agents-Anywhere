# Desktop Workbench

Agents Anywhere Desktop combines the web workbench and a locally managed
Connector in one Electron application. The renderer remains the control
console; Electron Main owns the Connector CLI process and communicates with it
over stdio JSON-RPC. No localhost management server is opened.

```text
Renderer -> narrow preload IPC -> Electron Main -> anywhere-cli rpc -> Server
```

## Run

From the repository root, the local Desktop launcher starts Docker-backed
PostgreSQL and Redis, the Server on fixed port `8000`, and Desktop on fixed
port `5184`. It releases existing listeners on those two application ports and
always points Desktop at the local Server:

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

To use a different backend with the default `/api/v2` namespace:

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 yarn dev
```

To use a backend with root API paths, explicitly provide an empty namespace:

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 WORKBENCH_API_NAMESPACE= yarn dev
```

The development shell resolves `uv` from the login-shell environment and runs
the repo-level `../connector` project. Override either location when needed:

```bash
WORKBENCH_CONNECTOR_DIR=/absolute/path/to/connector yarn dev
WORKBENCH_CONNECTOR_CLI=/absolute/path/to/anywhere-cli yarn dev
```

Do not start a second Connector with the same Desktop config while the app is
running. Standalone CLI devices remain supported and should use their own
config.

## Checks

```bash
yarn build:main
yarn typecheck
yarn test:main
yarn renderer:typecheck
```

`test:main` covers Desktop provisioning, account isolation, local disconnect,
local-versus-remote reconnect behavior, credential redaction, product-version
compatibility, update decisions, platform-specific installers, and download
safety.

### Update-flow testing

The Desktop update service checks backend health during startup, then schedules
the ordinary release check for 60 seconds after the Electron process started.
Only development builds accept these test overrides:

```bash
desktop_update_test_dir="$(mktemp -d)"
WORKBENCH_PRODUCT_VERSION_OVERRIDE=0.1.7.1 \
WORKBENCH_VERSION_CODE_OVERRIDE=5 \
WORKBENCH_UPDATE_DELAY_MS=0 \
WORKBENCH_UPDATE_STATE_PATH="$desktop_update_test_dir/state.json" \
WORKBENCH_UPDATE_DOWNLOAD_DIR="$desktop_update_test_dir/downloads" \
yarn dev
```

State and download overrides must be strict descendants of Electron's `temp`
or `userData` directories; packaged builds ignore all five variables. This
keeps forced-update and defer-flow testing separate from real user choices.

macOS checks the `desktop-macos` release target and Windows checks
`desktop-windows`; a missing target (`503`) falls back to the legacy `desktop`
target. Publish a `.dmg` or `.exe` for the matching platform before raising the
backend version, otherwise an older forced client can only keep retrying the
release check. HTTPS installers may use a separate download host. An HTTP
installer is accepted only in an unpackaged development build and must use the
same hostname as an HTTP API origin (the port may differ), including after
redirects. Packaged builds require HTTPS installer URLs.

## Packaging

The release build bundles the Connector source and a platform-specific `uv`:

```bash
yarn bundle:uv       # current platform by default
yarn pack            # unpacked Electron application
yarn dist            # installer / DMG / AppImage
```

Set `UV_BUNDLE_TARGETS=all` or a comma-separated target list for multi-platform
artifact preparation. Packaged builds keep the Connector virtual environment,
uv cache, config, binding, and logs under Electron `userData`; signed resources
are never modified at runtime.

The build expects signing/notarization credentials to be supplied by release
CI. `bundle:uv` verifies the upstream archive checksum before copying it into
`build/uv`.

## Connector lifecycle

- Successful Desktop login provisions a `connectorKind: "desktop"` device with
  the existing user-authenticated Connector API.
- Electron Main persists the returned `connectorId` and `connectorToken`, then
  sends them to `anywhere-cli rpc` through `connector.saveConfig`.
- Closing the window on macOS keeps the app and Connector running in the
  background. Explicit Quit stops the runtime and terminates the full process
  tree.
- Open-at-login, silent launch, automatic Connector start, `uv` path, PyPI
  mirror, and log retention are Desktop settings.
- An authentication failure is surfaced to the renderer and is not retried
  automatically. Reconnection must be confirmed on that physical Desktop.
- Factory reset revokes the current Desktop credential on the Server first. A
  failed revoke does not silently erase the only local binding. After an
  explicit second confirmation, `forceLocal: true` permits an offline local
  reset without a login session; it also clears Electron web storage and cache.

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
