import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DesktopDetection } from '../../contracts/index.js'
import { hasCode, readJson } from '../storage/files.js'

export const desktopRecordPath = (home = userInfo().homedir): string => join(home, '.agentsanywhere', 'desktop', 'install.json')

/** Read-only: registration and Desktop onboarding belong to the Desktop app. */
export async function detectDesktop(home = userInfo().homedir, platform = process.platform): Promise<DesktopDetection> {
  try {
    const record = await readJson<Record<string, unknown>>(desktopRecordPath(home))
    if (!record) return { status: 'absent', message: '未找到桌面端安装记录，可以通过 Web 完成设置。' }
    if (record['version'] !== 1 || record['platform'] !== platform || typeof record['executablePath'] !== 'string' || !isAbsolute(record['executablePath'])) {
      return { status: 'error', message: '桌面端安装记录无效，请打开一次 Agents Anywhere 桌面端后重试。' }
    }
    const executablePath = record['executablePath']
    if (!(await stat(executablePath)).isFile()) throw new Error('启动文件无效')
    await access(executablePath, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return { status: 'installed', executablePath, message: '已发现 Agents Anywhere 桌面端，请由桌面端管理本机设备。' }
  } catch (error) {
    return { status: 'error', message: hasCode(error, 'ENOENT')
      ? '安装记录指向的桌面端已不存在，请修复或移除失效记录后重试。'
      : '无法读取或验证桌面端安装记录，请检查文件格式与访问权限。' }
  }
}
