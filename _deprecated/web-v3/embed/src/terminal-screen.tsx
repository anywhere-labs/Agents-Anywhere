"use client"

// The terminal view: web-v3's xterm.js TerminalView over the bridge transport (lib/terminal/bridge-transport.ts),
// full screen, without its on-screen key row (native draws the glass extra-keys bar and sends `term.key`).
import { useEffect, useMemo, useRef } from "react"

import { TerminalView, type TerminalViewHandle } from "@/components/terminal/terminal-view"
import { createBridgeTerminalTransport } from "@/lib/terminal/bridge-transport"
import type { TerminalInfo } from "@/lib/types/v3"

import type { EmbedController, View } from "./controller"

type TerminalViewState = Extract<View, { kind: "terminal" }>

export function TerminalScreen({ controller, view }: { controller: EmbedController; view: TerminalViewState }) {
  const channel = controller.terminalChannel()
  const transport = useMemo(() => (channel ? createBridgeTerminalTransport(channel) : null), [channel])
  const info = useMemo<TerminalInfo>(
    () => ({
      id: view.terminal_id,
      cwd: "",
      shell: "",
      cols: view.cols,
      rows: view.rows,
      created_at: "",
      running: true,
      exit_code: null,
      exit_signal: null,
      exited_at: null,
      pid: null,
      mode: view.term_mode,
      owner: view.owner,
      controller: null,
      generation: 0,
      viewers: 0,
    }),
    // One TerminalInfo per `view.terminal` (nonce): the view's effect restarts only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.nonce]
  )
  const handle = useRef<TerminalViewHandle>(null)

  useEffect(
    () =>
      controller.onTermKey((action) => {
        const h = handle.current
        if (!h) return
        if (action.kind === "key") h.key(action.key, action.mods)
        else if (action.kind === "text") h.type(action.data)
        else if (action.kind === "toggle_ctrl") h.toggleCtrl()
      }),
    [controller]
  )

  if (!transport) return null
  return (
    <div
      className="flex h-dvh flex-col"
      style={{
        paddingTop: "calc(var(--aa-inset-top) + 0.5rem)",
        paddingBottom: "calc(var(--aa-inset-bottom) + 0.5rem)",
        paddingLeft: "calc(var(--aa-inset-left) + 0.5rem)",
        paddingRight: "calc(var(--aa-inset-right) + 0.5rem)",
      }}
    >
      <TerminalView
        key={view.nonce}
        info={info}
        transport={transport}
        initialMode={view.attach_mode}
        label={view.label}
        handle={handle}
        extraKeys={false}
        fill
        className="min-h-0 flex-1"
      />
    </div>
  )
}
