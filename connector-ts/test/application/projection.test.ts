import { describe, expect, it } from 'vitest'

import { TimelineProjector } from '../../src/application/projection.js'

const projector = () => new TimelineProjector('pi', 'native_1', null, () => '2026-11-17T00:00:00.000Z')
const photo = { fileId: 'file_1', name: 'photo.png', mediaType: 'image/png', size: 3, sha256: 'sha256:abc' }

describe('finished messages on the Timeline', () => {
  it('keeps the Runtime verdict: a model error is failed, an interruption cancelled, both completed', () => {
    const p = projector()
    p.apply({ type: 'message.delta', itemId: 'm1', role: 'assistant', text: 'partial' })
    const failed = p.apply({ type: 'message.completed', itemId: 'm1', role: 'assistant', text: 'partial', status: 'failed' })
    expect(failed).toMatchObject({ status: 'failed', completedAt: '2026-11-17T00:00:00.000Z', content: { text: 'partial' } })
    expect(p.apply({ type: 'message.completed', itemId: 'm2', role: 'assistant', text: '', status: 'cancelled' })).toMatchObject({ status: 'cancelled' })
    expect(p.apply({ type: 'message.completed', itemId: 'm3', role: 'assistant', text: 'ok' })).toMatchObject({ status: 'done' })
    expect(p.openItems()).toEqual([])
  })

  it('shows attachments in the v2 shape: Timeline-shaped first, else the platform identity, never a local path', () => {
    const p = projector()
    const fromHistory = p.apply({ type: 'message.completed', itemId: 'u1', role: 'user', text: 'see', timelineAttachments: [photo], attachments: [{ kind: 'file', path: '/tmp/x.png', mimeType: 'image/png' }] })
    expect(fromHistory.content.attachments).toEqual([photo])
    const echoed = p.apply({ type: 'message.completed', itemId: 'u2', role: 'user', text: 'see', attachments: [{ kind: 'file', path: '/tmp/cache/photo.png', mimeType: 'image/png', name: 'photo.png', info: photo }] })
    expect(echoed.content.attachments).toEqual([photo])
    const bare = p.apply({ type: 'message.completed', itemId: 'u3', role: 'user', text: 'see', attachments: [{ kind: 'inline', data: 'AAAA', mimeType: 'image/png', name: 'x.png' }] })
    expect(bare.content.attachments).toEqual([{ kind: 'inline', name: 'x.png', mimeType: 'image/png' }])
    // A later delta of the same item keeps them.
    expect(p.apply({ type: 'message.delta', itemId: 'u2', role: 'user', text: '!' }).content.attachments).toEqual([photo])
  })
})
