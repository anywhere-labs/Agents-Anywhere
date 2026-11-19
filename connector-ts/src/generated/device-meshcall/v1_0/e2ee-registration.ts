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
      "sessionCreationBegin",
      "sessionCreationRespond",
      "sessionCreationCancel",
      "workspacePrepare",
      "workspacePreparationReserve",
      "workspacePreparationRespond",
      "workspacePreparationCancel",
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
    "aa.device.v1.Sessions": [
      "watch",
      "creationGet",
      "workspacePreparationGet"
    ],
    "aa.device.v1.Store": [
      "readBlob",
      "exportShare"
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
    "aa.device.v1.Content": [
      "pair",
      "request",
      "subscribe"
    ],
    "aa.device.v1.Link": [
      "attach",
      "outbox",
      "ackOutbox"
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
