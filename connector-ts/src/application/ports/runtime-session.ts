// RuntimeSession 端口（04-connector.md §4）：会话引擎只通过它和 Runtime 打交道。
//
// 实现方：runtime/ 下的 ACP 适配器（Codex、Claude、Pi、Hermes、通用 ACP、DSH 两条路由）和
// runtime/dsh-bridge2 兼容适配器。ACP 类型不越过这个端口：这里出现的都是 AA 自己的词汇。
//
// 约定：
// - 适配器负责把原生更新翻译成 RuntimeEvent，并按 v2 规则（domain/identity，contracts/identity-vectors）
//   算好 Timeline 条目 ID；投影成 TimelineItem、落库、排序、出站是 Conversation 的事。
// - 「未知结果不重发」：prompt / steer 拿不到确定结果时返回 outcome=unknown，调用方不得自动重试。
// - 能力只来自协商结果和方言声明，不按 provider 名称写死（docs/api/capabilities.md）。

import type { JsonValue } from '../../domain/identity/index.js'
import type { GoalState } from '../../generated/protocol/v1_2/goal-state.js'
import type { ProtocolModelCatalog } from '../../generated/protocol/v1_2/model-catalog.js'
import type { ProtocolPermissionCatalog } from '../../generated/protocol/v1_2/permission-catalog.js'
import type { PlanDocument } from '../../generated/protocol/v1_2/plan-document.js'

// ---------------------------------------------------------------------------------------------
// 基础词汇
// ---------------------------------------------------------------------------------------------

/**
 * Runtime 种类，取值必须与 v2 的 runtime_type 完全一致（会话 ID、Timeline ID 都以它为输入）：
 * `codex`、`claude`、`pi`、`hermes`、`dsh`，以及官方 ACP Agent 的 `opencode`、`antigravity`、`codebuddy`、
 * `commandcode`、`mimo`、`minimax` 等。
 */
export type RuntimeType = 'codex' | 'claude' | 'pi' | 'hermes' | 'dsh' | (string & {})

export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * AA 能力 ID（docs/api/capabilities.md、04-connector.md §5.1）。保留 string 以便方言声明新能力，
 * 但已知 ID 要用这里的字面量，便于检索。
 */
export type CapabilityId =
  | 'session.send_message'
  | 'session.steer'
  | 'session.interrupt'
  | 'session.queue'
  | 'session.interaction.approval'
  | 'session.interaction.form'
  | 'session.commands'
  | 'session.planning'
  | 'session.plan_document'
  | 'session.plan_review'
  | 'session.goal'
  | 'session.configuration.read'
  | 'session.configuration.update'
  | 'session.fork'
  | 'session.archive'
  | 'session.rename'
  | 'session.list'
  | 'session.history.native'
  | 'runtime.attachment'
  | 'catalog.model'
  | 'catalog.effort'
  | 'catalog.permission'
  | (string & {})

export interface Capability {
  readonly id: CapabilityId
  /** Runtime 是否具备（协商 + 方言）。 */
  readonly supported: boolean
  /** 当前状态下能否使用（会话忙、写者不是自己等）。缺省等于 supported。 */
  readonly available?: boolean
  readonly unavailableReason?: string
  /** 能力参数，例如附件允许的 MIME。 */
  readonly parameters?: JsonObject
}

export interface RuntimeCapabilities {
  /** 每次能力变化递增，Conversation 用它判断是否要重发能力事件。 */
  readonly revision: number
  readonly items: readonly Capability[]
}

export type SessionCapabilities = RuntimeCapabilities

/** 稳定错误码，取值见 contracts/runtime-errors。 */
export interface RuntimeError {
  readonly code: string
  readonly message: string
  /** 是否值得由用户手动重试；适配器从不自动重试结果未知的写操作。 */
  readonly retryable?: boolean
  readonly details?: JsonObject
}

// ---------------------------------------------------------------------------------------------
// Provider 与实例
// ---------------------------------------------------------------------------------------------

export interface RuntimeProvider {
  readonly type: RuntimeType
  /** 是否安装、版本、配置 schema、实例策略；不启动任何长寿命进程。 */
  discover(): Promise<ProviderFacts>
  start(instance: RuntimeInstanceConfig): Promise<RuntimeHandle>
}

export interface ProviderFacts {
  readonly type: RuntimeType
  readonly displayName: string
  readonly installed: boolean
  /** 适配器版本，例如 codex-acp 2.6.0。 */
  readonly adapterVersion?: string
  /** 被驱动的 Agent 版本，例如 Codex CLI 0.163.0、Claude Code 2.1.x。 */
  readonly agentVersion?: string
  /** 设备详情里显示的其它版本，例如 Codex App 版本。 */
  readonly extraVersions?: Readonly<Record<string, string>>
  /** 没装、凭据缺失、版本太旧等，给用户看的原因。 */
  readonly problems: readonly RuntimeError[]
  /** 实例配置的 JSON Schema；只允许 Profile 定义的字段，不能有任意 command/args/env。 */
  readonly configSchema?: JsonObject
  /** 一台设备上能开几个实例。 */
  readonly instancePolicy: 'single' | 'multiple'
  /** 适配器进程是所有会话共用还是每会话一个。 */
  readonly processScope: 'shared' | 'perSession'
}

export interface RuntimeInstanceConfig {
  /** 实例 ID（具名实例有自己的会话 namespace，见 domain/identity sessionNamespace）。 */
  readonly instanceId: string
  readonly sessionNamespace: string
  /** 只含 configSchema 允许的字段。 */
  readonly settings: JsonObject
  /** 模型网关：由 Profile 注入为环境变量或配置，不经实例配置透传任意 env。 */
  readonly modelGateway?: ModelGatewayConfig
}

export interface ModelGatewayConfig {
  readonly baseUrl: string
  readonly authToken: string
  readonly protocol: 'anthropic' | 'openai-responses' | 'openai-chat'
  readonly model?: string
}

export interface RuntimeHandle {
  readonly type: RuntimeType
  readonly instanceId: string
  /** 运行时级能力（会话级能力在 RuntimeSession.capabilities）。 */
  capabilities(): RuntimeCapabilities
  catalogs(): Promise<Catalogs>
  /** 原生会话目录（Codex 线程、Claude/Pi 本机会话…）。 */
  listNativeSessions(cursor?: string): Promise<NativeSessionPage>
  /** 只读历史：不 resume、不抢写锁、不往原生记录追加内容。 */
  readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage>
  /** 打开（新建或附着）一个会话。 */
  open(target: OpenTarget, options: OpenOptions): Promise<RuntimeSession>
  /** 运行时级事件：原生会话目录变化、运行时状态、跟随建议等。 */
  readonly events: AsyncIterable<RuntimeHandleEvent>
  /**
   * 释放原生会话的外部持有者（Codex：退出占着线程的 Codex App）。有它时能力 `runtime.owner_release` 为 supported。
   * 两步：先拟定计划给用户看，用户在触发它的 AA 会话里明确同意后才执行。
   */
  readonly ownerRelease?: OwnerReleasePort
  stop(): Promise<void>
}

/**
 * 释放外部持有者：会话层确认（在哪个 AA 会话里触发，就在哪个会话里确认）。打开已有会话失败、错误
 * `details.ownerRelease === 'available'` 时，会话引擎调 `prepare`，把计划作为该会话里的确认交给客户端展示；
 * 用户同意后调 `execute`，然后重新打开；用户拒绝或离开时调 `discard`。
 */
export interface OwnerReleasePort {
  prepare(ref: NativeSessionRef, context: { readonly sessionId: string }): Promise<OwnerReleasePrepareResult>
  /** 只能在用户对这份计划明确同意之后调用。`force`：宽限期后仍未退出时允许强制结束（要单独征得同意）。 */
  execute(planId: string, consent: { readonly force: boolean }): Promise<OwnerReleaseOutcome>
  discard(planId: string): void
}

export type OwnerReleasePrepareResult =
  | { readonly status: 'plan'; readonly plan: OwnerReleasePlan }
  /** 已经可以打开（可以跟随，或没人持有），不需要释放。 */
  | { readonly status: 'not_needed' }
  | { readonly status: 'unavailable'; readonly reason: 'owner_not_running' | 'platform_unsupported' | 'process_table_unavailable' }

export interface OwnerReleasePlan {
  readonly planId: string
  /** 触发它的 AA 会话；确认只在这个会话里展示。 */
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly expiresAt: number
  /** 要结束的持有者（展示用）。 */
  readonly owner: { readonly displayName: string; readonly processCount: number }
  /** 持有者里其它正在使用的会话也会一起被释放（Codex App 的所有线程）。 */
  readonly releasesOtherSessions: boolean
  /** 宽限期（毫秒）：先请求正常退出，超时后才需要强制。 */
  readonly gracePeriodMs: number
  /** Runtime 专属的细节（进程 PID、写锁状态），客户端不依赖它的形状。 */
  readonly details?: JsonObject
}

export interface OwnerReleaseOutcome {
  readonly status:
    | 'released' | 'already_released'
    /** 计划过期、已用过或进程变了：重新 prepare 并再次征得同意。 */
    | 'plan_expired' | 'plan_changed'
    /** 宽限期后仍未退出，且没有同意强制。 */
    | 'survivors'
    /** 进程退出了，但会话仍被持有。 */
    | 'still_held'
  readonly details?: JsonObject
}

export interface Catalogs {
  readonly models?: ProtocolModelCatalog
  readonly permissions?: ProtocolPermissionCatalog
  /** 当前选择（selection ID，规则见 domain/identity selection）。 */
  readonly selections?: Readonly<Record<string, string | null>>
}

export type RuntimeHandleEvent =
  | { readonly type: 'status'; readonly status: 'starting' | 'ready' | 'degraded' | 'stopped'; readonly error?: RuntimeError }
  | { readonly type: 'native_sessions.changed'; readonly sessions: readonly NativeSessionSummary[]; readonly removed: readonly string[] }
  /** 伴随层发现应当接管的原生会话（例如 Codex App 新开的线程）。由会话引擎决定是否 open。 */
  | { readonly type: 'native_session.follow_suggested'; readonly ref: NativeSessionRef; readonly reason: string }
  | { readonly type: 'capabilities.changed'; readonly capabilities: RuntimeCapabilities }
  | { readonly type: 'catalogs.changed'; readonly catalogs: Catalogs }

// ---------------------------------------------------------------------------------------------
// 原生会话与历史
// ---------------------------------------------------------------------------------------------

export interface NativeSessionRef {
  /** Runtime 自己的会话 ID（Codex threadId、Claude session uuid、ACP sessionId）。 */
  readonly nativeSessionId: string
  /** 原生记录位置，用于 Pi 这类按文件区分的 Runtime。 */
  readonly locator?: string
}

export interface NativeSessionSummary extends NativeSessionRef {
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly archived?: boolean
  /** 有别的写者（终端里的 CLI、Codex App）正在使用。 */
  readonly inUse?: boolean
  /** 写者是谁：本 Connector、外部（App/CLI）、无人、未知。 */
  readonly writer?: WriterState
  /** AA 自己（含 v2）创建或用过的会话。 */
  readonly ownedByAgentsAnywhere?: boolean
}

export interface NativeSessionPage {
  readonly sessions: readonly NativeSessionSummary[]
  readonly nextCursor?: string
}

export interface HistoryWindow {
  /** 不给时从最新一页开始。 */
  readonly cursor?: string
  readonly limit: number
  readonly direction?: 'older' | 'newer'
}

export interface NativeHistoryPage {
  /** 已按 v2 规则算好 ID 的历史条目，顺序从旧到新。 */
  readonly items: readonly HistoryItem[]
  readonly olderCursor?: string
  readonly newerCursor?: string
}

/** 历史条目与实时事件共用同一套条目形状，ID 规则一致（同一条内容回放后 ID 不变）。 */
export type HistoryItem = TimelineItemEvent

// ---------------------------------------------------------------------------------------------
// 打开会话
// ---------------------------------------------------------------------------------------------

export type OpenTarget =
  | { readonly kind: 'new'; readonly spec: NewSessionSpec }
  | { readonly kind: 'existing'; readonly ref: NativeSessionRef }

export interface NewSessionSpec {
  readonly cwd: string
  readonly title?: string
  /** 初始选择（模型、权限、思考强度、计划模式），selection ID。 */
  readonly selections?: Readonly<Record<string, string | null>>
  /** 支持指定原生 ID 的 Runtime（DSH 插件路由）用它；不支持的忽略。 */
  readonly preferredNativeSessionId?: string
  readonly additionalDirectories?: readonly string[]
}

export interface OpenOptions {
  /** AA 平台会话 ID（domain/identity session）。 */
  readonly sessionId: string
  /**
   * 附着已有会话时是否回放历史到 events：
   * - none：只接上，之后的实时事件照常推送；
   * - full：先推完整历史（HistoryItem），再推实时事件。
   */
  readonly replay: 'none' | 'full'
  /** 本地库里已有的最后一个原生条目，用于增量回放（支持时）。 */
  readonly replayAfter?: string
}

// ---------------------------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------------------------

export interface RuntimeSession {
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly capabilities: SessionCapabilities
  /** 发一条消息并开始一个回合。在 Runtime 接纳（或确定拒绝、或结果未知）时返回，不等回合结束。 */
  prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance>
  /** 运行中追加输入。没有 session.steer 能力时不存在。 */
  steer?(input: PromptInput, delivery: DeliveryRef): Promise<SteerResult>
  /** 中断当前回合；expectedTurnId 不匹配时不误伤后续回合。 */
  cancel(expectedTurnId?: string): Promise<void>
  /** 回答审批、表单、计划审阅、提问。 */
  respond(interactionId: string, answer: InteractionAnswer): Promise<void>
  /** 改模型、权限、模式、思考强度等配置项。 */
  configure(change: ConfigChange): Promise<ConfigResult>
  /** 斜杠命令，例如 /compact。 */
  command(name: string, args?: string): Promise<CommandResult>
  readonly goal?: GoalPort
  readonly planning?: PlanningPort
  /** 已翻译成内部事件的流；会话关闭后结束。 */
  readonly events: AsyncIterable<RuntimeEvent>
  /** 释放会话（不删除原生记录）。 */
  close(): Promise<void>
}

export interface PromptInput {
  readonly text: string
  readonly attachments?: readonly PromptAttachment[]
}

export type PromptAttachment = (
  /** 本机文件：Connector 已下载到本地；Codex 等支持本地路径的 Runtime 直接用路径，避免 data URL 撑大原生记录。 */
  | { readonly kind: 'file'; readonly path: string; readonly mimeType: string; readonly name?: string }
  | { readonly kind: 'inline'; readonly data: string; readonly mimeType: string; readonly name?: string }
  | { readonly kind: 'link'; readonly uri: string; readonly name?: string; readonly mimeType?: string }
) & {
  /**
   * 这个附件在平台上的身份（来自客户端上传记录）。能把它写进原生记录的 Runtime（Pi 写进用户消息的
   * `aaAttachments`）会写进去，之后读历史、重放时就能还原出 Timeline 上的附件。
   */
  readonly info?: AttachmentInfo
}

/** 平台附件：v2 Timeline 用户消息 `content.attachments[]` 的形状（不含本机路径）。 */
export interface AttachmentInfo {
  readonly fileId: string
  readonly name: string
  readonly mediaType: string
  readonly size?: number
  readonly sha256?: string
}

/** 投递记录：用于幂等、接纳判定和用户消息 Timeline ID。 */
export interface DeliveryRef {
  readonly deliveryId: string
  /** 客户端生成的消息 ID（v2 client_message_id）。 */
  readonly clientMessageId: string
}

export type PromptAcceptance =
  | { readonly outcome: 'accepted'; readonly turnId?: string; readonly userItemId?: string }
  | { readonly outcome: 'rejected'; readonly error: RuntimeError }
  /** 已发出但无法确认是否被接纳（超时、进程退出）。调用方不得自动重发。 */
  | { readonly outcome: 'unknown'; readonly error: RuntimeError }

export type SteerResult =
  | { readonly outcome: 'injected'; readonly turnId?: string; readonly userItemId?: string }
  /** Runtime 当时已空闲，把这条输入作为新回合开始了。 */
  | { readonly outcome: 'started_new_turn'; readonly turnId?: string; readonly userItemId?: string }
  /** Runtime 已空闲且不会自己开新回合：调用方应改用 prompt（或放回队列）。 */
  | { readonly outcome: 'prompt_required' }
  | { readonly outcome: 'rejected'; readonly error: RuntimeError }
  | { readonly outcome: 'unknown'; readonly error: RuntimeError }

export type InteractionAnswer =
  /** 审批：选择 Runtime 提供的某个选项。 */
  | { readonly kind: 'option'; readonly optionId: string }
  /** 表单 / 提问。 */
  | { readonly kind: 'form'; readonly action: 'accept' | 'decline' | 'cancel'; readonly values?: JsonObject }
  /** 计划审阅：同意并执行、修改计划（附意见）、暂不执行。 */
  | { readonly kind: 'plan_review'; readonly action: 'approve' | 'revise' | 'dismiss'; readonly feedback?: string; readonly planContentHash?: string }
  /** 取消（用户关闭了对话框或会话被中断）。 */
  | { readonly kind: 'cancelled' }

export interface ConfigChange {
  /** 配置项 ID（Runtime 的原生 ID，来自 config.updated 事件）。 */
  readonly optionId: string
  readonly value: string | boolean
}

export interface ConfigResult {
  readonly options: readonly ConfigOption[]
  /** 回合进行中修改时，部分 Runtime 下一回合才生效。 */
  readonly appliesFrom: 'now' | 'next_turn'
}

export interface ConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** 映射到 AA 目录：model / effort / permission / mode / collaboration_mode / other。 */
  readonly category: 'model' | 'effort' | 'permission' | 'mode' | 'collaboration_mode' | 'other'
  readonly type: 'select' | 'boolean'
  readonly currentValue: string | boolean
  readonly values?: readonly { readonly value: string; readonly name: string; readonly description?: string; readonly group?: string }[]
}

export interface CommandResult {
  readonly ok: boolean
  readonly message?: string
  readonly error?: RuntimeError
}

export interface GoalPort {
  get(): Promise<GoalState | null>
  set(objective: string, options?: { readonly tokenBudget?: number }): Promise<GoalState>
  pause(): Promise<GoalState>
  resume(): Promise<GoalState>
  clear(): Promise<void>
}

export interface PlanningPort {
  /** 进入或退出计划模式。 */
  setMode(mode: 'plan' | 'normal'): Promise<void>
  /** 当前计划模式与最新计划文档。 */
  current(): Promise<{ readonly mode: 'plan' | 'normal' | 'unknown'; readonly document?: PlanDocument }>
}

// ---------------------------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------------------------

interface EventBase {
  /** 所属回合（Runtime 的原生回合 ID，或适配器生成的稳定 ID）。 */
  readonly turnId?: string
  /** 历史回放里的事件为 true；实时事件不填。 */
  readonly replay?: boolean
}

export type MessageRole = 'user' | 'assistant' | 'reasoning'

export type ToolKind =
  | 'command' | 'file_change' | 'read' | 'search' | 'fetch' | 'web_search' | 'mcp' | 'agent_call' | 'think' | 'other'

export type ToolStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ToolLocation {
  readonly path: string
  readonly line?: number
}

export type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'diff'; readonly path: string; readonly oldText?: string; readonly newText: string }
  | { readonly type: 'terminal'; readonly terminalId: string; readonly output?: string; readonly exitCode?: number | null }
  | { readonly type: 'image'; readonly mimeType: string; readonly data?: string; readonly uri?: string }

/** 落到 Timeline 条目上的事件：带好 v2 规则的条目 ID。 */
export type TimelineItemEvent =
  | (EventBase & {
      readonly type: 'message.delta'
      readonly itemId: string
      readonly role: MessageRole
      /** 追加的文本；同一 itemId 的增量按到达顺序拼接。 */
      readonly text: string
      readonly clientMessageId?: string
    })
  | (EventBase & {
      /** 整条消息（历史回放、或 Runtime 只给最终文本时）。替换同 itemId 已有内容。 */
      readonly type: 'message.completed'
      readonly itemId: string
      readonly role: MessageRole
      readonly text: string
      readonly clientMessageId?: string
      readonly attachments?: readonly PromptAttachment[]
      /**
       * 已是 Timeline 形状的附件（v2 `content.attachments`）。给出时 Conversation 用它填 content.attachments，
       * 不用 attachments（后者可能带本机路径）。原生历史里的附件只有这一种形状。
       */
      readonly timelineAttachments?: readonly AttachmentInfo[]
      /**
       * 这条消息的结局（v2 Pi：模型报错为 failed、被中断为 cancelled）。缺省 done。
       * 历史回放与实时一样带：同一条原生消息无论从哪条路径来都是同一个状态。
       */
      readonly status?: 'done' | 'failed' | 'cancelled'
    })
  | (EventBase & {
      readonly type: 'tool.started'
      readonly itemId: string
      readonly toolCallId: string
      readonly kind: ToolKind
      readonly title: string
      readonly status: ToolStatus
      readonly input?: JsonValue
      readonly content?: readonly ToolContent[]
      readonly locations?: readonly ToolLocation[]
    })
  | (EventBase & {
      /** 只带变化的字段；content 给出时整体替换。 */
      readonly type: 'tool.updated'
      readonly itemId: string
      readonly toolCallId: string
      readonly title?: string
      readonly kind?: ToolKind
      readonly status?: ToolStatus
      readonly input?: JsonValue
      readonly output?: JsonValue
      readonly content?: readonly ToolContent[]
      readonly locations?: readonly ToolLocation[]
    })
  | (EventBase & {
      /** 系统提示：压缩、模型改派、重试中、警告等。 */
      readonly type: 'notice'
      readonly itemId: string
      readonly level: 'info' | 'warning' | 'error'
      readonly kind: 'compact' | 'model_request_retry' | 'model_rerouted' | 'warning' | 'error' | 'other'
      readonly text: string
      readonly data?: JsonObject
    })

export type InteractionKind = 'approval' | 'form' | 'plan_review' | 'question'

export interface InteractionOption {
  readonly id: string
  readonly label: string
  /** 映射自 ACP PermissionOptionKind。 */
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other'
}

export type RuntimeEvent =
  | TimelineItemEvent
  | (EventBase & {
      readonly type: 'turn.started'
      readonly turnId: string
      /** 用户发起、或 Runtime 自主开始（定时唤醒、后台任务结束、Codex App 里发的消息）。 */
      readonly origin: 'user' | 'autonomous' | 'external'
      readonly clientMessageId?: string
    })
  | (EventBase & {
      readonly type: 'turn.ended'
      readonly turnId: string
      readonly reason: 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'failed' | 'unknown'
      readonly error?: RuntimeError
    })
  | (EventBase & {
      readonly type: 'interaction.opened'
      readonly interactionId: string
      readonly kind: InteractionKind
      readonly title: string
      readonly body?: string
      /** 关联的工具条目（审批时）。 */
      readonly itemId?: string
      readonly options?: readonly InteractionOption[]
      /** 表单 JSON Schema（form / question）。 */
      readonly schema?: JsonObject
      /** 计划审阅时的计划文档。 */
      readonly plan?: PlanDocument
    })
  | (EventBase & {
      /** 交互已被处理（任一端回答、Runtime 撤回、回合结束）。 */
      readonly type: 'interaction.resolved'
      readonly interactionId: string
      readonly resolution: 'answered' | 'withdrawn' | 'expired'
      readonly answeredBy?: 'self' | 'external'
    })
  | (EventBase & {
      /** 清单式计划（ACP plan / plan_update 的 checklist）。 */
      readonly type: 'plan.updated'
      readonly planId: string
      readonly entries: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed'; readonly priority?: 'high' | 'medium' | 'low' }[]
      /** Markdown 计划文档（计划模式下产出）。 */
      readonly document?: PlanDocument
    })
  | (EventBase & { readonly type: 'planning.mode_changed'; readonly mode: 'plan' | 'normal' })
  | (EventBase & { readonly type: 'goal.updated'; readonly goal: GoalState | null })
  | (EventBase & { readonly type: 'config.updated'; readonly options: readonly ConfigOption[] })
  | (EventBase & {
      readonly type: 'commands.updated'
      readonly commands: readonly { readonly name: string; readonly description?: string; readonly inputHint?: string }[]
    })
  | (EventBase & { readonly type: 'session.info'; readonly title?: string; readonly updatedAt?: string })
  | (EventBase & {
      readonly type: 'usage.updated'
      readonly usedTokens?: number
      readonly contextWindow?: number
      readonly cost?: { readonly amount: number; readonly currency: string }
    })
  | (EventBase & { readonly type: 'capabilities.changed'; readonly capabilities: SessionCapabilities })
  /**
   * 历史整体替换（Codex 编辑最后一轮、回滚、owner 重排）：begin 之后到 commit 之间的条目事件是
   * 新的完整历史；abort 时丢弃。对应 Conversation 的完整替换 + resetSeq。
   */
  | (EventBase & { readonly type: 'history.reset'; readonly phase: 'begin' | 'commit' | 'abort'; readonly revision: string })
  /** 写者变化：AA 持有、外部（Codex App / DSH Desktop / 终端）持有、无人、未知。 */
  | (EventBase & { readonly type: 'writer.changed'; readonly writer: WriterState })
  /** 后台任务（Claude 后台命令、Codex 后台终端、子 Agent）的状态。 */
  | (EventBase & {
      readonly type: 'background.updated'
      readonly taskId: string
      readonly kind: 'command' | 'subagent' | 'other'
      readonly title: string
      readonly state: 'running' | 'requires_action' | 'idle' | 'completed' | 'failed' | 'stopped'
    })
  /** 适配器进程退出或连接断开；会话需重新 open 才能继续。 */
  | (EventBase & { readonly type: 'session.lost'; readonly error: RuntimeError })

export interface WriterState {
  readonly holder: 'self' | 'external' | 'none' | 'unknown'
  /** external 时是谁，例如 `codex-app`、`dsh-desktop`、`terminal`。 */
  readonly by?: string
  /** 当前是否在执行（外部写者在跑回合时为 running）。 */
  readonly execution?: 'idle' | 'running' | 'waiting_for_input' | 'unknown'
}
