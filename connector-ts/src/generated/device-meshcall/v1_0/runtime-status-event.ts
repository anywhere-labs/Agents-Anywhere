/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact runtime-status-event. Do not edit; run `yarn contracts:generate`. */

export type Allowed = boolean
export type Available = boolean
export type Capabilityid = string
export type Runtime = string | null
export type Scope = "runtime" | "session"
export type Sessionid = string | null
export type Supported = boolean
export type Unavailablereason = string | null
export type Version = string
export type Capabilities = ProtocolCapability[]
export type Revision = number
export type Runtimeid = string
export type Sessionid1 = string | null
export type Status =
  | RuntimeTypesStatus
  | RuntimeInstanceStatus
  | RuntimeHealthStatus
  | CapabilitiesChangedStatus
  | CatalogsChangedStatus
  | SessionStatusChanged
  | ConfigUpdatedStatus
  | CommandsUpdatedStatus
  | WriterChangedStatus
  | UsageUpdatedStatus
  | BackgroundUpdatedStatus
  | PlanningStateUpdated
  | GoalStateUpdated
export type Event = "runtime.types"
export type Features = string[]
export type Available1 = boolean
export type Revision1 = number
export type Uischema = {
  [k: string]: unknown
} | null
export type Description = string | null
export type Displayname = string
export type Implementationtype = string | null
export type Instancepolicy = "single" | "multiple"
export type Maturity = ("experimental" | "beta" | "stable") | null
export type Maxinstances = number | null
export type Apply = "immediate" | "new_session" | "restart"
export type Auto = boolean
export type Manual = boolean
export type Required = boolean
export type Configfield = string
export type Maturity1 = "experimental" | "beta" | "stable"
export type Modefield = string | null
export type Modelfield = string | null
export type Modelsfield = string | null
/**
 * @maxItems 16
 */
export type Modes =
  | []
  | [ModelConnectionMode]
  | [ModelConnectionMode, ModelConnectionMode]
  | [ModelConnectionMode, ModelConnectionMode, ModelConnectionMode]
  | [ModelConnectionMode, ModelConnectionMode, ModelConnectionMode, ModelConnectionMode]
  | [ModelConnectionMode, ModelConnectionMode, ModelConnectionMode, ModelConnectionMode, ModelConnectionMode]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
  | [
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
      ModelConnectionMode,
    ]
export type Id = string
export type Reason = string | null
export type Supported1 = boolean
/**
 * @minItems 1
 * @maxItems 8
 */
export type Protocols =
  | ["openai_responses" | "openai_chat" | "anthropic"]
  | ["openai_responses" | "openai_chat" | "anthropic", "openai_responses" | "openai_chat" | "anthropic"]
  | [
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
    ]
  | [
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
    ]
  | [
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
    ]
  | [
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
    ]
  | [
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
    ]
  | [
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
      "openai_responses" | "openai_chat" | "anthropic",
    ]
export type Scope1 = "instance" | "session" | "native_global"
export type Reason1 = string | null
export type Recommendationrank = number | null
export type Recommended = boolean
export type Runtimetype = string
export type Runtimetypes = RuntimeTypeDescriptor[]
export type Enabled = boolean | null
export type Code = string
export type Message = string
export type Retryable = boolean
export type Installed = boolean | null
export type Modelconnection = {
  [k: string]: unknown
} | null
export type Phase = {
  [k: string]: unknown
} | null
export type Status1 = string
export type Runtimetype1 = string | null
export type State = string
export type Event1 = "capabilities.changed"
export type Commands = SlashCommand[] | null
export type Description1 = string | null
export type Inputhint = string | null
export type Name = string
export type Default = boolean
export type Description2 = string | null
export type Displayname1 = string
export type Displayname2 = string
export type Id1 = string
export type Itemdisplayname = string | null
export type Id2 = string
export type Default1 = boolean
export type Description3 = string | null
export type Displayname3 = string
export type Fullmodelid = string | null
export type Id3 = string
export type Selectionid = string
export type Reasoningitems = ProtocolReasoningItem[]
export type Selectionid1 = string | null
export type Models = ProtocolModelItem[]
export type Revision2 = number
export type Runtime1 = string
export type Default2 = boolean
export type Description4 = string | null
export type Displayname4 = string
export type Id4 = string
export type Selectionid2 = string
export type Permissions = ProtocolPermissionItem[]
export type Revision3 = number
export type Runtime2 = string
export type Selections = {
  [k: string]: unknown
} | null
export type Event2 = "catalogs.changed"
export type Event3 = "session.status"
export type Status2 =
  "idle" | "pending" | "running" | "waiting" | "waiting_approval" | "blocked" | "stopping" | "error" | "unknown"
export type Event4 = "config.updated"
export type Options = {
  [k: string]: unknown
}[]
export type Commands1 = SlashCommand[]
export type Event5 = "commands.updated"
export type Event6 = "writer.changed"
export type By = string | null
export type Execution = ("idle" | "running" | "waiting_for_input" | "unknown") | null
export type Holder = "self" | "external" | "none" | "unknown"
export type Contextwindow = number | null
export type Amount = number
export type Currency = string
export type Event7 = "usage.updated"
export type Usedtokens = number | null
export type Event8 = "background.updated"
export type Kind = "command" | "subagent" | "other"
export type State1 = "running" | "requires_action" | "idle" | "completed" | "failed" | "stopped"
export type Taskid = string
export type Title = string
export type Event9 = "planning.state.updated"
export type Revision4 = number
export type Actions = (
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
)[]
export type Contentstreaming = "native_delta" | "final_only"
export type Reason2 = string | null
export type Supported2 = boolean
export type Content = string
export type Contentstate = "drafting" | "failed" | "interrupted"
export type Draftid = string
export type Planid = string
export type Revision5 = number
export type Seq = number
export type Effectivemode = "plan" | "normal" | "unknown"
export type Epoch = string
export type Execution1 = {
  [k: string]: unknown
} | null
export type Executionprogress = {
  [k: string]: unknown
} | null
export type Freshness = "fresh" | "stale" | "unknown"
export type Operation = {
  [k: string]: unknown
} | null
export type Contenthash = string
export type Contentstate1 = "ready"
export type Createdat = string | null
export type Markdown = string
export type Planid1 = string
export type Revision6 = number
export type Sourceturnid = string | null
export type Title1 = string
export type Proposals = PlanDocument[]
export type Requestedmode = ("plan" | "normal") | null
export type Actions1 = (
  "enter_plan" | "exit_plan" | "submit_task" | "approve_and_execute" | "request_revision" | "dismiss_review"
)[]
export type Contenthash1 = string
export type Planid2 = string
export type Planrevision = number
export type Reviewid = string
export type Status3 = "open" | "responding" | "approved" | "revision_requested" | "dismissed" | "withdrawn" | "unknown"
export type Revision7 = number
export type Runtime3 = string
export type Runtimeid1 = string | null
export type Sessionid2 = string
export type Event10 = "goal.state.updated"
export type Revision8 = number
export type Bindinggeneration = number
export type Actions2 = ("set" | "edit" | "pause" | "resume" | "clear")[]
export type Reason3 = string | null
export type Supported3 = boolean
export type Externalsessionid = string | null
export type Freshness1 = "fresh" | "stale" | "unknown"
export type Createdat1 = string
export type Endedat = string | null
export type Id5 = string
export type Iterations = number | null
export type Lastreason = string | null
export type Objective = string
export type Sourceturnid1 = string | null
export type Status4 =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete" | "failed" | "cleared" | "replaced"
export type Timeusedseconds = number | null
export type Tokenbudget = number | null
export type Tokensused = number | null
export type Updatedat = string
export type Pendingoperationid = string | null
export type Revision9 = number
export type Runtime4 = string
export type Runtimeid2 = string | null
export type Sessionid3 = string
export type Sourceepoch = string
export type Sourcerevision = number

/**
 * ``runtime.status``: what the device reports about a Runtime instance (``runtimeId: "*"`` for the
 * device's Runtime types) or one of its sessions (``sessionId``).
 */
export interface RuntimeStatusEvent {
  capabilities?: ProtocolCapabilitySet | null
  runtimeId: Runtimeid
  sessionId?: Sessionid1
  status: Status
  [k: string]: unknown
}
export interface ProtocolCapabilitySet {
  capabilities?: Capabilities
  revision: Revision
  [k: string]: unknown
}
export interface ProtocolCapability {
  allowed?: Allowed
  available?: Available
  capabilityId: Capabilityid
  parameters?: Parameters
  runtime?: Runtime
  scope?: Scope
  sessionId?: Sessionid
  supported?: Supported
  unavailableReason?: Unavailablereason
  version?: Version
  [k: string]: unknown
}
export interface Parameters {
  [k: string]: unknown
}
/**
 * The Runtime types this device build ships (``runtimeId: "*"``); replaces discovery.
 */
export interface RuntimeTypesStatus {
  event: Event
  features?: Features
  runtimeTypes?: Runtimetypes
  [k: string]: unknown
}
/**
 * Runtime Control 2.0 provider-owned discovery facts.
 */
export interface RuntimeTypeDescriptor {
  available: Available1
  capabilities: Capabilities1
  configSchema: RuntimeConfigSchemaDescriptor | null
  description: Description
  displayName: Displayname
  implementationType: Implementationtype
  instancePolicy: Instancepolicy
  maturity?: Maturity
  maxInstances: Maxinstances
  metadata: Metadata1
  modelConnection?: ModelConnectionCapability | null
  reason: Reason1
  recommendationRank: Recommendationrank
  recommended: Recommended
  runtimeType: Runtimetype
}
export interface Capabilities1 {
  [k: string]: boolean
}
export interface RuntimeConfigSchemaDescriptor {
  defaults: Defaults
  metadata: Metadata
  revision: Revision1
  schema: Schema
  uiSchema: Uischema
}
export interface Defaults {
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface Schema {
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
/**
 * What a runtime adapter declares about taking a model connection.
 */
export interface ModelConnectionCapability {
  apply: Apply
  catalog: ModelConnectionCatalog
  configField: Configfield
  maturity: Maturity1
  modeField?: Modefield
  modelField?: Modelfield
  modelsField?: Modelsfield
  modes?: Modes
  protocols: Protocols
  scope: Scope1
}
export interface ModelConnectionCatalog {
  auto: Auto
  manual: Manual
  required?: Required
}
export interface ModelConnectionMode {
  id: Id
  reason?: Reason
  supported: Supported1
}
/**
 * An instance after the device applied desired state, with the provider's facts beside it.
 */
export interface RuntimeInstanceStatus {
  enabled?: Enabled
  error?: LinkError | null
  installed?: Installed
  instance: RuntimeInstanceReport
  runtimeType?: Runtimetype1
  [k: string]: unknown
}
export interface LinkError {
  code: Code
  message?: Message
  retryable?: Retryable
  [k: string]: unknown
}
export interface RuntimeInstanceReport {
  error?: LinkError | null
  modelConnection?: Modelconnection
  phase?: Phase
  status: Status1
  [k: string]: unknown
}
/**
 * The running instance's own health (``ready``, ``degraded``, …).
 */
export interface RuntimeHealthStatus {
  error?: LinkError | null
  state: State
  [k: string]: unknown
}
/**
 * The capability set of the instance (no ``sessionId``) or of one session changed; the set is
 * ``RuntimeStatusEvent.capabilities`` (``scope: "session"`` items for a session).
 */
export interface CapabilitiesChangedStatus {
  event: Event1
  [k: string]: unknown
}
export interface CatalogsChangedStatus {
  catalogs?: SessionCatalogs
  event: Event2
  [k: string]: unknown
}
/**
 * A session's catalogs: models, permissions, slash commands and the current selections.
 */
export interface SessionCatalogs {
  commands?: Commands
  models?: ProtocolModelCatalog | null
  permissions?: ProtocolPermissionCatalog | null
  selections?: Selections
  [k: string]: unknown
}
export interface SlashCommand {
  description?: Description1
  inputHint?: Inputhint
  name: Name
  [k: string]: unknown
}
export interface ProtocolModelCatalog {
  models?: Models
  revision: Revision2
  runtime: Runtime1
  [k: string]: unknown
}
export interface ProtocolModelItem {
  default?: Default
  description?: Description2
  displayName: Displayname1
  group?: ProtocolModelGroup | null
  id: Id2
  metadata?: Metadata2
  reasoningItems?: Reasoningitems
  selectionId?: Selectionid1
  [k: string]: unknown
}
/**
 * Where a model is routed from, e.g. a DSH provider or relay.
 */
export interface ProtocolModelGroup {
  displayName: Displayname2
  id: Id1
  itemDisplayName?: Itemdisplayname
  [k: string]: unknown
}
export interface Metadata2 {
  [k: string]: unknown
}
export interface ProtocolReasoningItem {
  default?: Default1
  description?: Description3
  displayName: Displayname3
  fullModelId?: Fullmodelid
  id: Id3
  metadata?: Metadata3
  selectionId: Selectionid
  [k: string]: unknown
}
export interface Metadata3 {
  [k: string]: unknown
}
export interface ProtocolPermissionCatalog {
  permissions?: Permissions
  revision: Revision3
  runtime: Runtime2
  [k: string]: unknown
}
export interface ProtocolPermissionItem {
  default?: Default2
  description?: Description4
  displayName: Displayname4
  id: Id4
  metadata?: Metadata4
  selectionId: Selectionid2
  [k: string]: unknown
}
export interface Metadata4 {
  [k: string]: unknown
}
export interface SessionStatusChanged {
  event: Event3
  status: Status2
  [k: string]: unknown
}
/**
 * The session's Agent configuration options changed.
 */
export interface ConfigUpdatedStatus {
  event: Event4
  options?: Options
  [k: string]: unknown
}
/**
 * The session's slash commands as its Runtime reported them last (the whole list).
 */
export interface CommandsUpdatedStatus {
  commands?: Commands1
  event: Event5
  [k: string]: unknown
}
export interface WriterChangedStatus {
  event: Event6
  writer: RuntimeWriter
  [k: string]: unknown
}
/**
 * Who writes to the session: this device (``self``), another program (``external``), nobody or unknown.
 */
export interface RuntimeWriter {
  by?: By
  execution?: Execution
  holder: Holder
  [k: string]: unknown
}
/**
 * The session's context usage as its Runtime reported it last.
 */
export interface UsageUpdatedStatus {
  contextWindow?: Contextwindow
  cost?: RuntimeUsageCost | null
  event: Event7
  usedTokens?: Usedtokens
  [k: string]: unknown
}
export interface RuntimeUsageCost {
  amount: Amount
  currency: Currency
  [k: string]: unknown
}
/**
 * One background task of the session changed (the task is nested: a top-level ``state`` is the health fact).
 */
export interface BackgroundUpdatedStatus {
  event: Event8
  task: BackgroundTask
  [k: string]: unknown
}
/**
 * A background task of a session (a background command, a sub-Agent) and its state.
 */
export interface BackgroundTask {
  kind: Kind
  state: State1
  taskId: Taskid
  title: Title
  [k: string]: unknown
}
export interface PlanningStateUpdated {
  event: Event9
  revision: Revision4
  state: PlanningState
  [k: string]: unknown
}
export interface PlanningState {
  capabilities?: PlanningCapabilities
  draft?: PlanDraft | null
  effectiveMode?: Effectivemode
  epoch?: Epoch
  execution?: Execution1
  executionProgress?: Executionprogress
  freshness?: Freshness
  operation?: Operation
  proposal?: PlanDocument | null
  proposals?: Proposals
  requestedMode?: Requestedmode
  review?: PlanReview | null
  revision?: Revision7
  runtime: Runtime3
  runtimeId?: Runtimeid1
  sessionId: Sessionid2
}
export interface PlanningCapabilities {
  actions?: Actions
  contentStreaming?: Contentstreaming
  reason?: Reason2
  supported?: Supported2
  [k: string]: unknown
}
export interface PlanDraft {
  content: Content
  contentState: Contentstate
  draftId: Draftid
  planId: Planid
  revision: Revision5
  seq: Seq
}
export interface PlanDocument {
  contentHash: Contenthash
  contentState?: Contentstate1
  createdAt?: Createdat
  markdown: Markdown
  planId: Planid1
  revision: Revision6
  sourceTurnId?: Sourceturnid
  title: Title1
}
export interface PlanReview {
  actions?: Actions1
  contentHash: Contenthash1
  planId: Planid2
  planRevision: Planrevision
  reviewId: Reviewid
  status: Status3
}
export interface GoalStateUpdated {
  event: Event10
  revision: Revision8
  state: GoalState
  [k: string]: unknown
}
export interface GoalState {
  bindingGeneration?: Bindinggeneration
  capabilities?: GoalCapabilities
  externalSessionId?: Externalsessionid
  freshness?: Freshness1
  goal?: Goal | null
  lastOutcome?: Goal | null
  pendingOperationId?: Pendingoperationid
  revision?: Revision9
  runtime: Runtime4
  runtimeId?: Runtimeid2
  sessionId: Sessionid3
  sourceEpoch?: Sourceepoch
  sourceRevision?: Sourcerevision
}
export interface GoalCapabilities {
  actions?: Actions2
  reason?: Reason3
  supported?: Supported3
  [k: string]: unknown
}
export interface Goal {
  createdAt: Createdat1
  endedAt?: Endedat
  id: Id5
  iterations?: Iterations
  lastReason?: Lastreason
  objective: Objective
  sourceTurnId?: Sourceturnid1
  status: Status4
  timeUsedSeconds?: Timeusedseconds
  tokenBudget?: Tokenbudget
  tokensUsed?: Tokensused
  updatedAt: Updatedat
}
