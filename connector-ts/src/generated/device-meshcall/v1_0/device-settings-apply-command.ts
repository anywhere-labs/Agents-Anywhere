/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact device-settings-apply-command. Do not edit; run `yarn contracts:generate`. */

export type Confirmquitonshutdown = boolean

/**
 * ``device.settings.apply``: the whole settings object, as ``LinkWelcome.desired`` has it.
 */
export interface DeviceSettingsApplyCommand {
  settings: ConnectorDeviceSettings
  [k: string]: unknown
}
export interface ConnectorDeviceSettings {
  confirmQuitOnShutdown?: Confirmquitonshutdown
  [k: string]: unknown
}
