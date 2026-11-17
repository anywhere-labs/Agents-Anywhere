import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkLayers } from '../../scripts/check-layers.mjs'

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
})
