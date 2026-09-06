import { HOST_NAMESPACE, type OnboardingHostApi } from '../../contracts/index.js'

export interface HostRpc {
  call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
}

export function createHostApi(rpc: HostRpc): OnboardingHostApi {
  const call = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await rpc.call('/api', `${HOST_NAMESPACE}/${method}`, { args })
    if (!result.ok) throw new Error(result.error?.message ?? '插件连接暂不可用，请重试。')
    return result.value as T
  }
  return {
    inspect: () => call('inspect'), begin: input => call('begin', input ? { input } : {}),
    cancel: () => call('cancel'), logout: () => call('logout'),
  }
}
