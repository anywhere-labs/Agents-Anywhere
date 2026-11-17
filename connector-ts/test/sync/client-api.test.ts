// The business rules the device took over from the Server's client routes, one by one.
import { describe, expect, it } from 'vitest'

import { SessionCommandCatalog, commandText, commandViews, slashResult, unknownCommandResult } from '../../src/sync/client-api/commands.js'
import { listingPath, looksLikeWindowsPath, resolveWorkspacePath } from '../../src/sync/client-api/paths.js'
import { capabilityUsable, findCapability, mergeInteractionInput, noticeAnswerInput, parsePlanCommand, sessionSourceError, unsupportedMediaType } from '../../src/sync/client-api/rules.js'
import {
  TerminalRoots,
  capabilityView,
  goalView,
  modelCatalogView,
  noticeView,
  permissionCatalogView,
  planningView,
  runtimeStateView,
  terminalLabel,
  terminalV1View,
  terminalV2View,
} from '../../src/sync/client-api/views.js'
import type { Session } from '../../src/domain/conversation/index.js'

const NOW = '2026-11-17T00:00:00.000Z'

describe('workspace paths (resolve_workspace_path)', () => {
  it('resolves POSIX paths against the root and keeps absolute and home paths', () => {
    expect(resolveWorkspacePath('/repo', 'notes/a.txt')).toBe('/repo/notes/a.txt')
    expect(resolveWorkspacePath('/repo/', './notes/../b.txt')).toBe('/repo/b.txt')
    expect(resolveWorkspacePath('/repo/notes', '..')).toBe('/repo')
    expect(resolveWorkspacePath('/repo', '/etc/hosts')).toBe('/etc/hosts')
    expect(resolveWorkspacePath('/repo', '~/x')).toBe('~/x')
    // Empty and blank paths are the root itself.
    expect(resolveWorkspacePath('/repo', '')).toBe('/repo')
    expect(resolveWorkspacePath('/repo', '  ')).toBe('/repo')
  })

  it('resolves Windows paths with the root drive whatever platform runs it', () => {
    expect(looksLikeWindowsPath('C:\\repo')).toBe(true)
    expect(looksLikeWindowsPath('/repo')).toBe(false)
    expect(resolveWorkspacePath('C:\\repo', 'src\\a.ts')).toBe('C:\\repo\\src\\a.ts')
    expect(resolveWorkspacePath('C:\\repo', 'src/../b.ts')).toBe('C:\\repo\\b.ts')
    expect(resolveWorkspacePath('C:\\repo', 'D:\\other\\x')).toBe('D:\\other\\x')
    expect(resolveWorkspacePath('C:\\repo', '\\top')).toBe('C:\\top')
    // Like the Server: `/C:/...` loses its slash but keeps POSIX separators.
    expect(resolveWorkspacePath('/C:/repo', 'a')).toBe('C:/repo/a')
    expect(resolveWorkspacePath('C:\\repo', '')).toBe('C:\\repo')
  })

  it('keeps an empty listing path on Windows (the drive list) and resolves it elsewhere', () => {
    expect(listingPath('win32', 'C:\\repo', '')).toBe('')
    expect(listingPath('linux', '/repo', '')).toBe('/repo')
    expect(listingPath('win32', 'C:\\repo', 'src')).toBe('C:\\repo\\src')
  })

  it('needs a root', () => {
    expect(() => resolveWorkspacePath('', 'a')).toThrow(/root is required/u)
  })
})

describe('slash commands (command_views, command_text)', () => {
  const catalog = [{ name: 'review', description: 'Review the working tree', inputHint: 'path' }, { name: 'compact', description: 'Compact the context' }]

  it('lists the catalog as RuntimeCommandView items, filtered by query and cut at limit', () => {
    expect(commandViews(catalog)).toEqual([
      { id: 'review', title: 'review', description: 'Review the working tree', aliases: [], category: null, scope: 'session', enabled: true, disabledReason: null, acceptsArgs: true, argsSchema: { type: 'string', description: 'path' }, metadata: { ui: { kind: 'execute', acceptsMultiline: true, allowedStatuses: ['idle'] } } },
      { id: 'compact', title: 'compact', description: 'Compact the context', aliases: [], category: null, scope: 'session', enabled: true, disabledReason: null, acceptsArgs: true, argsSchema: { type: 'string' }, metadata: { ui: { kind: 'execute', acceptsMultiline: true, allowedStatuses: ['idle'] } } },
    ])
    expect(commandViews(catalog, 'REV').map(view => view.id)).toEqual(['review'])
    expect(commandViews(catalog, 'context').map(view => view.id)).toEqual(['compact'])
    expect(commandViews(catalog, null, 1)).toHaveLength(1)
    expect(commandViews(catalog, null, 0)).toEqual([])
  })

  it('builds the message from the arguments, or from the raw text when it names the same command', () => {
    expect(commandText('review', ['src', 'lib'], null)).toBe('/review src lib')
    expect(commandText('review', [], null)).toBe('/review')
    expect(commandText('review', ['ignored'], '  /Review "a b"\nnext line')).toBe('/review "a b"\nnext line')
    expect(commandText('review', [], '/compact')).toBeNull()
    expect(commandText('review', [], 'no slash')).toBeNull()
  })

  it('answers SessionCommandResponse bodies', () => {
    expect(slashResult('review', true, null, null, { executionState: 'accepted' })).toEqual({ command: 'review', ok: true, code: null, message: null, result: { executionState: 'accepted' }, session: null })
    expect(unknownCommandResult('review')).toMatchObject({ ok: false, code: 'command_outcome_unknown', result: { executionState: 'unknown', retryable: false } })
  })

  it('keeps the latest catalog per session from commands.updated', () => {
    const commands = new SessionCommandCatalog(2)
    commands.observe('runtime.status', { runtimeId: 'rti_1', sessionId: 's1', status: { event: 'commands.updated', commands: [{ name: 'a' }, { name: '' }, 'x' as never] } })
    commands.observe('runtime.status', { runtimeId: 'rti_1', sessionId: 's2', status: { event: 'commands.updated', commands: [{ name: 'b', description: 'B' }] } })
    commands.observe('runtime.status', { runtimeId: 'rti_1', sessionId: 's1', status: { event: 'config.updated' } })
    expect(commands.get('s1')).toEqual([{ name: 'a' }])
    expect(commands.get('s2')).toEqual([{ name: 'b', description: 'B' }])
    commands.observe('runtime.status', { runtimeId: 'rti_1', sessionId: 's3', status: { event: 'commands.updated', commands: [] } })
    expect(commands.get('s1')).toEqual([])
  })
})

describe('notice answers (interaction_input_with_runtime_notice_context)', () => {
  it('lays the user input over the notice context and merges approvalSource', () => {
    expect(mergeInteractionInput({ a: 1, approvalSource: { kind: 'tool', id: 't1' } }, { b: 2, approvalSource: { id: 't2' } })).toEqual({ a: 1, b: 2, approvalSource: { kind: 'tool', id: 't2' } })
    expect(mergeInteractionInput({ approvalSource: 'x' }, { approvalSource: { id: 1 } })).toEqual({ approvalSource: { id: 1 } })
  })

  it('answers an approval with the action alone unless the user typed input; a form always with the merged input', () => {
    const approval = { interactionType: 'approval', context: { approvalSource: { id: 'a' } } }
    expect(noticeAnswerInput(approval, null)).toBeNull()
    expect(noticeAnswerInput(approval, { note: 'ok' })).toEqual({ approvalSource: { id: 'a' }, note: 'ok' })
    expect(noticeAnswerInput({ interactionType: 'input_request', context: { path: '/x' } }, null)).toEqual({ path: '/x' })
    expect(noticeAnswerInput(null, null)).toEqual({})
  })
})

describe('session rules', () => {
  const session = (archived: boolean, sourceAvailability: Session['sourceAvailability']) => ({ archived, sourceAvailability })

  it('refuses messages to archived sessions with the source error code', () => {
    expect(sessionSourceError(session(false, 'available'))).toBeNull()
    expect(sessionSourceError(session(true, 'available'))).toEqual({ code: 'session_archived', message: 'session is archived in Agents Anywhere' })
    expect(sessionSourceError(session(true, 'deleted'))).toEqual({ code: 'session_deleted', message: 'session is deleted in the local runtime' })
    expect(sessionSourceError(session(true, 'missing'))).toEqual({ code: 'session_missing', message: 'session is missing in the local runtime' })
  })

  it('uses a capability only when supported, available, allowed and taken over', () => {
    const set = { capabilities: [{ capabilityId: 'session.steer', supported: true }, { capabilityId: 'session.commands', supported: true, available: false }, { capabilityId: 'x', supported: true, allowed: false }] }
    expect(capabilityUsable(findCapability(set, 'session.steer'), true)).toBe(true)
    expect(capabilityUsable(findCapability(set, 'session.steer'), false)).toBe(false)
    expect(capabilityUsable(findCapability(set, 'session.commands'), true)).toBe(false)
    expect(capabilityUsable(findCapability(set, 'x'), true)).toBe(false)
    expect(capabilityUsable(findCapability(set, 'missing'), true)).toBe(false)
    expect(capabilityUsable(findCapability(null, 'session.steer'), true)).toBe(false)
  })

  it('checks attachment types against allowedMimeTypes when the capability sets it', () => {
    expect(unsupportedMediaType({ capabilityId: 'runtime.attachment' }, ['image/png'])).toBeNull()
    const images = { capabilityId: 'runtime.attachment', metadata: { allowedMimeTypes: ['image/png', ' IMAGE/JPEG ', 'bogus'] } }
    expect(unsupportedMediaType(images, ['image/png; charset=x', 'Image/Jpeg'])).toBeNull()
    expect(unsupportedMediaType(images, ['image/png', 'application/pdf'])).toBe('application/pdf')
    expect(unsupportedMediaType({ capabilityId: 'runtime.attachment', parameters: { allowedMimeTypes: 'nope' } }, ['image/png'])).toBe('image/png')
  })

  it('parses /plan commands', () => {
    expect(parsePlanCommand('/plan')).toEqual({ command: 'enter_plan' })
    expect(parsePlanCommand('  /plan off ')).toEqual({ command: 'exit_plan' })
    expect(parsePlanCommand('/plan fix the bug')).toEqual({ command: 'submit_task', content: 'fix the bug' })
    expect(parsePlanCommand('/plan\r\nline two')).toEqual({ command: 'submit_task', content: 'line two' })
    expect(parsePlanCommand('/planner')).toBeNull()
    expect(parsePlanCommand('plan')).toBeNull()
  })
})

describe('client views', () => {
  const session = { sessionId: 's1', runtimeType: 'opencode', runtimeId: 'rt_1', externalSessionId: 'ext', takeover: true, clock: { headSeq: 7 } } as unknown as Session

  it('fills SessionRuntimeState, reading unknown statuses as idle and defaulting to the requested selections', () => {
    expect(runtimeStateView({ status: 'unknown', metadata: { activeTurnId: null } }, session, NOW, { model: 'm2' })).toEqual({
      sessionId: 's1', runtime: 'opencode', runtimeId: 'rt_1', runtimeType: 'opencode', externalSessionId: 'ext', status: 'idle', selections: { model: 'm2' },
      statusReason: null, error: null, metadata: { activeTurnId: null }, updatedSeq: 7, createdAt: NOW, updatedAt: NOW,
    })
    expect(runtimeStateView({ status: 'running', selections: { model: 'm1' } }, session, NOW, { model: 'm2' })).toMatchObject({ status: 'running', selections: { model: 'm1' } })
  })

  it('fills ProtocolCapability, allowing actions only on a taken-over session', () => {
    expect(capabilityView({ capabilityId: 'session.steer', supported: false, runtime: 'opencode', scope: 'session', sessionId: 's1' }, session)).toEqual({
      capabilityId: 'session.steer', version: '1', scope: 'session', runtime: 'opencode', runtimeId: 'rt_1', sessionId: 's1', supported: false, available: false, allowed: true,
      unavailableReason: 'runtime_capability_unsupported', parameters: {}, metadata: {},
    })
    const readOnly = { ...session, takeover: false } as Session
    expect(capabilityView({ capabilityId: 'session.send_message', supported: true }, readOnly).allowed).toBe(false)
    expect(capabilityView({ capabilityId: 'session.configuration.read', supported: true }, readOnly).allowed).toBe(true)
  })

  it('fills NoticeIn with its defaults and drops unknown keys', () => {
    const notice = noticeView({ noticeId: 'n1', sessionId: 's1', type: 'interaction', title: 'Run ls?', interactionType: 'approval', actions: [{ actionId: 'allow', label: 'Allow', style: 'primary' }], blocking: { scope: 'session', targetId: 's1' }, extra: 1 })
    expect(notice).toEqual({
      noticeId: 'n1', type: 'interaction', sessionId: 's1', source: { runtime: null, component: null, approvalId: null, timelineItemId: null, operationId: null }, title: 'Run ls?', message: null,
      severity: 'info', status: 'open', interactionType: 'approval', blocking: { scope: 'session', targetId: 's1' }, responseRequired: false,
      actions: [{ actionId: 'allow', label: 'Allow', style: 'primary', input: { required: false, schema: null, uiSchema: null } }], context: {}, metadata: {}, expiresAt: null, revision: 1, createdAt: null, resolvedAt: null,
    })
  })

  it('fills model and permission catalogs, empty when the Runtime has none', () => {
    expect(modelCatalogView(undefined, 'opencode')).toEqual({ runtime: 'opencode', revision: 1, models: [] })
    expect(modelCatalogView({ runtime: 'opencode', revision: 2, models: [{ id: 'm1', reasoningItems: [{ id: 'high' }] }] }, 'x')).toEqual({
      runtime: 'opencode', revision: 2,
      models: [{ id: 'm1', displayName: 'm1', selectionId: null, description: null, default: false, group: null, metadata: {}, reasoningItems: [{ id: 'high', displayName: 'high', fullModelId: null, selectionId: 'high', description: null, default: false, metadata: {} }] }],
    })
    expect(permissionCatalogView({ permissions: [{ id: 'ask' }] }, 'opencode')).toEqual({ runtime: 'opencode', revision: 1, permissions: [{ id: 'ask', displayName: 'ask', selectionId: 'ask', description: null, default: false, metadata: {} }] })
  })

  it('fills PlanningState and GoalState with every field and nothing else', () => {
    expect(planningView(null)).toBeNull()
    expect(planningView({ sessionId: 's1', runtime: 'opencode', capabilities: { supported: true, actions: ['enter_plan'] }, extra: 1 })).toEqual({
      sessionId: 's1', runtime: 'opencode', runtimeId: null, effectiveMode: 'unknown', requestedMode: null, freshness: 'unknown', revision: 0, epoch: '', draft: null, proposal: null, proposals: [],
      review: null, capabilities: { supported: true, actions: ['enter_plan'], contentStreaming: 'final_only', reason: null }, operation: null, execution: null, executionProgress: null,
    })
    expect(goalView({ sessionId: 's1', runtime: 'opencode', capabilities: { supported: false, actions: [] } })).toMatchObject({ capabilities: { supported: false, actions: [], reason: null }, sourceEpoch: '', goal: null })
  })

  it('names terminals like the Server: the label, else the shell, numbered after the first', () => {
    expect(terminalLabel(' build ', '/bin/zsh', 3)).toBe('build')
    expect(terminalLabel(null, '/bin/zsh', 0)).toBe('zsh')
    expect(terminalLabel(null, 'C:\\Windows\\pwsh.exe', 1)).toBe('pwsh.exe 2')
    expect(terminalLabel(null, null, 2)).toBe('Shell 3')
  })

  it('fills terminals-v2 views with the root they were opened under, and v1 views with exactly their fields', () => {
    const raw = { terminalId: 't1', sessionId: 'browse_d', cwd: '/repo/src', closed: true, shell: '/bin/sh' }
    expect(terminalV2View(raw, { sessionId: 'browse_d', root: '/repo' }, NOW)).toMatchObject({ root: '/repo', cwd: '/repo/src', status: 'exited', label: 'Shell', persistent: false, createdAt: NOW, shell: '/bin/sh' })
    expect(terminalV2View({ cwd: '/x' }, { sessionId: 'browse_d', terminalId: 't2' }, NOW)).toMatchObject({ terminalId: 't2', root: '/x', cwd: '/x' })
    expect(Object.keys(terminalV1View(raw, { sessionId: 'browse_d', root: '/repo' }, NOW)).sort()).toEqual(['cols', 'createdAt', 'cwd', 'ephemeralGroupId', 'exitCode', 'label', 'persistent', 'pid', 'purpose', 'root', 'rows', 'scrollbackBytes', 'scrollbackSeq', 'sessionId', 'status', 'terminalId'])
    const roots = new TerminalRoots()
    roots.remember('t1', 'browse_d', '/repo', '/repo')
    roots.remember('t2', 'other', '/repo', '/repo')
    roots.prune('browse_d', new Set())
    expect(roots.get('t1')).toBeNull()
    expect(roots.get('t2')).not.toBeNull()
  })
})
