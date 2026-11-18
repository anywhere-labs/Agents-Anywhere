// Desktop's Connector entry (bundled by `yarn bundle:connector` into dist/connector/desktop-main.js): connector-ts's
// desktop-host with port preview, whose frp client Desktop bundles (`yarn bundle:frpc`). Without it the device
// declares preview unavailable (`session.port_preview`) and refuses every preview with `preview_unavailable`.
import { runDesktopHost } from '../../connector-ts/src/entry/desktop-host.js'

const proxy = process.env.AA_PREVIEW_PROXY?.trim()

await runDesktopHost(undefined, {
  compose: {
    preview: {
      frpcPath: process.env.AA_FRPC_BINARY?.trim() || null,
      // A custom proxy from the Connector network setting; otherwise frpc follows the device link's egress.
      ...(proxy ? { proxyUrl: proxy } : {}),
      log: (level, message) => { if (level !== 'info') console.error(`[preview] ${message}`) },
    },
  },
})
// The parent port keeps a utility process alive after the host has stopped.
process.exit(0)
