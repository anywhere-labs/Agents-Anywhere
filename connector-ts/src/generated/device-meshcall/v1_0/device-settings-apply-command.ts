/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact device-settings-apply-command. Do not edit; run `yarn contracts:generate`. */

export type Crossdevice = boolean
export type Enabled = boolean
export type Close = boolean
export type Interrupt = boolean
export type Steer = boolean
export type Crossdevice1 = boolean
export type Enabled1 = boolean
export type Confirmquitonshutdown = boolean

/**
 * ``device.settings.apply``: the whole settings object, as ``LinkWelcome.desired`` has it (the device's own
 * settings and the account's ``agentCollaboration``).
 */
export interface DeviceSettingsApplyCommand {
  settings: DeviceSettingsPayload
  [k: string]: unknown
}
/**
 * What a device gets (``device.settings.apply``, ``LinkWelcome.desired.deviceSettings``): its own settings and
 * the account's agent collaboration settings, which every device of the account shares.
 */
export interface DeviceSettingsPayload {
  agentCollaboration?: AgentCollaborationSettings
  confirmQuitOnShutdown?: Confirmquitonshutdown
  [k: string]: unknown
}
/**
 * ``GET/PUT /api/v2/agent-collaboration/settings``; also the device settings key ``agentCollaboration``.
 *
 * An instance is on only when the account and the instance are enabled; it may reach other devices only when
 * both ``crossDevice`` flags are on as well.
 */
export interface AgentCollaborationSettings {
  crossDevice?: Crossdevice
  enabled?: Enabled
  instances?: Instances
}
export interface Instances {
  [k: string]: AgentCollaborationInstance
}
/**
 * One runtime instance's switches (keyed by its ``runtimeId``).
 */
export interface AgentCollaborationInstance {
  authority?: AgentAuthority
  crossDevice?: Crossdevice1
  enabled?: Enabled1
}
/**
 * What a supervisor may do to a session on a person's behalf; steering and closing by default.
 */
export interface AgentAuthority {
  close?: Close
  interrupt?: Interrupt
  steer?: Steer
}
