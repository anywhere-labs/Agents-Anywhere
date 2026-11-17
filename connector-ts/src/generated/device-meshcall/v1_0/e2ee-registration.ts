/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0/e2ee-registration.json. Do not edit; run `yarn contracts:generate`. */

/** Services and methods the device registers on the Router, per E2EE mode. */
export const REGISTERED_SERVICES = {
  "off": {
    "aa.device.v1.Client": [
      "call",
      "subscribe"
    ],
    "aa.device.v1.Commands": [
      "status",
      "sessionSendMessage",
      "sessionSteer",
      "sessionInterrupt",
      "sessionRespondNotice",
      "sessionSelect",
      "sessionCreationBegin",
      "sessionCreationRespond",
      "sessionCreationCancel",
      "workspacePrepare",
      "workspacePreparationReserve",
      "workspacePreparationRespond",
      "workspacePreparationCancel",
      "sessionPlanning",
      "sessionGoal",
      "sessionQueueUpdate",
      "sessionQueueDelete",
      "sessionQueueRetry",
      "sessionQueueSendNow",
      "sessionQueueResume",
      "sessionQueueReorder",
      "sessionQueueClear",
      "sessionSync",
      "runtimeApply",
      "deviceSettingsApply",
      "channelSwitch",
      "previewOpen",
      "previewClose"
    ],
    "aa.device.v1.Link": [
      "attach",
      "outbox",
      "ackOutbox"
    ],
    "aa.device.v1.Runtime": [
      "catalogs"
    ],
    "aa.device.v1.Sessions": [
      "snapshot",
      "watch",
      "notices",
      "state",
      "capabilities",
      "queue",
      "creationGet",
      "workspacePreparationGet"
    ],
    "aa.device.v1.Store": [
      "read",
      "changesSince",
      "readBlob",
      "exportShare",
      "planDocument"
    ],
    "aa.device.v1.Workspace": [
      "call",
      "terminalOutput"
    ]
  },
  "required": {
    "aa.device.v1.Commands": [
      "status",
      "runtimeApply",
      "deviceSettingsApply",
      "channelSwitch",
      "previewOpen",
      "previewClose"
    ],
    "aa.device.v1.Link": [
      "attach",
      "outbox",
      "ackOutbox"
    ],
    "aa.device.v1.Secure": [
      "channel"
    ]
  }
} as const

/** Link/attach event methods allowed in plaintext, per E2EE mode. */
export const ATTACH_EVENTS = {
  "off": [
    "runtime.status",
    "runtime.notice.updated",
    "runtime.queue.updated",
    "port.listening",
    "port.closed"
  ],
  "required": [
    "runtime.status",
    "port.listening",
    "port.closed"
  ]
} as const
