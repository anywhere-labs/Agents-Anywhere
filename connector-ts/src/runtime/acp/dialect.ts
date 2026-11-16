// Runtime 方言：通用 ACP 引擎在这里留钩子，各 Profile（Codex、Claude、Pi、Hermes、通用 ACP、DSH）按需实现。
// 对应 v2 connector/connector/runtimes/acp/domain/dialect.py 的钩子（capabilities、supports_steer、
// adapt_configuration、translate_update、acceptance_evidence、interaction、configure、classify_error、
// steer、guarantees、echoes_user_prompt…），去掉 Python 特有的部分。

import type {
  Capability,
  ConfigOption,
  DeliveryRef,
  InteractionAnswer,
  InteractionKind,
  NativeHistoryPage,
  NativeSessionRef,
  NewSessionSpec,
  PromptInput,
  RuntimeError,
  RuntimeEvent,
  RuntimeType,
} from '../../application/ports/runtime-session.js'
import type { AcpClient, AgentInfo, JsonRecord } from './client.js'

/** 一个会话内的条目身份：按 v2 规则算 Timeline ID。 */
export interface ItemIdentity {
  /** ACP 更新落到哪个条目；不落条目（非文本块等）返回 null。 */
  itemFor(update: JsonRecord): string | null
  /** AA 发出的用户消息条目 ID。 */
  userItemId(clientMessageId: string): string
}

export interface SessionContext {
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly epoch: string
  readonly info: AgentInfo
}

export interface PlanModeSpec {
  /** 承载计划模式的配置项 ID（Codex `collaboration_mode`，Claude `mode`）。 */
  readonly optionId: string
  readonly planValue: string
  /** 退出计划模式时的值；undefined 时用进入前的值。 */
  readonly normalValue?: string
}

export interface PlanReviewDecision {
  /** 回给 request_permission 的选项；undefined 表示回 cancelled。 */
  readonly optionId?: string
  /** 回答之后再做的事：修改计划把意见 steer 进当前回合；暂不执行则中断回合。 */
  readonly then?: { readonly action: 'steer'; readonly text: string } | { readonly action: 'cancel' }
}

export interface AcpDialect {
  readonly runtime: RuntimeType
  /** 客户端声明的最高协议版本；缺省 1。 */
  readonly protocolVersion?: 1 | 2
  /** initialize 的 clientCapabilities。 */
  clientCapabilities(): JsonRecord
  /** initialize 顶层 `_meta`（扩展协商）。 */
  initializeMeta?(): JsonRecord | undefined
  /** 运行时级能力（由协商结果得出）。 */
  capabilities(info: AgentInfo): Capability[]
  /** 会话级能力；缺省等于运行时级。 */
  sessionCapabilities?(info: AgentInfo, config: readonly ConfigOption[]): Capability[]
  /** 条目身份；缺省用 v2 通用 ACP 规则（AcpProjectionIdentity）。 */
  identity?(context: SessionContext): ItemIdentity
  /** session/new 的额外参数（`_meta` 等）。 */
  newSessionParams?(spec: NewSessionSpec): JsonRecord
  /** session/load / session/resume 的额外参数（Codex 的 `codexIpc.mode: auto`）。 */
  openParams?(ref: NativeSessionRef): JsonRecord
  /** session/prompt 的额外参数（Codex 的 `codexIpc.clientMessageId`）。 */
  promptParams?(delivery: DeliveryRef): JsonRecord
  /** 把 AA 的输入转成 ACP 内容块；缺省文本 + 附件（图片内联、文件转 resource_link）。 */
  promptBlocks?(input: PromptInput): JsonRecord[]
  /** 插话方式：ACP 扩展 `_session/steering`、文本命令（Hermes `/steer`），或不支持。 */
  readonly steer: 'extension' | 'text-command' | 'none'
  readonly steerCommand?: string
  /** 文本命令插话能不能带附件；缺省不能（v2 `SlashSteer.attachments`）。 */
  readonly steerAttachments?: boolean
  /** Agent 会把 AA 发的用户消息回显成 user_message_chunk：这类回显不再落条目。 */
  readonly echoesUserPrompt?: boolean
  /** 把一条 ACP 更新翻译成内部事件；返回 undefined 时走通用翻译。 */
  translateUpdate?(update: JsonRecord, context: SessionContext): RuntimeEvent[] | undefined
  /** 反向请求的交互类别；返回 undefined 时走通用判断。 */
  interactionKind?(method: string, params: JsonRecord): InteractionKind | undefined
  /** 反向请求到达时先给方言看一眼（Hermes 记下审批卡的 toolCallId）。不改变处理方式。 */
  observeRequest?(method: string, params: JsonRecord, context: SessionContext): void
  /** 打开会话后检查 Agent 是否满足要求（例如必须提供模型配置）；返回错误时会话打开失败。 */
  verifySession?(config: readonly ConfigOption[]): RuntimeError | undefined
  /** 计划审阅的回答怎么落到 ACP 选项上。 */
  planReview?(answer: Extract<InteractionAnswer, { kind: 'plan_review' }>, options: readonly JsonRecord[]): PlanReviewDecision
  /** 计划模式承载在哪个配置项上。 */
  planMode?(config: readonly ConfigOption[]): PlanModeSpec | undefined
  /** Goal 扩展方法名（`_session/goal`）；undefined 表示不支持。 */
  goalMethod?(info: AgentInfo): string | undefined
  /** 方言自己处理的反向请求（`_codex/session/history_reset` 等）。返回 undefined 表示不认识。 */
  handleRequest?(method: string, params: JsonRecord, session: DialectSessionHooks): Promise<unknown> | undefined
  /** 错误归类。 */
  classifyError?(error: unknown): RuntimeError | undefined
  /** 调整配置项（类别修正、隐藏不支持的项）。 */
  adaptConfig?(options: ConfigOption[]): ConfigOption[]
  /** 只读历史：不 resume、不抢锁、不写原生记录。undefined 时走通用实现（加载 + 捕获 + 关闭）。 */
  readNativeHistory?(client: AcpClient, ref: NativeSessionRef, sessionId: string): Promise<NativeHistoryPage> | undefined
}

/** 方言在反向请求里可以用的会话能力。 */
export interface DialectSessionHooks {
  emit(event: RuntimeEvent): void
}
