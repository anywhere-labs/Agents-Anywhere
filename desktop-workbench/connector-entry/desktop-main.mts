// Desktop's Connector entry (bundled by `yarn bundle:connector` into dist/connector/desktop-main.js): connector-ts's
// desktop-host, plus the features Desktop ships the binaries for. Port preview needs frpc, which Desktop bundles
// (`yarn bundle:frpc`); without it every preview is refused with `preview_unavailable`.
import { readFileSync } from 'node:fs'

import { runDesktopHost } from '../../connector-ts/src/entry/desktop-host.js'
import { dataDir, defaultConfigPath } from '../../connector-ts/src/host/index.js'
import { previewHost } from '../../connector-ts/src/workspace/preview/index.js'

/** This device's id from the config Desktop handed over; empty before the device is created. */
function deviceId(): string {
  try {
    const config = JSON.parse(readFileSync(defaultConfigPath(), 'utf8')) as { connectorId?: unknown }
    return typeof config.connectorId === 'string' ? config.connectorId : ''
  } catch {
    return ''
  }
}

const proxy = process.env.AA_PREVIEW_PROXY?.trim()
const preview = previewHost({
  frpcPath: process.env.AA_FRPC_BINARY?.trim() || null,
  dataDir: dataDir(),
  deviceId,
  ...(proxy ? { proxyUrl: proxy } : {}),
  log: (level, message) => { if (level !== 'info') console.error(`[preview] ${message}`) },
})

try {
  await runDesktopHost(undefined, { compose: { commands: preview.commands, onLink: link => preview.onLink(link) } })
} finally {
  await preview.close()
}
// The parent port keeps a utility process alive after the host has stopped.
process.exit(0)
