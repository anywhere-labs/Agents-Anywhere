# Desktop Workbench

Electron shell for the Agents Anywhere web workbench.

## Run

```bash
cd desktop-workbench
yarn install
yarn dev
```

`yarn dev` starts the bundled `renderer` Next app on the first available local port from `5184`, waits for it, then opens Electron.
By default, the embedded web app talks to `https://web.agents-anywhere.com`.
That production endpoint uses root API paths such as `/auth/login`, so the desktop shell defaults to an empty API namespace.

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

To use a different backend with root API paths:

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 yarn dev
```

For the local v2 backend, include the namespace:

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 WORKBENCH_API_NAMESPACE=/api/v2 yarn dev
```

## Notes

- This package embeds a copied Next renderer under `renderer`.
- The original repo-level `../web-next` app is not started or modified by the desktop dev script.
- Treat `../web-next` as the upstream source for shared renderer code. Sync source, messages, public assets, scripts, tests, and shared configuration into `renderer`, then reapply the small Desktop-owned integration layer.
- Desktop-owned behavior includes the Electron window and protocol bridge, renderer package identity and port, nested-workspace Next configuration, native title-bar spacing, window drag regions, the shell header, and Desktop sidebar behavior.
- Do not copy generated or installed content such as `.next`, `node_modules`, `.yarn`, or `out` from `../web-next`.
- Production/static mode expects `renderer/out`, or a custom `WORKBENCH_WEB_OUT_DIR`.
