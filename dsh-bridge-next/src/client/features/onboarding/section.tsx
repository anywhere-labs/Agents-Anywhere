import { useCallback, useEffect, useState } from 'react'
import type { OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'

export function OnboardingSection({ host }: { host: OnboardingHostApi }) {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [webBaseUrl, setWebBaseUrl] = useState('')
  const [apiBaseUrl, setApiBaseUrl] = useState('')

  const refresh = useCallback(async () => {
    const next = await host.inspect()
    setSnapshot(next)
    return next
  }, [host])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let first = true
    const poll = async () => {
      try {
        const next = await host.inspect()
        if (stopped) return
        setSnapshot(next)
        if (first) { setWebBaseUrl(next.settings.webBaseUrl); setApiBaseUrl(next.settings.apiBaseUrl); first = false }
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : '读取插件状态失败。')
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1_500)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [host])

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await action(); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }

  const begin = () => {
    // Create the tab during the gesture so async Host RPC cannot trigger a
    // popup blocker. The fallback link remains available in embedded clients.
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    void run(async () => {
      try {
        const result = await host.begin()
        setLink(result.url)
        if (tab) tab.location.replace(result.url)
      } catch (error) { tab?.close(); throw error }
    })
  }

  const detected = snapshot?.desktop.status
  return <section className="aa-onboarding">
    <style>{styles}</style>
    <div className="aa-onboarding-heading"><span>AGENTS ANYWHERE</span><h2>把这台电脑连接起来</h2><p>在 Web 和手机上继续使用你的 Agent。登录后，我们会为本机建立连接，并引导你完成设置。</p></div>
    <div className="aa-onboarding-status" role="status" aria-live="polite">
      <strong>{snapshot?.account ? `你好，${snapshot.account.displayName}` : '开始设置'}</strong>
      <p>{detected && detected !== 'absent' ? snapshot?.desktop.message : snapshot?.message ?? '正在检查本机…'}</p>
      {snapshot?.connectorId ? <small>设备：{snapshot.connectorId}</small> : null}
    </div>
    {error ? <p role="alert" className="aa-onboarding-error">{error}</p> : null}
    <div className="aa-onboarding-actions">
      <button disabled={busy || detected !== 'absent'} onClick={begin}>{busy ? '正在准备…' : snapshot?.account ? '继续 Web 引导' : '在浏览器中登录'}</button>
      {snapshot?.stage === 'authorizing' || snapshot?.stage === 'starting' || snapshot?.stage === 'pairing' ? <button className="secondary" disabled={busy} onClick={() => void run(async () => { await host.cancel(); setLink(null) })}>取消本次连接</button> : null}
      {snapshot?.account ? <button className="secondary" disabled={busy} onClick={() => void run(async () => { await host.logout(); setLink(null) })}>退出登录并断开设备</button> : null}
      {detected === 'error' ? <button className="secondary" disabled={busy} onClick={() => void run(refresh)}>重新检查</button> : null}
    </div>
    {link ? <p><a href={link} target="_blank" rel="noreferrer">浏览器没有打开？点击继续</a></p> : null}
    <details><summary>连接地址</summary><form onSubmit={(event) => { event.preventDefault(); void run(async () => { await host.configure({ apiBaseUrl, webBaseUrl }); setLink(null) }) }}>
      <label>Web 应用地址<input type="url" required value={webBaseUrl} onChange={(event) => setWebBaseUrl(event.target.value)} /></label>
      <label>服务地址<input type="url" required value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} /></label>
      <p>修改地址会退出当前账号并停止本机连接。</p>
      <button className="secondary" type="submit" disabled={busy}>保存连接地址</button>
    </form></details>
  </section>
}

const styles = `.aa-onboarding{font:inherit;max-width:680px;padding:24px;display:flex;flex-direction:column;gap:24px;box-sizing:border-box}.aa-onboarding *{box-sizing:border-box}.aa-onboarding h2{font-size:26px;margin:8px 0 12px}.aa-onboarding p{line-height:1.7;margin:8px 0;opacity:.78}.aa-onboarding-heading>span{font-size:11px;letter-spacing:.12em;opacity:.6}.aa-onboarding-status{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;padding:20px}.aa-onboarding-actions{display:flex;flex-wrap:wrap;gap:10px}.aa-onboarding button{font:inherit;border:1px solid transparent;background:#4c63e6;color:#fff;border-radius:8px;padding:10px 16px;cursor:pointer}.aa-onboarding button.secondary{background:transparent;color:inherit;border-color:color-mix(in srgb,currentColor 20%,transparent)}.aa-onboarding button:disabled{opacity:.45;cursor:default}.aa-onboarding a{color:inherit;text-underline-offset:3px}.aa-onboarding summary{cursor:pointer;opacity:.75}.aa-onboarding form{display:flex;flex-direction:column;gap:12px;margin-top:16px}.aa-onboarding label{display:flex;flex-direction:column;gap:6px;font-size:13px}.aa-onboarding input{font:inherit;background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:10px}.aa-onboarding .aa-onboarding-error{color:#d95656;opacity:1}.aa-onboarding :focus-visible{outline:2px solid #4c63e6;outline-offset:3px}@media(max-width:480px){.aa-onboarding{padding:16px}.aa-onboarding-actions{flex-direction:column}}`
