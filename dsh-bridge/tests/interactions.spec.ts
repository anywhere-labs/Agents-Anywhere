import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import { describe, expect, it, vi } from 'vitest'
import { permissionSelectionId } from '../src/projection/identity.js'
import { InteractionManager } from '../src/runtime/interactions.js'
import { SessionController } from '../src/runtime/session-controller.js'
import type { InteractionNotice } from '../src/runtime/types.js'

const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => void
const noticeSchemaPath = fileURLToPath(new URL('../../contracts/dsh-bridge/1.0/schemas/notice.schema.json', import.meta.url))

type ApprovalHandler = (
  request: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

describe('current Host approval integration', () => {
  it('accepts only the first valid Bridge response and closes the notice', async () => {
    let handler: ApprovalHandler | undefined
    const ctx = {
      on: (_name: string, candidate: ApprovalHandler) => {
        handler = candidate
        return () => undefined
      },
    } as unknown as Context
    const emitted: InteractionNotice[] = []
    const controller = new SessionController(
      SessionId('external-1'),
      'platform-1',
      { provider: 'provider', model: 'model' } satisfies ModelSelection,
      permissionSelectionId('workspace-write'),
      () => undefined,
    )
    const manager = new InteractionManager(ctx, 4, () => controller, () => true, async notice => {
      emitted.push(notice)
    })
    manager.register()
    if (handler === undefined) throw new Error('approval handler was not registered')
    const decision = handler({
      agent: {} as Agent,
      toolName: 'shell',
      reason: 'write file',
    }, async () => 'unavailable')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    const notice = emitted[0]
    if (notice === undefined) throw new Error('approval notice was not emitted')
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false })
    addFormats(ajv)
    const validate = ajv.compile(JSON.parse(await readFile(noticeSchemaPath, 'utf8')) as AnySchema)
    expect(validate(notice), JSON.stringify(validate.errors)).toBe(true)
    const first = manager.respond('platform-1', notice.noticeId, 'allow_once')
    const second = manager.respond('platform-1', notice.noticeId, 'reject')
    await expect(first).resolves.toEqual({ ok: true, duplicate: false })
    await expect(second).rejects.toMatchObject({ data: { code: 'INTERACTION_ALREADY_CLOSED' } })
    await expect(decision).resolves.toBe('allowed-once')
    expect(emitted.at(-1)).toMatchObject({ status: 'closed', responseRequired: false })
    expect(validate(emitted.at(-1)), JSON.stringify(validate.errors)).toBe(true)
  })

  it('delegates without opening a notice when no Connector owns the Bridge', async () => {
    let handler: ApprovalHandler | undefined
    const ctx = {
      on: (_name: string, candidate: ApprovalHandler) => {
        handler = candidate
        return () => undefined
      },
    } as unknown as Context
    const manager = new InteractionManager(ctx, 4, () => undefined, () => false, async () => undefined)
    manager.register()
    if (handler === undefined) throw new Error('approval handler was not registered')
    const fallback = vi.fn(async (): Promise<ApprovalOutcome> => 'unavailable')
    await expect(handler({ agent: {} as Agent, toolName: 'shell' }, fallback)).resolves.toBe('unavailable')
    expect(fallback).toHaveBeenCalledOnce()
  })
})
