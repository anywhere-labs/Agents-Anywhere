# Desktop Workbench

Electron shell for the Agents Anywhere web workbench.

## Run

```bash
cd desktop-workbench
yarn install
yarn dev
```

`yarn dev` starts `../web-next` on the first available local port from `5184`, waits for it, then opens Electron.
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

- This package only embeds the existing web app for now.
- Connector lifecycle, native sidebar treatment, tray, packaging, and local runtime bridges are intentionally out of scope for this first shell.
- Production/static mode expects `../web-next/out`, or a custom `WORKBENCH_WEB_OUT_DIR`.
