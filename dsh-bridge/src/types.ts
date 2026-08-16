export type JsonObject = Record<string, unknown>

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: JsonObject
}

export interface BridgeConfig {
  stateRoot: string
  maxFrameBytes: number
  shutdownTimeoutMs: number
}

export interface DshServices {
  appExit?: (code: number) => void
  agents: any
  sessions: any
  sessionPersistence: any
  llm: any
  agentDefaultModel: any
  commands: any
  permissionPresets: any
  approval: any
  userQuestions: any
  on?: (...args: any[]) => () => void
  logger: { warn: (value: unknown) => void; error: (value: unknown) => void }
}

export interface SessionBinding {
  sessionId: string
  externalSessionId: string
}

export interface Interaction {
  notice: JsonObject
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}
