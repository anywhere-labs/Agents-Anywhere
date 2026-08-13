# Desktop Workbench

Electron shell for the Agents Anywhere web workbench.

## Run

```bash
cd desktop-workbench
yarn install
yarn dev
```

`yarn dev` starts `../web-next` on `127.0.0.1:5174`, waits for it, then opens Electron.

To point Electron at an already running web app:

```bash
cd desktop-workbench
WORKBENCH_WEB_URL=http://127.0.0.1:5174 yarn start
```

To run against a static export:

```bash
cd desktop-workbench
yarn build:web
yarn start
```

## Notes

- This package only embeds the existing web app for now.
- Connector lifecycle, native sidebar treatment, tray, packaging, and local runtime bridges are intentionally out of scope for this first shell.
- Production/static mode expects `../web-next/out`, or a custom `WORKBENCH_WEB_OUT_DIR`.

