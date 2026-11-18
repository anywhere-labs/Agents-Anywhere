import { describe, expect, it } from 'vitest'

import { declaredRuntimeCapabilities, withDeclaredCapabilities, type DeclaredCapability } from '../../src/domain/runtimes/index.js'

function byId(items: readonly DeclaredCapability[]): Map<string, DeclaredCapability> {
  return new Map(items.map(item => [item.id, item]))
}

const supported = (items: readonly DeclaredCapability[]): string[] => items.filter(item => item.supported).map(item => item.id)

describe('declaredRuntimeCapabilities', () => {
  it('Codex: sending, steering, plan mode, goals, attachments and both catalogs', () => {
    const codex = byId(declaredRuntimeCapabilities('codex'))
    expect(supported([...codex.values()])).toEqual(expect.arrayContaining([
      'session.send_message', 'session.interrupt', 'session.steer', 'session.commands', 'session.interaction.approval',
      'session.planning', 'session.plan_document', 'session.plan_review', 'runtime.attachment',
      'catalog.model', 'catalog.permission', 'session.list', 'session.history.native',
    ]))
    expect(codex.get('session.goal')?.supported).toBe(false)
    expect(codex.get('runtime.attachment')?.parameters).toEqual({ image: true })
    expect(codex.get('runtime.workspace.prepare')).toEqual({ id: 'runtime.workspace.prepare', supported: true, parameters: { workflowVersion: '1.2' } })
    expect(codex.get('session.planning')?.parameters).toEqual({ preparedCreation: true })
  })

  it('Claude: plan mode and attachments, no steering, goals left to the negotiation', () => {
    const claude = byId(declaredRuntimeCapabilities('claude'))
    expect(claude.get('session.steer')).toEqual({ id: 'session.steer', supported: false })
    expect(supported([...claude.values()])).toEqual(expect.arrayContaining([
      'session.send_message', 'session.planning', 'session.plan_review', 'runtime.attachment', 'catalog.model', 'catalog.permission',
    ]))
    expect(claude.has('session.goal')).toBe(false)
    expect(claude.get('runtime.workspace.prepare')).toEqual({ id: 'runtime.workspace.prepare', supported: true, parameters: { workflowVersion: '1.2' } })
    expect(claude.get('session.planning')?.parameters).toEqual({ preparedCreation: true })
  })

  it('Pi: plan mode from a prepared workspace and workspace preparation', () => {
    const pi = byId(declaredRuntimeCapabilities('pi'))
    expect(pi.get('session.planning')).toEqual({ id: 'session.planning', supported: true, parameters: { preparedCreation: true } })
    expect(pi.get('runtime.workspace.prepare')).toEqual({ id: 'runtime.workspace.prepare', supported: true, parameters: { workflowVersion: '1.2' } })
    expect(pi.get('runtime.session.async_create')?.supported).toBe(true)
    expect(pi.get('catalog.permission')?.supported).toBe(true)
  })

  it('Hermes: steering and workspace preparation', () => {
    const hermes = byId(declaredRuntimeCapabilities('hermes'))
    expect(hermes.get('session.steer')?.supported).toBe(true)
    expect(hermes.get('runtime.workspace.prepare')?.supported).toBe(true)
    expect(hermes.has('session.planning')).toBe(false)
  })

  it('DSH: what both routes have (model and effort pickers), nothing route-specific', () => {
    const dsh = byId(declaredRuntimeCapabilities('dsh'))
    expect(supported([...dsh.values()]).sort()).toEqual([
      'catalog.effort', 'catalog.model', 'session.configuration.read', 'session.configuration.update',
      'session.interaction.approval', 'session.interrupt', 'session.send_message',
    ])
  })

  it('official ACP Agents and unknown types: the ACP session basics, no steering, workspace preparation', () => {
    for (const type of ['opencode', 'antigravity', 'codebuddy', 'commandcode', 'mimo', 'minimax', 'future-agent']) {
      const items = byId(declaredRuntimeCapabilities(type))
      expect(items.get('session.send_message')?.supported, type).toBe(true)
      expect(items.get('session.steer')?.supported, type).toBe(false)
      expect(items.get('runtime.workspace.prepare')?.supported, type).toBe(true)
      expect(items.has('session.planning'), type).toBe(false)
    }
    // Inherited object keys are not runtime types.
    expect(declaredRuntimeCapabilities('constructor')).toEqual(declaredRuntimeCapabilities('opencode'))
  })

  it('declares every capability once per type', () => {
    for (const type of ['codex', 'claude', 'pi', 'hermes', 'dsh', 'opencode']) {
      const ids = declaredRuntimeCapabilities(type).map(item => item.id)
      expect(new Set(ids).size, type).toBe(ids.length)
    }
  })
})

describe('withDeclaredCapabilities', () => {
  const declared: DeclaredCapability[] = [
    { id: 'session.send_message', supported: true },
    { id: 'session.steer', supported: false },
    { id: 'runtime.attachment', supported: true },
  ]

  it('keeps the declared set when nothing is live yet', () => {
    expect(withDeclaredCapabilities(declared, [])).toEqual(declared)
  })

  it('lets live items win by id, keeps the declared rest, and appends live-only items', () => {
    const merged = withDeclaredCapabilities<DeclaredCapability & { available?: boolean }>(declared, [
      { id: 'session.steer', supported: true },
      { id: 'runtime.attachment', supported: false },
      { id: 'session.fork', supported: true, available: false },
    ])
    expect(merged).toEqual([
      { id: 'session.send_message', supported: true },
      { id: 'session.steer', supported: true },
      { id: 'runtime.attachment', supported: false },
      { id: 'session.fork', supported: true, available: false },
    ])
  })
})
