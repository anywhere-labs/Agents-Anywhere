/** Which DSH conversations the plugin imports: ones a person typed into, or all of them.
 * A conversation started by a plugin or a scheduled turn carries only plugin or
 * runtime context messages, so `human` skips it and `all` imports it as well. */
export type SessionSyncScope = 'human' | 'all'

export interface ConnectorSettings {
  uvPath: string
  uvPypiIndexUrl: string
  uvPythonInstallMirror: string
  syncIntervalSeconds: number
  sessionSyncScope: SessionSyncScope
}

export const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = {
  uvPath: '', uvPypiIndexUrl: '', uvPythonInstallMirror: '', syncIntervalSeconds: 30, sessionSyncScope: 'human',
}

export const SESSION_SYNC_SCOPES = [
  { id: 'human', label: '仅人类消息' },
  { id: 'all', label: '全部消息' },
] as const

export const PYTHON_MIRRORS = [
  { id: 'default', label: '官方源', url: '' },
  { id: 'npmmirror', label: 'npmmirror', url: 'https://registry.npmmirror.com/-/binary/python-build-standalone' },
] as const

export const SYNC_INTERVALS = [15, 30, 60, 300] as const
export const PYPI_MIRRORS = [
  { id: 'default', label: '默认 PyPI', url: '' },
  { id: 'tsinghua', label: '清华大学', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'ustc', label: '中国科学技术大学', url: 'https://mirrors.ustc.edu.cn/pypi/simple' },
  { id: 'bfsu', label: '北京外国语大学', url: 'https://mirrors.bfsu.edu.cn/pypi/web/simple' },
  { id: 'aliyun', label: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple' },
  { id: 'tencent', label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/pypi/simple' },
  { id: 'huawei', label: '华为云', url: 'https://repo.huaweicloud.com/repository/pypi/simple' },
] as const

export type ConnectorAction = 'start' | 'stop' | 'restart'
export type ConnectorFolder = 'data' | 'logs'
export interface ConnectorManagement {
  settings: ConnectorSettings
  resolvedUvPath: string | null
  dataPath: string
  logsPath: string
  canOpenFolders: boolean
  deviceName: string | null
  lastError: string | null
}
