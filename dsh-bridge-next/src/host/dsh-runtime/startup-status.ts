import type { BridgeStatus } from '../../contracts/bridge-status.js'
import { record } from './types.js'

/** Public guidance never includes raw exceptions, paths or endpoint credentials. */
export function startupFailure(error: unknown): BridgeStatus {
  const value = record(error)
  const cause = record(value.cause)
  const code = typeof value.code === 'string' ? value.code : typeof cause.code === 'string' ? cause.code : undefined
  const message = error instanceof Error ? error.message : ''
  if (code === 'EADDRINUSE' || /Another DSH bridge owns|另一个插件实例正在管理/.test(message)) return {
    state: 'failed', code: 'BRIDGE_IN_USE', canRetry: true,
    message: '本机连接被占用，无法启动。',
    hint: '请退出其他正在运行的 DSH，再点击“尝试重启”。如果只开了一个 DSH，请检查是否重复启用了插件。',
  }
  if (code === 'EACCES' || code === 'EPERM') return {
    state: 'failed', code, canRetry: true, message: '本机连接启动失败：访问权限不足。',
    hint: '请检查 DSH 数据目录的读写权限，以及系统是否允许 DSH 使用本机网络，再尝试重启。',
  }
  if (code === 'ENOSPC' || code === 'EROFS') return {
    state: 'failed', code, canRetry: true, message: '本机连接启动失败：无法保存连接信息。',
    hint: code === 'ENOSPC' ? '请释放磁盘空间后，再尝试重启。' : 'DSH 数据目录所在磁盘为只读。请恢复写入权限后，再尝试重启。',
  }
  return { state: 'failed', code: 'BRIDGE_START_FAILED', canRetry: true,
    message: '本机连接未能启动。', hint: '请先尝试重启连接。如果仍然失败，请展开运行日志中的失败记录，查看错误详情。' }
}

export const unavailableBridge: BridgeStatus = {
  state: 'unavailable', message: '本机连接服务尚未就绪。',
  hint: '如果此状态持续出现，请在 DSH 中重新加载插件，或退出并重新打开 DSH。', canRetry: false,
}
