import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DesktopDetection } from '../../contracts/index.js'
import { hasCode } from '../storage/files.js'
import { readMachineState } from './machine-state.js'

export const desktopRecordPath = (home = userInfo().homedir): string => join(home, '.agentsanywhere', 'desktop', 'install.json')

/** Read-only: registration and Desktop onboarding belong to the Desktop app. */
export async function detectDesktop(home = userInfo().homedir, platform = process.platform): Promise<DesktopDetection> {
  try {
    const machine = await readMachineState(home)
    const value = machine['desktop']
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('安装记录无效')
    const record = value as Record<string, unknown> | undefined | null
    if (!record) return { status: 'absent', message: '未找到桌面端安装记录，可以通过 Web 完成设置。' }
    if (record['platform'] !== platform || typeof record['executablePath'] !== 'string' || !isAbsolute(record['executablePath'])) {
      return { status: 'error', message: '桌面端安装记录无效，请打开一次 Agents Anywhere 桌面端后重试。' }
    }
    const executablePath = record['executablePath']
    if (!(await stat(executablePath)).isFile()) throw new Error('启动文件无效')
    await access(executablePath, platform === 'win32' ? constants.F_OK : constants.X_OK)
    if (record['packaged'] === false) {
      if (typeof record['appPath'] !== 'string' || !isAbsolute(record['appPath'])) throw new Error('开发目录无效')
      if (!(await stat(record['appPath'])).isDirectory()) throw new Error('开发目录无效')
    }
    return { status: 'installed', executablePath, message: '已发现 Agents Anywhere 桌面端，请由桌面端管理本机设备。' }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { status: 'absent', message: '桌面端已不在原安装位置，可以通过 Web 继续连接本机设备。' }
    return { status: 'error', message: '无法读取或验证桌面端安装记录，请检查文件格式与访问权限。' }
  }
}
