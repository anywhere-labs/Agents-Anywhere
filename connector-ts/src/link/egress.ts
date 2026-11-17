// How the Connector reaches its Server: which proxy, and which trust store (04-connector.md §8). The decision
// avoids these traps, each covered by a test:
// - a lone NO_PROXY makes the environment look configured, so the system proxy would be skipped;
// - the system bypass list (macOS exceptions, Windows ProxyOverride) must apply;
// - some NO_PROXY spellings (`[::1]`) break other libraries, so NO_PROXY is rewritten for the whole process tree;
// - a local proxy app that quit often leaves the system switch on: probe a loopback proxy before using it.
// HTTPS, the MeshCall connection and frpc all take the route decided here.
import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import { connect } from 'node:net'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const PROXY_ENV = 'AA_CONNECTOR_PROXY'
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const DEFAULT_PROXY_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'socks5:': 1080, 'socks5h:': 1080 }
const DOMAIN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/u
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::(\d+))?$/u

/** The route to the Server; `source` says which setting decided it. */
export interface Egress {
  readonly proxy: string | null
  readonly source: string
}

/** The OS proxy settings (macOS `scutil --proxy`, Windows Internet Settings). */
export interface SystemProxySettings {
  /** scheme (`http`, `https`, `socks`) → proxy URL */
  readonly proxies: Readonly<Record<string, string>>
  /** Hosts, wildcards and networks that bypass the proxy. */
  readonly bypass: readonly string[]
  /** macOS "Exclude simple hostnames" / Windows `<local>`. */
  readonly bypassSimpleHosts: boolean
}

export const NO_SYSTEM_PROXY: SystemProxySettings = { proxies: {}, bypass: [], bypassSimpleHosts: false }

export function isLoopbackUrl(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Proxy URLs can carry a password, and these strings go to the logs. */
export function redactProxy(value: string): string {
  return value.replace(/(?<=:\/\/)[^/@]*@/u, '***@')
}

/** The proxy URL with a scheme the Connector supports, or null. */
export function normalizeProxyUrl(value: string): string | null {
  let candidate = value.trim()
  if (candidate === '') return null
  if (!candidate.includes('://')) candidate = `http://${candidate}`
  if (candidate.startsWith('socks://')) candidate = `socks5h://${candidate.slice('socks://'.length)}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (!PROXY_SCHEMES.has(parsed.protocol) || parsed.hostname === '') return null
  return candidate
}

interface NoProxyEntry {
  readonly everything?: boolean
  readonly domain?: string
  readonly network?: { readonly address: string; readonly prefix: number; readonly v6: boolean }
  readonly port?: number
}

function ipToBigInt(address: string): { value: bigint; v6: boolean } | null {
  const kind = isIP(address)
  if (kind === 4) return { value: address.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n), v6: false }
  if (kind !== 6) return null
  let [head = '', tail = ''] = address.split('::')
  if (!address.includes('::')) tail = ''
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const expand = (groups: string[]): string[] => groups.flatMap(group => {
    if (group.includes('.')) {
      const v4 = ipToBigInt(group)
      if (v4 === null) return ['0', '0']
      return [((v4.value >> 16n) & 0xffffn).toString(16), (v4.value & 0xffffn).toString(16)]
    }
    return [group]
  })
  const l = expand(left)
  const r = expand(right)
  const groups = address.includes('::') ? [...l, ...Array<string>(8 - l.length - r.length).fill('0'), ...r] : l
  if (groups.length !== 8) return null
  return { value: groups.reduce((acc, group) => (acc << 16n) + BigInt(parseInt(group || '0', 16)), 0n), v6: true }
}

function inNetwork(host: string, network: NonNullable<NoProxyEntry['network']>): boolean {
  const ip = ipToBigInt(host.replace(/^\[|\]$/gu, ''))
  const base = ipToBigInt(network.address)
  if (ip === null || base === null || ip.v6 !== network.v6) return false
  const bits = network.v6 ? 128 : 32
  const shift = BigInt(bits - network.prefix)
  return (ip.value >> shift) === (base.value >> shift)
}

export function parseNoProxyEntry(raw: string): NoProxyEntry | null {
  let entry = raw.trim().toLowerCase()
  if (entry === '') return null
  if (entry === '*') return { everything: true }
  let port: number | undefined
  const bracketed = BRACKETED_IPV6.exec(entry)
  if (bracketed !== null) {
    entry = bracketed[1]!
    if (bracketed[2] !== undefined) port = Number(bracketed[2])
  } else if ((entry.match(/:/gu) ?? []).length === 1) {
    const [name = '', portText = ''] = entry.split(':')
    if (!/^\d+$/u.test(portText)) return null
    entry = name
    port = Number(portText)
  }
  const [address = '', prefixText] = entry.split('/')
  const kind = isIP(address)
  if (kind !== 0) {
    const bits = kind === 6 ? 128 : 32
    const prefix = prefixText === undefined ? bits : Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null
    return { network: { address, prefix, v6: kind === 6 }, ...(port !== undefined ? { port } : {}) }
  }
  const domain = entry.replace(/^\*\./u, '').replace(/^\.+/u, '')
  return DOMAIN.test(domain) ? { domain, ...(port !== undefined ? { port } : {}) } : null
}

function entryMatches(entry: NoProxyEntry, host: string, port: number): boolean {
  if (entry.everything === true) return true
  if (entry.port !== undefined && entry.port !== port) return false
  if (entry.network !== undefined) return inNetwork(host, entry.network)
  return host === entry.domain || host.endsWith(`.${entry.domain}`)
}

function entryText(entry: NoProxyEntry): string {
  if (entry.everything === true) return '*'
  if (entry.network !== undefined) {
    const full = entry.network.prefix === (entry.network.v6 ? 128 : 32)
    const text = full ? entry.network.address : `${entry.network.address}/${entry.network.prefix}`
    // Other libraries cannot parse a bracketed IPv6 entry, with or without a port.
    return entry.port === undefined || entry.network.v6 ? text : `${text}:${entry.port}`
  }
  return entry.port === undefined ? entry.domain! : `${entry.domain}:${entry.port}`
}

export function noProxyMatches(value: string, host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/gu, '')
  return value.split(',').map(parseNoProxyEntry).some(entry => entry !== null && entryMatches(entry, h, port))
}

/** NO_PROXY rewritten so nothing in this process tree (libraries, Agent subprocesses) trips over it. */
export function sanitizeNoProxy(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const value = env[name]
    if (value !== undefined && value !== '') env[name] = value.split(',').map(parseNoProxyEntry).filter(entry => entry !== null).map(entryText).join(',')
  }
}

function environmentProxies(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    const m = /^([a-z]+)_proxy$/iu.exec(name)
    if (m === null || value === undefined || value === '') continue
    const scheme = m[1]!.toLowerCase()
    // Lower case wins, as in CPython; REQUEST_METHOD means CGI, where HTTP_PROXY comes from a request header.
    if (scheme === 'http' && name === 'HTTP_PROXY' && env.REQUEST_METHOD !== undefined) continue
    if (name === name.toLowerCase() || out[scheme] === undefined) out[scheme] = value
  }
  return out
}

/** The HTTP entry is not a fallback for an https target (curl does the same). */
function pickProxy(proxies: Readonly<Record<string, string>>, secure: boolean, system: boolean): string | null {
  for (const scheme of [secure ? 'https' : 'http', 'all', 'socks']) {
    let value = proxies[scheme]
    if (value === undefined || value === '') continue
    // macOS reports a SOCKS proxy as {"socks": "http://host:port"}.
    if (scheme === 'socks' && value.startsWith('http://')) value = `socks5h://${value.slice('http://'.length)}`
    // A Windows SOCKS entry is socks4 by label; the local proxy apps people run speak SOCKS5.
    if (system && value.startsWith('socks4://')) value = `socks5h://${value.slice('socks4://'.length)}`
    const normalized = normalizeProxyUrl(value)
    if (normalized !== null) return normalized
  }
  return null
}

function wildcardMatch(pattern: string, host: string): boolean {
  const regex = new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'u')
  return regex.test(host)
}

/** The OS bypass list (macOS exceptions, Windows ProxyOverride). */
export function systemBypass(settings: SystemProxySettings, host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/gu, '')
  if (settings.bypassSimpleHosts && !h.includes('.') && isIP(h) === 0) return true
  return settings.bypass.some(raw => {
    const pattern = raw.trim().toLowerCase()
    if (pattern === '' || pattern === '<local>') return false
    if (pattern.includes('/')) {
      const entry = parseNoProxyEntry(pattern)
      return entry?.network !== undefined && inNetwork(h, entry.network)
    }
    if (pattern.includes('*')) return wildcardMatch(pattern, h)
    return h === pattern || h.endsWith(`.${pattern.replace(/^\./u, '')}`)
  })
}

export interface ResolveOptions {
  readonly configured?: string | null
  readonly env?: NodeJS.ProcessEnv
  readonly system?: SystemProxySettings
  /** Whether a loopback proxy accepts connections (default: a 500 ms TCP probe). */
  readonly localProxyAlive?: (proxy: string) => Promise<boolean>
}

/** The route to `url`: `AA_CONNECTOR_PROXY` (`direct`, `system` or a URL) overrides the configured value. */
export async function resolveEgress(url: string, options: ResolveOptions = {}): Promise<Egress> {
  if (isLoopbackUrl(url)) return { proxy: null, source: 'loopback' }
  const env = options.env ?? process.env
  const fromEnv = (env[PROXY_ENV] ?? '').trim()
  const mode = fromEnv !== '' ? fromEnv : (options.configured ?? '').trim() || 'system'
  const origin = fromEnv !== '' ? 'env' : 'config'
  if (mode === 'direct') return { proxy: null, source: `${origin}-direct` }
  if (mode !== 'system') {
    const explicit = normalizeProxyUrl(mode)
    if (explicit !== null) return { proxy: explicit, source: origin }
  }
  const parsed = new URL(url)
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
  const port = parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port)
  const environment = environmentProxies(env)
  // A NO_PROXY covering this Server wins over any proxy, wherever the proxy came from.
  if (noProxyMatches(environment.no ?? '', parsed.hostname, port)) return { proxy: null, source: 'no-proxy' }
  const fromEnvironment = pickProxy(environment, secure, false)
  if (fromEnvironment !== null) return { proxy: fromEnvironment, source: 'env-proxy' }
  const system = options.system ?? NO_SYSTEM_PROXY
  const fromSystem = pickProxy(system.proxies, secure, true)
  if (fromSystem === null) return { proxy: null, source: 'system-none' }
  if (systemBypass(system, parsed.hostname)) return { proxy: null, source: 'system-bypass' }
  if (!(await (options.localProxyAlive ?? localProxyAlive)(fromSystem))) return { proxy: null, source: 'system-proxy-down' }
  return { proxy: fromSystem, source: 'system-proxy' }
}

/** Only a loopback proxy gives a certain answer; a slow remote proxy is assumed up. */
export function localProxyAlive(proxy: string, timeoutMs = 500): Promise<boolean> {
  const parsed = new URL(proxy)
  const host = parsed.hostname.replace(/^\[|\]$/gu, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return Promise.resolve(true)
  const port = parsed.port === '' ? DEFAULT_PROXY_PORTS[parsed.protocol] ?? 80 : Number(parsed.port)
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const done = (alive: boolean): void => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Parses `scutil --proxy`. */
export function parseScutilProxy(text: string): SystemProxySettings {
  const value = (key: string): string | undefined => new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mu').exec(text)?.[1]
  const proxies: Record<string, string> = {}
  for (const [scheme, prefix] of [['http', 'HTTP'], ['https', 'HTTPS'], ['socks', 'SOCKS']] as const) {
    if (value(`${prefix}Enable`) !== '1') continue
    const host = value(`${prefix}Proxy`)
    const port = value(`${prefix}Port`)
    if (host !== undefined) proxies[scheme] = `http://${host}${port !== undefined ? `:${port}` : ''}`
  }
  const list = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/u.exec(text)?.[1] ?? ''
  const bypass = [...list.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gmu)].map(m => m[1]!)
  return { proxies, bypass, bypassSimpleHosts: value('ExcludeSimpleHostnames') === '1' }
}

/** Parses `reg query "HKCU\...\Internet Settings"` (ProxyEnable, ProxyServer, ProxyOverride). */
export function parseWindowsInternetSettings(text: string): SystemProxySettings {
  const value = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mu').exec(text)?.[1]
  const enabled = value('ProxyEnable')
  if (enabled === undefined || Number(enabled) === 0) return NO_SYSTEM_PROXY
  const server = value('ProxyServer') ?? ''
  const proxies: Record<string, string> = {}
  if (server.includes('=')) {
    for (const part of server.split(';')) {
      const [scheme = '', address = ''] = part.split('=')
      if (address === '') continue
      const s = scheme.trim().toLowerCase()
      proxies[s] = /^[a-z0-9]+:\/\//iu.test(address) ? address : `${s === 'socks' ? 'socks4' : 'http'}://${address.trim()}`
    }
  } else if (server !== '') {
    const address = /^[a-z0-9]+:\/\//iu.test(server) ? server : `http://${server}`
    proxies.http = address
    proxies.https = address
  }
  const override = (value('ProxyOverride') ?? '').split(';').map(part => part.trim()).filter(part => part !== '')
  return { proxies, bypass: override.filter(part => part !== '<local>'), bypassSimpleHosts: override.includes('<local>') }
}

/** Reads the OS proxy settings; none on Linux (the environment variables are the convention there). */
export async function readSystemProxySettings(platform: NodeJS.Platform = process.platform): Promise<SystemProxySettings> {
  try {
    if (platform === 'darwin') return parseScutilProxy((await run('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })).stdout)
    if (platform === 'win32') {
      const { stdout } = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
      return parseWindowsInternetSettings(stdout)
    }
  } catch {
    // No settings readable: same as none.
  }
  return NO_SYSTEM_PROXY
}
