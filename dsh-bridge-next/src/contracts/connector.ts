export interface ConnectorSettings {
  uvPath: string
  uvPypiIndexUrl: string
  autoStart: boolean
  heartbeatSeconds: number
  reconnectSeconds: number
  syncIntervalSeconds: number
  syncExistingOnConnect: boolean
}

export const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = {
  uvPath: '', uvPypiIndexUrl: '', autoStart: true,
  heartbeatSeconds: 20, reconnectSeconds: 3, syncIntervalSeconds: 30, syncExistingOnConnect: true,
}

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
