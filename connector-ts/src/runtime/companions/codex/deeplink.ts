// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/deeplink.py @98dd0e6e5 (thread deeplink)
//
// Hands a thread to the running Codex App through a deeplink.
//
// The Codex App (inside ChatGPT.app on macOS, Codex.app on other platforms) registers the `codex://` scheme. Opening
// `codex://threads/<thread>` makes the App switch to that thread, load it in its app-server and register as the IPC
// owner, after which codex-acp can follow it quickly. This file only builds the URL and asks the system to open it;
// the companion layer decides when to use it. Opening goes through an injected opener, so tests never open the App.

import { spawn } from 'node:child_process'

const THREAD_ID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/
const OPEN_TIMEOUT_MS = 5_000

/** `codex://threads/<thread>`; the thread ID must be UUID-shaped. */
export function threadDeeplink(threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error(`not a Codex thread id: ${JSON.stringify(threadId)}`)
  return `codex://threads/${threadId.toLowerCase()}`
}

export function deeplinkSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}

/** Command that makes the system open a URL in the background (macOS `open -g` does not steal focus). */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): readonly string[] | undefined {
  if (platform === 'darwin') return ['open', '-g', url]
  if (platform === 'linux') return ['xdg-open', url]
  // url.dll's FileProtocolHandler opens the URL without the shell parsing it.
  if (platform === 'win32') return ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
  return undefined
}

/** Opens a URL; true when the system opener accepts it. */
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
    // The rundll32 exit code on Windows is unreliable: a successful launch counts as accepted.
    child.once('exit', code => done(platform === 'win32' || code === 0))
  })
}
