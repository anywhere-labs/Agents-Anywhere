# Agents Anywhere Desktop

Electron desktop controller for the local Agents Anywhere connector.

The desktop app is intentionally separate from `web/`. It manages the local
connector process, tray behavior, and startup preferences; the web console
remains the primary session UI.

## Run

```bash
npm install
npm run dev
```

The app starts the connector from source with:

```bash
uv run --project <connector-dir> anywhere-cli start --config <user-config>
```

In development, `<connector-dir>` resolves to `../connector`.

## Package

```bash
npm run pack
```

Packaged builds include:

- `../connector` as `resources/connector`, including `pyproject.toml`
- `../logo` as `resources/logo`

The installed app still requires `uv` to be available on `PATH` unless the user
sets a custom uv command in the desktop settings.
