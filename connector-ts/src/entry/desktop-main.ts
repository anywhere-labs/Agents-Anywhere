// Desktop utility-process entry: `utilityProcess.fork('<bundle>/desktop-main.js')` in Desktop's main process.
import { runDesktopHost } from './desktop-host.js'

await runDesktopHost()
