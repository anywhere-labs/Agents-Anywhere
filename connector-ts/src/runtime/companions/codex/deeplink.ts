// 经 deeplink 把线程交给正在运行的 Codex App。
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/deeplink.py
//
// Codex App（macOS 上在 ChatGPT.app 里，其它平台是 Codex.app）注册了 `codex://` 协议。打开
// `codex://threads/<线程>` 会让 App 切到这个线程、在它的 app-server 里加载并登记为 IPC owner，
// 之后 codex-acp 很快就能跟随它。这里只负责拼 URL 和让系统打开它；什么时候用由伴随层决定。
// 与 v2 的差别：打开动作通过注入的 opener 执行，测试不会真的打开 App。

import { spawn } from 'node:child_process'

const THREAD_ID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/
const OPEN_TIMEOUT_MS = 5_000

/** `codex://threads/<线程>`；线程 ID 必须是 UUID 形状。 */
export function threadDeeplink(threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error(`not a Codex thread id: ${JSON.stringify(threadId)}`)
  return `codex://threads/${threadId.toLowerCase()}`
}

export function deeplinkSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}

/** 让系统在后台打开 URL 的命令（macOS `open -g` 不抢焦点）。 */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): readonly string[] | undefined {
  if (platform === 'darwin') return ['open', '-g', url]
  if (platform === 'linux') return ['xdg-open', url]
  // v2 用 os.startfile；Node 里等价的是 url.dll 的 FileProtocolHandler，不经 shell 解析 URL。
  if (platform === 'win32') return ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
  return undefined
}

/** 打开一个 URL；系统 opener 接受时为 true。 */
export type UrlOpener = (url: string) => Promise<boolean>

export function systemUrlOpener(platform: NodeJS.Platform = process.platform, timeoutMs = OPEN_TIMEOUT_MS): UrlOpener {
  return url => new Promise(resolve => {
    const argv = openerCommand(url, platform)
    if (argv === undefined || argv.length === 0) return resolve(false)
    const [command, ...args] = argv as [string, ...string[]]
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      done(false)
    }, timeoutMs)
    child.once('error', () => done(false))
    // Windows 的 rundll32 退出码不可靠，只要启动成功就算接受。
    child.once('exit', code => done(platform === 'win32' || code === 0))
  })
}
