import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export async function systemDeviceName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await runFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1500, windowsHide: true })
      if (stdout.trim()) return stdout.trim()
    } catch { /* Fall back when the system name is unavailable. */ }
  }
  if (process.platform === 'win32') {
    const name = process.env['COMPUTERNAME']?.trim()
    if (name) return name
  }
  return hostname().trim().replace(/\.local$/i, '') || '本机设备'
}
