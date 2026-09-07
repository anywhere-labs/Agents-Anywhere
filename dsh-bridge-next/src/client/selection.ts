import type { Context } from '@deepseek-ai/cordis'
import { HOST_NAMESPACE } from '../contracts/index.js'
import type { HostRpc } from './api/host.js'

/** Official selection observable; independent of whether the connection modal is open. */
export function reportSelection(ctx: Context, rpc: HostRpc): void {
  ctx.inject(['sessions'], scope => {
    const { list } = scope.get('sessions') as unknown as {
      list: { getSnapshot(): { current: string | undefined | null }, subscribe(callback: () => void): () => void }
    }
    const clientId = crypto.randomUUID()
    let revision = 0
    const send = (current: string | null) => {
      void rpc.call('/api', `${HOST_NAMESPACE}/selection`, { args: { input: { clientId, revision: ++revision, current } } }).catch(() => undefined)
    }
    const report = () => send(list.getSnapshot().current ?? null)
    scope.effect(() => {
      report()
      const unsubscribe = list.subscribe(report)
      const timer = setInterval(report, 15_000)
      return () => { clearInterval(timer); unsubscribe(); send(null) }
    }, 'agentsAnywhereRuntime.selection')
  })
}
