import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  NO_SYSTEM_PROXY,
  normalizeProxyUrl,
  noProxyMatches,
  openTunnel,
  parseScutilProxy,
  parseWindowsInternetSettings,
  redactProxy,
  resolveEgress,
  sanitizeNoProxy,
  systemBypass,
  trustedCAs,
} from '../../src/link/index.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(handler: (socket: Socket) => void): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

const system = (proxies: Record<string, string>, bypass: string[] = [], bypassSimpleHosts = false) => ({ proxies, bypass, bypassSimpleHosts })
const alive = async () => true

describe('egress decision (v2 network.py traps)', () => {
  it('uses the override, the configured value, loopback and direct', async () => {
    expect(await resolveEgress('http://localhost:8000', { env: { AA_CONNECTOR_PROXY: 'http://p:1' } })).toEqual({ proxy: null, source: 'loopback' })
    expect(await resolveEgress('https://s.example', { env: { AA_CONNECTOR_PROXY: 'direct' } })).toEqual({ proxy: null, source: 'env-direct' })
    expect(await resolveEgress('https://s.example', { env: { AA_CONNECTOR_PROXY: 'p.example:3128' }, configured: 'direct' })).toEqual({ proxy: 'http://p.example:3128', source: 'env' })
    expect(await resolveEgress('https://s.example', { env: {}, configured: 'socks://p:1080' })).toEqual({ proxy: 'socks5h://p:1080', source: 'config' })
  })

  it('a lone NO_PROXY does not skip the system proxy', async () => {
    const result = await resolveEgress('https://s.example', { env: { NO_PROXY: 'internal.corp' }, system: system({ https: 'http://proxy.corp:8080' }), localProxyAlive: alive })
    expect(result).toEqual({ proxy: 'http://proxy.corp:8080', source: 'system-proxy' })
  })

  it('NO_PROXY covering the Server wins over every proxy, including [::1] and CIDR spellings', async () => {
    const env = { https_proxy: 'http://p:1', NO_PROXY: '[::1],10.0.0.0/8,.example.com:443' }
    expect(await resolveEgress('https://api.example.com', { env })).toEqual({ proxy: null, source: 'no-proxy' })
    expect(await resolveEgress('https://10.2.3.4', { env })).toEqual({ proxy: null, source: 'no-proxy' })
    expect(await resolveEgress('https://api.example.com:8443', { env })).toEqual({ proxy: 'http://p:1', source: 'env-proxy' })
    expect(noProxyMatches('[::1]', '[::1]', 80)).toBe(true)
    expect(noProxyMatches('fd00::/8', 'fd12::1', 443)).toBe(true)
    expect(noProxyMatches('*', 'anything', 1)).toBe(true)
  })

  it('the HTTP entry is not a fallback for https; the system bypass list applies', async () => {
    expect(await resolveEgress('https://s.example', { env: { http_proxy: 'http://p:1' } })).toEqual({ proxy: null, source: 'system-none' })
    const settings = system({ https: 'http://proxy:8080', http: 'http://proxy:8080' }, ['*.corp.example', '192.168.0.0/16'], true)
    expect(await resolveEgress('https://git.corp.example', { env: {}, system: settings, localProxyAlive: alive })).toEqual({ proxy: null, source: 'system-bypass' })
    expect(await resolveEgress('https://intranet', { env: {}, system: settings, localProxyAlive: alive })).toEqual({ proxy: null, source: 'system-bypass' })
    expect(systemBypass(settings, '192.168.1.5')).toBe(true)
    expect(systemBypass(settings, 'example.org')).toBe(false)
  })

  it('goes direct when a local system proxy app has quit', async () => {
    const closedPort = await listen(socket => socket.destroy())
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()))
    const settings = system({ https: `http://127.0.0.1:${closedPort}` })
    expect(await resolveEgress('https://s.example', { env: {}, system: settings })).toEqual({ proxy: null, source: 'system-proxy-down' })
    const livePort = await listen(socket => socket.destroy())
    expect(await resolveEgress('https://s.example', { env: {}, system: system({ https: `http://127.0.0.1:${livePort}` }) })).toEqual({ proxy: `http://127.0.0.1:${livePort}`, source: 'system-proxy' })
  })

  it('maps macOS and Windows SOCKS entries to socks5h', async () => {
    expect(await resolveEgress('https://s.example', { env: {}, system: system({ socks: 'http://127.0.0.1:7891' }), localProxyAlive: alive })).toMatchObject({ proxy: 'socks5h://127.0.0.1:7891' })
    expect(await resolveEgress('https://s.example', { env: {}, system: system({ socks: 'socks4://127.0.0.1:7891' }), localProxyAlive: alive })).toMatchObject({ proxy: 'socks5h://127.0.0.1:7891' })
  })

  it('rewrites NO_PROXY for the process tree and redacts proxy passwords', () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: '[::1], localhost:8080, bad entry!, 127.0.0.1/32', no_proxy: '*.example.com' }
    sanitizeNoProxy(env)
    expect(env.NO_PROXY).toBe('::1,localhost:8080,127.0.0.1')
    expect(env.no_proxy).toBe('example.com')
    expect(redactProxy('http://user:secret@p:1')).toBe('http://***@p:1')
    expect(normalizeProxyUrl('ftp://p:1')).toBeNull()
    expect(normalizeProxyUrl('')).toBeNull()
  })

  it('parses the OS settings', () => {
    const mac = parseScutilProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`)
    expect(mac).toEqual({ proxies: { http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890' }, bypass: ['*.local', '169.254/16'], bypassSimpleHosts: true })
    const win = parseWindowsInternetSettings(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8080;socks=127.0.0.1:1080
    ProxyOverride    REG_SZ    *.corp;<local>
`)
    expect(win).toEqual({ proxies: { http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8080', socks: 'socks4://127.0.0.1:1080' }, bypass: ['*.corp'], bypassSimpleHosts: true })
    expect(parseWindowsInternetSettings('    ProxyEnable    REG_DWORD    0x0\n')).toEqual(NO_SYSTEM_PROXY)
  })

  it('trusts at least the bundled CAs', () => {
    expect(trustedCAs().length).toBeGreaterThan(100)
  })
})

describe('tunnels', () => {
  async function echo(): Promise<number> {
    return listen(socket => socket.pipe(socket))
  }

  async function roundTrip(socket: Socket): Promise<string> {
    const reply = new Promise<string>(resolve => socket.once('data', chunk => resolve(chunk.toString())))
    socket.resume()
    socket.write('ping')
    const text = await reply
    socket.destroy()
    return text
  }

  it('connects directly', async () => {
    const port = await echo()
    expect(await roundTrip(await openTunnel({ proxy: null, source: 'direct' }, '127.0.0.1', port))).toBe('ping')
  })

  it('tunnels through HTTP CONNECT with credentials and refuses a non-200 answer', async () => {
    const target = await echo()
    const seen: string[] = []
    const proxyPort = await listen(client => {
      let head = ''
      const onData = (chunk: Buffer): void => {
        head += chunk.toString('latin1')
        if (!head.includes('\r\n\r\n')) return
        client.off('data', onData)
        seen.push(head)
        const m = /^CONNECT ([^ ]+):(\d+) /u.exec(head)
        if (m === null || m[1] === 'blocked') {
          client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
          return
        }
        const upstream = connect(Number(m[2]), m[1]!, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          client.pipe(upstream).pipe(client)
        })
      }
      client.on('data', onData)
    })
    const egress = { proxy: `http://user:p%40ss@127.0.0.1:${proxyPort}`, source: 'config' }
    expect(await roundTrip(await openTunnel(egress, '127.0.0.1', target))).toBe('ping')
    expect(seen[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}`)
    await expect(openTunnel(egress, 'blocked', 1)).rejects.toMatchObject({ code: 'proxy_failed' })
  })

  it('tunnels through SOCKS5 with a hostname', async () => {
    const target = await echo()
    const proxyPort = await listen(client => {
      let stage = 0
      client.on('data', function onData(chunk: Buffer) {
        if (stage === 0) {
          stage = 1
          client.write(Buffer.from([5, 0]))
          return
        }
        client.off('data', onData)
        const length = chunk[4]!
        const host = chunk.subarray(5, 5 + length).toString()
        const port = chunk.readUInt16BE(5 + length)
        const upstream = connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream).pipe(client)
        })
      })
    })
    expect(await roundTrip(await openTunnel({ proxy: `socks5h://127.0.0.1:${proxyPort}`, source: 'config' }, 'localhost', target))).toBe('ping')
  })
})
