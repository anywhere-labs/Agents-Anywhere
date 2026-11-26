// Entry of the single-file render bundle (embed/dist/aa-render.html).
import "./index.css"

import { createRoot } from "react-dom/client"

import { App } from "./app"
import { Bridge, type BridgeHost } from "./bridge"
import { EmbedController } from "./controller"
import { CAPABILITIES } from "./protocol"

declare const __AA_EMBED_VERSION__: string

// window.aa.receive exists from the first script tick; native sends nothing before `ready` (doc §1).
const host = window as unknown as BridgeHost
const bridge = new Bridge({ host, version: __AA_EMBED_VERSION__, capabilities: CAPABILITIES }).install()
const controller = new EmbedController(bridge)
// Debugging aid (Safari Web Inspector / chrome://inspect): window.aa.controller.
Object.assign(host.aa ?? {}, { controller })

createRoot(document.getElementById("root")!).render(<App controller={controller} />)
bridge.ready()
