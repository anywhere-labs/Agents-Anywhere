/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0/payloads.json. Do not edit; run `yarn contracts:generate`. */

import type { AgentOperateCommand } from "./agent-operate-command.js"
import type { AgentOperationResult } from "./agent-operation-result.js"
import type { AttachmentConsumedOut } from "./attachment-consumed-out.js"
import type { ChangesEvent } from "./changes-event.js"
import type { ChannelSwitchCommand } from "./channel-switch-command.js"
import type { ClientCallItem } from "./client-call-item.js"
import type { ClientCallRequest } from "./client-call-request.js"
import type { ClientSubscribeRequest } from "./client-subscribe-request.js"
import type { CommandResultOut } from "./command-result-out.js"
import type { CommandStatusRequest } from "./command-status-request.js"
import type { CommandStatusResponse } from "./command-status-response.js"
import type { CreationBeginCommand } from "./creation-begin-command.js"
import type { CreationCancelCommand } from "./creation-cancel-command.js"
import type { CreationGetRequest } from "./creation-get-request.js"
import type { CreationRespondCommand } from "./creation-respond-command.js"
import type { DeviceSettingsApplyCommand } from "./device-settings-apply-command.js"
import type { DeviceSettingsApplyResult } from "./device-settings-apply-result.js"
import type { ExportShareChunk } from "./export-share-chunk.js"
import type { ExportShareRequest } from "./export-share-request.js"
import type { GoalResponse } from "../../protocol/v1_2/goal-response.js"
import type { InterruptResult } from "./interrupt-result.js"
import type { PlanningResponse } from "../../protocol/v1_2/planning-response.js"
import type { PortClosedEvent } from "../../preview/v1_0/port-closed-event.js"
import type { PortListeningEvent } from "../../preview/v1_0/port-listening-event.js"
import type { PositionSelectCommand } from "./position-select-command.js"
import type { PreparationCancelCommand } from "./preparation-cancel-command.js"
import type { PreparationGetRequest } from "./preparation-get-request.js"
import type { PreparationReserveCommand } from "./preparation-reserve-command.js"
import type { PreparationReserveResult } from "./preparation-reserve-result.js"
import type { PreparationRespondCommand } from "./preparation-respond-command.js"
import type { PreviewCloseCommand } from "../../preview/v1_0/preview-close-command.js"
import type { PreviewCloseResult } from "./preview-close-result.js"
import type { PreviewOpenCommand } from "../../preview/v1_0/preview-open-command.js"
import type { PreviewOpenResult } from "./preview-open-result.js"
import type { QueueItemCommand } from "./queue-item-command.js"
import type { QueueReorderCommand } from "./queue-reorder-command.js"
import type { QueueResult } from "./queue-result.js"
import type { ReadBlobChunk } from "./read-blob-chunk.js"
import type { ReadBlobRequest } from "./read-blob-request.js"
import type { RespondNoticeCommand } from "./respond-notice-command.js"
import type { RespondNoticeResult } from "./respond-notice-result.js"
import type { RuntimeApplyCommand } from "./runtime-apply-command.js"
import type { RuntimeApplyResult } from "./runtime-apply-result.js"
import type { RuntimeNoticeUpdatedEvent } from "./runtime-notice-updated-event.js"
import type { RuntimeQueueUpdatedEvent } from "./runtime-queue-updated-event.js"
import type { RuntimeStatusEvent } from "./runtime-status-event.js"
import type { SelectCommand } from "./select-command.js"
import type { SelectResult } from "./select-result.js"
import type { SendMessageCommand } from "./send-message-command.js"
import type { SendMessageResult } from "./send-message-result.js"
import type { SessionCloseCommand } from "./session-close-command.js"
import type { SessionCloseResult } from "./session-close-result.js"
import type { SessionCommand } from "./session-command.js"
import type { SessionConfigureCommand } from "./session-configure-command.js"
import type { SessionConfigureResult } from "./session-configure-result.js"
import type { SessionGoalCommand } from "./session-goal-command.js"
import type { SessionInventoryOut } from "./session-inventory-out.js"
import type { SessionPlanningCommand } from "./session-planning-command.js"
import type { SessionRecoverCommand } from "./session-recover-command.js"
import type { SessionRecoverResult } from "./session-recover-result.js"
import type { SessionSummaryOut } from "./session-summary-out.js"
import type { SessionSyncCommand } from "./session-sync-command.js"
import type { SessionSyncResult } from "./session-sync-result.js"
import type { SessionWatchRequest } from "./session-watch-request.js"
import type { SteerCommand } from "./steer-command.js"
import type { SteerResult } from "./steer-result.js"
import type { TerminalStreamItem } from "./terminal-stream-item.js"
import type { UsageReportOut } from "./usage-report-out.js"
import type { WorkflowState } from "./workflow-state.js"
import type { WorkspacePrepareCommand } from "./workspace-prepare-command.js"

/** `CommandCall.p` (request) and `CommandAck.r` (response) of every `aa.device.v1.Commands/*` method. */
export interface CommandPayloads {
  "channel.switch": { request: ChannelSwitchCommand; response: RuntimeApplyResult }
  "device.settings.apply": { request: DeviceSettingsApplyCommand; response: DeviceSettingsApplyResult }
  "preview.close": { request: PreviewCloseCommand; response: PreviewCloseResult }
  "preview.open": { request: PreviewOpenCommand; response: PreviewOpenResult }
  "runtime.apply": { request: RuntimeApplyCommand; response: RuntimeApplyResult }
  "session.agent.operate": { request: AgentOperateCommand; response: AgentOperationResult }
  "session.close": { request: SessionCloseCommand; response: SessionCloseResult }
  "session.configuration.update": { request: SessionConfigureCommand; response: SessionConfigureResult }
  "session.creation.begin": { request: CreationBeginCommand; response: WorkflowState }
  "session.creation.cancel": { request: CreationCancelCommand; response: WorkflowState }
  "session.creation.respond": { request: CreationRespondCommand; response: WorkflowState }
  "session.goal": { request: SessionGoalCommand; response: GoalResponse }
  "session.interrupt": { request: SessionCommand; response: InterruptResult }
  "session.planning": { request: SessionPlanningCommand; response: PlanningResponse }
  "session.position.select": { request: PositionSelectCommand; response: AgentOperationResult }
  "session.queue.clear": { request: SessionCommand; response: QueueResult }
  "session.queue.delete": { request: QueueItemCommand; response: QueueResult }
  "session.queue.reorder": { request: QueueReorderCommand; response: QueueResult }
  "session.queue.resume": { request: SessionCommand; response: QueueResult }
  "session.queue.retry": { request: QueueItemCommand; response: QueueResult }
  "session.queue.sendNow": { request: QueueItemCommand; response: QueueResult }
  "session.queue.update": { request: QueueItemCommand; response: QueueResult }
  "session.recover": { request: SessionRecoverCommand; response: SessionRecoverResult }
  "session.respondNotice": { request: RespondNoticeCommand; response: RespondNoticeResult }
  "session.select": { request: SelectCommand; response: SelectResult }
  "session.sendMessage": { request: SendMessageCommand; response: SendMessageResult }
  "session.steer": { request: SteerCommand; response: SteerResult }
  "session.sync": { request: SessionSyncCommand; response: SessionSyncResult }
  "workspace.preparation.cancel": { request: PreparationCancelCommand; response: WorkflowState }
  "workspace.preparation.reserve": { request: PreparationReserveCommand; response: PreparationReserveResult }
  "workspace.preparation.respond": { request: PreparationRespondCommand; response: WorkflowState }
  "workspace.prepare": { request: WorkspacePrepareCommand; response: WorkflowState }
}

/** Request and response of every Server-initiated read; for a stream the response is its item. */
export interface ReadPayloads {
  "client.call": { request: ClientCallRequest; response: ClientCallItem }
  "client.subscribe": { request: ClientSubscribeRequest; response: TerminalStreamItem }
  "command.status": { request: CommandStatusRequest; response: CommandStatusResponse }
  "session.creation.get": { request: CreationGetRequest; response: WorkflowState }
  "session.watch": { request: SessionWatchRequest; response: ChangesEvent }
  "store.exportShare": { request: ExportShareRequest; response: ExportShareChunk }
  "store.readBlob": { request: ReadBlobRequest; response: ReadBlobChunk }
  "workspace.preparation.get": { request: PreparationGetRequest; response: WorkflowState }
}

/** `LinkAttachItem.p` by `LinkAttachItem.m`. */
export interface EventPayloads {
  "port.closed": PortClosedEvent
  "port.listening": PortListeningEvent
  "runtime.notice.updated": RuntimeNoticeUpdatedEvent
  "runtime.queue.updated": RuntimeQueueUpdatedEvent
  "runtime.status": RuntimeStatusEvent
}

/** `OutboxItem.p` by `OutboxItem.m`. */
export interface OutboxPayloads {
  "attachment.consumed": AttachmentConsumedOut
  "command.result": CommandResultOut
  "session.inventory": SessionInventoryOut
  "session.summary": SessionSummaryOut
  "usage.report": UsageReportOut
}

export type CommandMethod = keyof CommandPayloads
export type ReadMethod = keyof ReadPayloads
export type EventMethod = keyof EventPayloads
export type OutboxMethod = keyof OutboxPayloads

/** Business method -> MeshCall `service/method`. */
export const COMMAND_ROUTES = {
  "channel.switch": "aa.device.v1.Commands/channelSwitch",
  "device.settings.apply": "aa.device.v1.Commands/deviceSettingsApply",
  "preview.close": "aa.device.v1.Commands/previewClose",
  "preview.open": "aa.device.v1.Commands/previewOpen",
  "runtime.apply": "aa.device.v1.Commands/runtimeApply",
  "session.agent.operate": "aa.device.v1.Commands/sessionAgentOperate",
  "session.close": "aa.device.v1.Commands/sessionClose",
  "session.configuration.update": "aa.device.v1.Commands/sessionConfigurationUpdate",
  "session.creation.begin": "aa.device.v1.Commands/sessionCreationBegin",
  "session.creation.cancel": "aa.device.v1.Commands/sessionCreationCancel",
  "session.creation.respond": "aa.device.v1.Commands/sessionCreationRespond",
  "session.goal": "aa.device.v1.Commands/sessionGoal",
  "session.interrupt": "aa.device.v1.Commands/sessionInterrupt",
  "session.planning": "aa.device.v1.Commands/sessionPlanning",
  "session.position.select": "aa.device.v1.Commands/sessionPositionSelect",
  "session.queue.clear": "aa.device.v1.Commands/sessionQueueClear",
  "session.queue.delete": "aa.device.v1.Commands/sessionQueueDelete",
  "session.queue.reorder": "aa.device.v1.Commands/sessionQueueReorder",
  "session.queue.resume": "aa.device.v1.Commands/sessionQueueResume",
  "session.queue.retry": "aa.device.v1.Commands/sessionQueueRetry",
  "session.queue.sendNow": "aa.device.v1.Commands/sessionQueueSendNow",
  "session.queue.update": "aa.device.v1.Commands/sessionQueueUpdate",
  "session.recover": "aa.device.v1.Commands/sessionRecover",
  "session.respondNotice": "aa.device.v1.Commands/sessionRespondNotice",
  "session.select": "aa.device.v1.Commands/sessionSelect",
  "session.sendMessage": "aa.device.v1.Commands/sessionSendMessage",
  "session.steer": "aa.device.v1.Commands/sessionSteer",
  "session.sync": "aa.device.v1.Commands/sessionSync",
  "workspace.preparation.cancel": "aa.device.v1.Commands/workspacePreparationCancel",
  "workspace.preparation.reserve": "aa.device.v1.Commands/workspacePreparationReserve",
  "workspace.preparation.respond": "aa.device.v1.Commands/workspacePreparationRespond",
  "workspace.prepare": "aa.device.v1.Commands/workspacePrepare"
} as const

export const READ_ROUTES = {
  "client.call": "aa.device.v1.Client/call",
  "client.subscribe": "aa.device.v1.Client/subscribe",
  "command.status": "aa.device.v1.Commands/status",
  "session.creation.get": "aa.device.v1.Sessions/creationGet",
  "session.watch": "aa.device.v1.Sessions/watch",
  "store.exportShare": "aa.device.v1.Store/exportShare",
  "store.readBlob": "aa.device.v1.Store/readBlob",
  "workspace.preparation.get": "aa.device.v1.Sessions/workspacePreparationGet"
} as const
