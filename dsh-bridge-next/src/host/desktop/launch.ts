import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import type { DesktopLaunch } from '../../contracts/index.js'

/** Registered by the packaged Desktop app; also carries its OAuth callback. */
export const DESKTOP_PROTOCOL = 'agents-anywhere-desktop'

export interface DesktopLaunchTarget {
  executablePath: string
  launchArgs: string[]
  packaged: boolean
}

export type DesktopLauncher = (target: DesktopLaunchTarget, url: string) => Promise<void>

/** 24 base64url characters, inside the range the Desktop entry validates. */
export function newDesktopFlowId(): string {
  return randomBytes(18).toString('base64url')
}

export function desktopOnboardingUrl(flowId: string): string {
  const params = new URLSearchParams({ source: 'dsh-plugin', flowId })
  return `${DESKTOP_PROTOCOL}://onboarding?${params.toString()}`
}

async function openWithHandler(command: string, url: string): Promise<void> {
  await promisify(execFile)(command, [url], { timeout: 5_000, windowsHide: true })
}

async function spawnDetached(executablePath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/**
 * macOS goes through LaunchServices so an already running app receives the URL
 * as `open-url`; Windows and Linux pass it as an argument, which the running
 * instance receives through `second-instance`. The recorded executable is the
 * fallback for development builds, where the scheme is not registered.
 */
export const launchDesktop: DesktopLauncher = async (target, url) => {
  const handler = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'linux' ? 'xdg-open' : null
  if (handler) {
    try { await openWithHandler(handler, url); return } catch { /* Fall back to the recorded executable. */ }
  }
  await spawnDetached(target.executablePath, [...target.launchArgs, url])
}

export function launchResult(flowId: string): DesktopLaunch {
  return { flowId, url: desktopOnboardingUrl(flowId) }
}
