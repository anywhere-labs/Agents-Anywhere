// Opt-in end-to-end check against real frp binaries:
//   AA_FRP_BIN_DIR=/path/to/frp_0.72.0_darwin_arm64 yarn vitest run test/workspace/preview-frp.integration.test.ts
// Starts a local frps (no auth plugin), a local HTTP server and the FrpcManager, then fetches through the frps vhost.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FrpcManager, freeLoopbackPort } from '../../src/workspace/index.js'

const binDir = process.env.AA_FRP_BIN_DIR

describe.skipIf(binDir === undefined)('port preview through real frp', () => {
  let dir: string
  let frps: ChildProcess
  let app: Server
  let appPort: number
  let bindPort: number
  let vhostPort: number

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-frp-it-'))
    bindPort = await freeLoopbackPort()
    vhostPort = await freeLoopbackPort()
    writeFileSync(join(dir, 'frps.toml'), [
      'bindAddr = "127.0.0.1"', `bindPort = ${bindPort}`, `vhostHTTPPort = ${vhostPort}`, 'subDomainHost = "preview.test"', 'log.level = "warn"',
    ].join('\n'))
    frps = spawn(join(binDir!, 'frps'), ['-c', join(dir, 'frps.toml')], { stdio: 'ignore' })
    app = createServer((req, res) => res.end(`hello from ${req.headers.host}`))
    appPort = await new Promise(resolve => app.listen(0, '127.0.0.1', () => resolve((app.address() as { port: number }).port)))
    await new Promise(resolve => setTimeout(resolve, 500))
  })

  afterAll(() => {
    frps?.kill()
    app?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // fetch() may not set Host; frps routes by it.
  const get = (slug: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: vhostPort, path: '/', headers: { host: `${slug}.preview.test` } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

  const viaFrps = async (slug: string): Promise<{ status: number; body: string }> => {
    let last = { status: 0, body: '' }
    for (let attempt = 0; attempt < 50; attempt++) {
      last = await get(slug).catch(() => last)
      if (last.status === 200) return last
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return last
  }

  it('serves the local port under the slug, hot-adds a second preview and stops after the last close', async () => {
    const manager = new FrpcManager({ frpcPath: join(binDir!, 'frpc'), dir: join(dir, 'frpc') })
    const base = { localIP: '127.0.0.1' as const, token: 't', tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(), frpsAddr: `tcp://127.0.0.1:${bindPort}` }
    await manager.open({ ...base, previewId: 'pv1', slug: 'firstslug1', port: appPort })
    const first = await viaFrps('firstslug1')
    expect(first.status).toBe(200)
    // hostHeaderRewrite makes the dev server see its own loopback host.
    expect(first.body).toBe(`hello from 127.0.0.1:${appPort}`)
    await manager.open({ ...base, previewId: 'pv2', slug: 'secondslug', port: appPort })
    expect((await viaFrps('secondslug')).status).toBe(200)
    await manager.close('pv1')
    expect((await viaFrps('secondslug')).status).toBe(200)
    await manager.closeAll()
    expect((await get('secondslug')).status).toBe(404)
  }, 30_000)
})
