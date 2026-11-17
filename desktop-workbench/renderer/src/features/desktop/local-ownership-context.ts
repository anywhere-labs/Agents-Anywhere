"use client"

import { createContext, useContext } from "react"
import type { LocalExternalConnector, LocalOwnershipState } from "./bridge"

/** The ownership `LocalOwnershipGate` let through: `owned` or `external`. */
export const LocalOwnershipContext = createContext<LocalOwnershipState | null>(null)

/**
 * The newer Connector (CLI or DSH plugin) that serves this computer instead of
 * Desktop's own, or `null` when Desktop's own does (or outside Desktop). While
 * it is set, everything that goes through the Server works; only local
 * Connector actions are unavailable, and Desktop takes the machine back on its
 * own once that Connector exits.
 */
export function useExternalConnector(): LocalExternalConnector | null {
  const state = useContext(LocalOwnershipContext)
  if (state?.status !== "external") return null
  return state.external ?? { kind: "", handedOver: false }
}

/** The select key the external notices use for the owner's host. */
export function externalConnectorSource(external: LocalExternalConnector): "cli" | "dshPlugin" | "desktop" | "other" {
  if (external.kind === "cli") return "cli"
  if (external.kind === "dsh-plugin") return "dshPlugin"
  if (external.kind === "desktop-workbench") return "desktop"
  return "other"
}

/** Values for the `externalSummary` / `externalShort` messages. */
export function externalConnectorMessageValues(external: LocalExternalConnector) {
  return {
    source: externalConnectorSource(external),
    hasVersion: external.version ? "yes" : "no",
    version: external.version ?? "",
  }
}
