import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ROLES, checkLayers, classify } from '../../scripts/check-layers.mjs'

const root = mkdtempSync(join(tmpdir(), 'connector-ts-layers-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function fixture(files: Record<string, string>): string {
  const src = mkdtempSync(join(root, 'src-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true })
    writeFileSync(join(src, path), text)
  }
  return src
}

describe('check:layers', () => {
  it('accepts the real source tree', () => {
    expect(checkLayers(fileURLToPath(new URL('../../src', import.meta.url)))).toEqual([])
  })

  it('accepts allowed directions', () => {
    const src = fixture({
      'domain/identity/a.ts': "import { createHash } from 'node:crypto'\nexport const a = createHash",
      'domain/conversation/c.ts': "import { a } from '../identity/a.js'\nexport const c = a",
      'application/ports/p.ts': "import type { c } from '../../domain/conversation/c.js'\nexport type P = typeof c",
      'application/send.ts': "import type { P } from './ports/p.js'\nexport type S = P",
      'application/inbound/server.ts': "import type { S } from '../send.js'\nexport type I = S",
      'runtime/r.ts': "import type { P } from '../application/ports/p.js'\nexport type R = P",
      'entry/cli.ts': "import '../runtime/r.js'\nimport '../store/s.js'",
      'store/s.ts': 'export {}',
      'generated/protocol/v1_2/a.ts': 'export interface A { a: string }',
      'generated/protocol/v1_2/index.ts': "export * as a from './a.js'",
      'domain/conversation/g.ts': "import type { a } from '../../generated/protocol/v1_2/index.js'\nexport type G = a.A",
      'application/ports/g.ts': "import type { a } from '../../generated/protocol/v1_2/index.js'\nexport type G = a.A",
    })
    expect(checkLayers(src)).toEqual([])
  })

  it('reports every forbidden direction', () => {
    const src = fixture({
      'domain/conversation/c.ts': "import type { T } from '../trust/t.js'\nexport type C = T",
      'domain/trust/t.ts': "import { readFileSync } from 'node:fs'\nexport type T = typeof readFileSync",
      'domain/identity/i.ts': "export const load = () => import('../../store/s.js')",
      'domain/identity/p.ts': "export * from 'some-package'",
      'application/use.ts': "import '../runtime/r.js'",
      'application/ports/p.ts': "import type { X } from '../use.js'\nexport type P = X",
      'application/core.ts': "import '../application/inbound/x.js'",
      'application/inbound/x.ts': 'export {}',
      'runtime/r.ts': "import '../store/s.js'",
      'store/s.ts': "import '../entry/cli.js'",
      'entry/cli.ts': 'export {}',
      'generated/protocol/v1_2/bad.ts': "import type { C } from '../../../domain/conversation/c.js'\nexport type B = C",
    })
    const violations = checkLayers(src)
    const expected = [
      'domain/conversation/c.ts -> ../trust/t.js: domain/conversation must not import domain/trust',
      'domain/trust/t.ts -> node:fs: domain must stay free of I/O',
      'domain/identity/i.ts -> ../../store/s.js: domain must not import other layers',
      'domain/identity/p.ts -> some-package: domain must not depend on packages',
      'application/use.ts -> ../runtime/r.js: application may depend only on domain and application/ports',
      'application/ports/p.ts -> ../use.js: application/ports may depend only on domain and application/ports',
      'application/core.ts -> ../application/inbound/x.js: application use cases must not import application/inbound',
      'runtime/r.ts -> ../store/s.js: runtime must not import store directly; go through application/ports',
      'store/s.ts -> ../entry/cli.js: only entry/ is the composition root; nothing imports it',
      'generated/protocol/v1_2/bad.ts -> ../../../domain/conversation/c.js: generated contract types must not import other layers',
    ]
    expect([...violations].sort()).toEqual([...expected].sort())
  })

  it('gives every top-level directory of the real source tree a role', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url))
    const known = new Set(['domain', 'application', 'generated', 'entry', ...Object.keys(ROLES)])
    for (const name of readdirSync(src)) expect(known.has(name), `src/${name}`).toBe(true)
    expect(classify('channel/noise/state.ts').layer).toBe('channel/noise')
    expect(classify('channel/hub.ts').layer).toBe('channel')
  })

  it('accepts the adapter directions', () => {
    const src = fixture({
      'application/ports/p.ts': 'export type P = 1',
      'application/inbound/i.ts': 'export type I = 1',
      'domain/trust/t.ts': 'export type T = 1',
      'mesh/m.ts': "import { z } from 'meshcall'\nexport const m = z",
      'channel/noise/n.ts': "import { createHash } from 'node:crypto'\nexport const n = createHash",
      'sync/s.ts': "import type { P } from '../application/ports/p.js'\nimport type { I } from '../application/inbound/i.js'\nexport type S = P | I",
      'link/l.ts': "import '../sync/s.js'\nimport '../mesh/m.js'\nimport '../application/inbound/i.js'\nimport '../domain/trust/t.js'",
      'channel/c.ts': "import '../channel/noise/n.js'\nimport '../application/inbound/i.js'\nimport '../sync/s.js'",
      'keystore/k.ts': "import '../channel/noise/n.js'\nimport '../application/ports/p.js'",
      'host/h.ts': "import '../mesh/m.js'",
      'workspace/w.ts': "import type { P } from '../application/ports/p.js'\nexport type W = P",
      'entry/e.ts': "import '../link/l.js'\nimport '../channel/c.js'\nimport '../keystore/k.js'\nimport '../application/session/kernel.js'",
      'application/session/kernel.ts': "import '../errors.js'\nimport '../ports/p.js'",
      'application/errors.ts': 'export {}',
      'application/queue/q.ts': "import '../session/kernel.js'",
      'application/conversation/m.ts': "import '../queue/q.js'\nimport '../session/kernel.js'",
      'application/conversation-service.ts': "import './conversation/m.js'",
      'application/creation/c.ts': "import '../conversation-service.js'",
    })
    expect(checkLayers(src)).toEqual([])
  })

  it('reports adapter directions that bypass the ports', () => {
    const src = fixture({
      'application/use.ts': 'export {}',
      'application/inbound/i.ts': 'export {}',
      'application/session/kernel.ts': "import '../queue/q.js'\nimport '../conversation-service.js'",
      'application/queue/q.ts': "import '../planning/p.js'",
      'application/planning/p.ts': 'export {}',
      'application/conversation-service.ts': 'export {}',
      'sync/s.ts': "import '../application/use.js'\nimport '../link/l.js'\nimport '../mesh/m.js'",
      'link/l.ts': "import '../application/use.js'\nimport '../store/st.js'\nimport '../channel/c.js'",
      'channel/c.ts': 'export {}',
      'keystore/k.ts': "import '../channel/c.js'\nimport '../sync/s.js'\nimport '../application/inbound/i.js'",
      'workspace/w.ts': "import '../keystore/k.js'",
      'mesh/m.ts': "import '../application/ports/p.js'",
      'channel/noise/n.ts': "import '../c.js'",
      'store/st.ts': 'export {}',
      'tools/t.ts': "import '../store/st.js'",
      'host/h.ts': "import '../tools/t.js'",
    })
    const expected = [
      'application/session/kernel.ts -> ../queue/q.js: application/session must not import application/queue',
      'application/session/kernel.ts -> ../conversation-service.js: application/session must not import the facade conversation-service.ts',
      'application/queue/q.ts -> ../planning/p.js: application/queue must not import application/planning',
      'sync/s.ts -> ../application/use.js: sync reaches the use cases only through application/inbound and application/ports',
      'sync/s.ts -> ../link/l.js: sync must not import link',
      'sync/s.ts -> ../mesh/m.js: sync must not import mesh',
      'link/l.ts -> ../application/use.js: link reaches the use cases only through application/inbound and application/ports',
      'link/l.ts -> ../store/st.js: link must not import store; outbound adapters are reached through application/ports',
      'link/l.ts -> ../channel/c.js: link must not import channel directly',
      'keystore/k.ts -> ../channel/c.js: keystore is an outbound adapter and must not import the inbound side (channel)',
      'keystore/k.ts -> ../sync/s.js: keystore is an outbound adapter and must not import the inbound side (sync)',
      'keystore/k.ts -> ../application/inbound/i.js: keystore implements application/ports and must not import application/inbound',
      'workspace/w.ts -> ../keystore/k.js: workspace must not import keystore directly; go through application/ports',
      'mesh/m.ts -> ../application/ports/p.js: mesh is shared infrastructure and must not import application/ports',
      'channel/noise/n.ts -> ../c.js: channel/noise is shared infrastructure and must not import channel',
      'tools/t.ts -> ../store/st.js: tools has no layer role; add it to ROLES in scripts/check-layers.mjs',
      'host/h.ts -> ../tools/t.js: tools has no layer role; add it to ROLES in scripts/check-layers.mjs',
    ]
    expect([...checkLayers(src)].sort()).toEqual([...expected].sort())
  })
})
