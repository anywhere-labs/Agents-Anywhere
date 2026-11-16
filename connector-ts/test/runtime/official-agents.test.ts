import { describe, expect, it } from 'vitest'

import { AcpRuntimeHandle, peerConnection, type AcpConnection } from '../../src/runtime/acp/handle.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { checkDefinition, instanceSchema } from '../../src/runtime/profiles/definition.js'
import { COMMAND_CODE_PERMISSION_MODE, OFFICIAL_ACP_AGENTS, commandCodeDialect, genericDialect, miniMaxDialect, officialAcpProviders } from '../../src/runtime/profiles/generic/index.js'
import { FakeAcpAgent, tick } from '../support/fake-acp-agent.js'

async function open(agent: FakeAcpAgent, dialect: AcpDialect, selections?: Record<string, string>) {
  const handle = new AcpRuntimeHandle({ type: dialect.runtime, instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect), nativeInventory: false })
  const session = await handle.open({ kind: 'new', spec: { cwd: '/w', ...(selections ? { selections } : {}) } }, { sessionId: 'aa_o1', replay: 'none' })
  void (async () => {
    for await (const _ of session.events) { /* drain */ }
  })()
  return { handle, session }
}

describe('official ACP Agent definitions', () => {
  it('keeps the v2 runtime names, launch arguments and configuration boundary', () => {
    expect(OFFICIAL_ACP_AGENTS.map(d => [d.runtime, d.executable.name, d.arguments.join(' ')])).toEqual([
      ['opencode', 'opencode', 'acp'],
      ['antigravity', 'agy', 'acp'],
      ['codebuddy', 'codebuddy', '--acp'],
      ['commandcode', 'cmdc', '--no-auto-update acp'],
      ['mimo', 'mimo', 'acp'],
      ['minimax', 'mcode', 'acp'],
    ])
    for (const definition of OFFICIAL_ACP_AGENTS) {
      expect(() => checkDefinition(definition)).not.toThrow()
      expect(Object.keys((instanceSchema(definition).schema.properties ?? {}) as object)).toEqual(['cliPath'])
      expect(definition.nativeInventory).toBe(false)
    }
    expect(OFFICIAL_ACP_AGENTS.filter(d => d.launchInWorkspace).map(d => d.runtime)).toEqual(['mimo'])
    expect(officialAcpProviders().map(p => p.type)).toEqual(OFFICIAL_ACP_AGENTS.map(d => d.runtime))
  })

  it('does not list native sessions even when the Agent can', async () => {
    const agent = new FakeAcpAgent()
    const { handle } = await open(agent, genericDialect('opencode'))
    expect(await handle.listNativeSessions()).toEqual({ sessions: [] })
    expect(agent.received.some(r => r.method === 'session/list')).toBe(false)
  })
})

describe('Command Code', () => {
  function commandCodeAgent(): FakeAcpAgent {
    const agent = new FakeAcpAgent()
    agent.configOptions = agent.configOptions.filter(o => o.category === 'model')
    agent.modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Ask' }, { id: 'acceptEdits', name: 'Accept edits' }, { id: 'yolo', name: 'Auto' }] }
    return agent
  }

  it('exposes session modes as its permission option and sets them with set_mode', async () => {
    const agent = commandCodeAgent()
    const { session } = await open(agent, commandCodeDialect(), { permission: 'acceptEdits' })
    const option = session.configOptions.find(o => o.id === COMMAND_CODE_PERMISSION_MODE)
    expect(option).toMatchObject({ category: 'permission', currentValue: 'acceptEdits' })
    expect(agent.received.filter(r => r.method === 'session/set_mode').map(r => r.params.modeId)).toEqual(['acceptEdits'])

    // Agent 自己切了模式
    agent.update('native-1', { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' })
    await tick()
    expect(session.configOptions.find(o => o.id === COMMAND_CODE_PERMISSION_MODE)?.currentValue).toBe('yolo')

    // 完整的 configOptions 更新里没有权限项：保留由 modes 得来的那一项
    agent.update('native-1', { sessionUpdate: 'config_option_update', configOptions: agent.configOptions })
    await tick()
    expect(session.configOptions.map(o => o.id)).toEqual(['model', COMMAND_CODE_PERMISSION_MODE])
  })

  it('leaves modes alone for generic Agents that already report configOptions', async () => {
    const { session } = await open(commandCodeAgent(), genericDialect('opencode'))
    expect(session.configOptions.map(o => o.id)).toEqual(['model'])
  })
})

describe('MiniMax', () => {
  it('files permissionMode under the permission category', async () => {
    const agent = new FakeAcpAgent()
    agent.configOptions = [...agent.configOptions, { id: 'permissionMode', name: 'Permissions', category: '_minimax_permission', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }] }]
    const { session } = await open(agent, miniMaxDialect(), { permission: 'auto' })
    expect(session.configOptions.find(o => o.id === 'permissionMode')).toMatchObject({ category: 'permission', currentValue: 'auto' })
  })
})

describe('MiMo: one process per workspace', () => {
  it('starts an Agent per working directory, inside that directory', async () => {
    const scopes: Array<string | undefined> = []
    const agents: FakeAcpAgent[] = []
    const dialect = genericDialect('mimo')
    const handle = new AcpRuntimeHandle({
      type: 'mimo', instanceId: 'i1', dialect, processPerWorkspace: true,
      connect: async (scope): Promise<AcpConnection> => {
        scopes.push(scope?.cwd)
        const agent = new FakeAcpAgent()
        agents.push(agent)
        return peerConnection(agent.clientPeer, dialect)()
      },
    })
    const a = await handle.open({ kind: 'new', spec: { cwd: '/tmp' } }, { sessionId: 's1', replay: 'none' })
    await handle.open({ kind: 'new', spec: { cwd: '/tmp' } }, { sessionId: 's2', replay: 'none' })
    await handle.open({ kind: 'new', spec: { cwd: '/' } }, { sessionId: 's3', replay: 'none' })
    expect(agents).toHaveLength(2)
    expect(scopes[1]).toBe('/')
    expect(a.nativeSessionId).toBe('native-1')
    await handle.stop()
  })
})
