# Desktop Workbench

Agents Anywhere Desktop combines the web workbench and a locally managed
Connector in one Electron application. The renderer remains the control
console; Electron Main owns the Connector CLI process and communicates with it
over stdio JSON-RPC. No localhost management server is opened.

```text
Renderer -> narrow preload IPC -> Electron Main -> anywhere-cli rpc -> Server
```

## Run

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
local-versus-remote reconnect behavior, and credential redaction in logs.

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
- Closing the window keeps the app and Connector in the tray. Explicit Quit
  stops the runtime and terminates the full process tree.
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
