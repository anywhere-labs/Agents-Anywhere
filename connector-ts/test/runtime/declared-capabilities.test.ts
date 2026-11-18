// The declared runtime capabilities (domain/runtimes) against what each shipped profile reports once its Agent has
// negotiated: every declared capability is one the live set also reports, so live values replace all of them.

import { describe, expect, it } from 'vitest'

import type { Capability } from '../../src/application/ports/index.js'
import { declaredRuntimeCapabilities } from '../../src/domain/runtimes/index.js'
import type { AgentInfo } from '../../src/runtime/acp/client.js'
import { WORKSPACE_PREPARATION_CAPABILITIES } from '../../src/runtime/acp/handle.js'
import type { AcpAgentDefinition } from '../../src/runtime/profiles/definition.js'
import { CLAUDE } from '../../src/runtime/profiles/claude/index.js'
import { CODEX } from '../../src/runtime/profiles/codex/index.js'
import { directCapabilities, dshPluginDialect } from '../../src/runtime/profiles/dsh/index.js'
import { OFFICIAL_ACP_AGENTS } from '../../src/runtime/profiles/generic/index.js'
import { HERMES } from '../../src/runtime/profiles/hermes/index.js'
import { PI } from '../../src/runtime/profiles/pi/index.js'

function info(agentCapabilities: Record<string, unknown>, meta: Record<string, unknown> = {}): AgentInfo {
  return { protocolVersion: 1, agentCapabilities, agentInfo: {}, authMethods: [], meta } as unknown as AgentInfo
}

/** An Agent that negotiates nothing optional, and one that negotiates everything. */
const NEGOTIATIONS: readonly AgentInfo[] = [
  info({}),
  info(
    { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, sessionCapabilities: { list: {}, fork: {}, resume: {} } },
    { steering: { supported: true }, dsh: { features: { steer: true, planning: true, questions: true, attachments: true, fileUploads: true, permissionPresets: true } } },
  ),
]

/** Plan mode a Pi session adds to the negotiated set (the Pi handle reports its sessions' capabilities). */
const PI_SESSION_PLANNING = ['session.planning', 'session.plan_document', 'session.plan_review']

/** The Pi handle prepares workspaces itself; the other profiles say so in their definition. */
const preparesWorkspaces = (definition: AcpAgentDefinition): boolean => definition.workspacePreparation === true || definition.runtime === 'pi'

function liveIds(definition: AcpAgentDefinition, negotiated: AgentInfo): Set<string> {
  const items: Capability[] = definition.dialect({ instanceId: definition.runtime, settings: {} }).capabilities(negotiated)
  const ids = new Set(items.map(item => item.id))
  if (preparesWorkspaces(definition)) for (const item of WORKSPACE_PREPARATION_CAPABILITIES) ids.add(item.id)
  if (definition.runtime === 'pi') for (const id of PI_SESSION_PLANNING) ids.add(id)
  return ids
}

describe('declared runtime capabilities of the shipped profiles', () => {
  const definitions: readonly AcpAgentDefinition[] = [CODEX, CLAUDE, PI, HERMES, ...OFFICIAL_ACP_AGENTS]

  for (const definition of definitions) {
    it(`${definition.runtime}: every declared capability is one its live set reports`, () => {
      const declared = declaredRuntimeCapabilities(definition.runtime).map(item => item.id)
      expect(declared).toContain('session.send_message')
      for (const negotiated of NEGOTIATIONS) {
        const live = liveIds(definition, negotiated)
        expect(declared.filter(id => !live.has(id))).toEqual([])
      }
    })
  }

  it('workspace preparation is declared exactly for the profiles that prepare workspaces', () => {
    for (const definition of definitions) {
      const declared = declaredRuntimeCapabilities(definition.runtime).some(item => item.id === 'runtime.workspace.prepare' && item.supported)
      expect(declared, definition.runtime).toBe(preparesWorkspaces(definition))
    }
  })

  it('dsh: every declared capability is one both routes report', () => {
    const declared = declaredRuntimeCapabilities('dsh').map(item => item.id)
    for (const negotiated of NEGOTIATIONS) {
      const direct = new Set(directCapabilities(negotiated).map(item => item.id))
      const plugin = new Set(dshPluginDialect().capabilities(negotiated).map(item => item.id))
      expect(declared.filter(id => !direct.has(id) || !plugin.has(id))).toEqual([])
    }
  })
})
