import type { DesktopLocalBinding } from "./bridge"

type PairedConnector = { id: string; name: string }

export class DesktopAgentSetup {
  private pending: PairedConnector | null = null
  private lastPromptedId: string | null = null

  trackBinding(previousConnectorId: string | null | undefined, binding: DesktopLocalBinding): void {
    if (binding.connectorId === previousConnectorId || binding.connectorId === this.lastPromptedId) return
    this.pending = {
      id: binding.connectorId,
      name: binding.name?.trim() || binding.connectorId,
    }
  }

  takeOnline(connectorId: string): PairedConnector | null {
    if (this.pending?.id !== connectorId) return null
    const paired = this.pending
    this.pending = null
    this.lastPromptedId = paired.id
    return paired
  }
}
