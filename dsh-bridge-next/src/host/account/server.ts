const API_NAMESPACE = '/api/v2'

export { resolveOAuthWebOrigin } from '../../contracts/web-address.js'

/** Match Desktop's origin-only server input, including bare hosts and /api/v2. */
export function normalizeServerOrigin(value: string): string {
  try {
    const input = value.trim()
    if (!input) throw new Error()
    const url = new URL(input.includes('://') ? input : `https://${input}`)
    const pathname = url.pathname.replace(/\/+$/, '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (pathname && pathname !== API_NAMESPACE)) throw new Error()
    return url.origin
  } catch {
    throw new Error('请输入有效的 HTTP 或 HTTPS 服务器地址，不要包含账号、密码或页面路径。')
  }
}

/** Check the selected backend before replacing any active account or connection. */
export async function checkServer(apiBaseUrl: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(`${apiBaseUrl}${API_NAMESPACE}/health`, {
      headers: { accept: 'application/json' },
      credentials: 'omit', redirect: 'error', signal: controller.signal,
    })
    if (!response.ok) throw new Error('无法连接服务器，请检查地址和网络后重试。')
    const payload: unknown = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || !('status' in payload) || payload.status !== 'ok') {
      throw new Error('该地址未返回正常的 Agents Anywhere 服务，请检查后端地址。')
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接服务器超时，请检查地址和网络后重试。')
    if (error instanceof TypeError) throw new Error('无法连接服务器，请检查地址和网络后重试。')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
