/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact mobile-directory-request. Do not edit; run `yarn contracts:generate`. */

export type Cursor = string | null
export type Deviceid = string | null
export type Resource = "devices" | "projects" | "sessions" | "runtimes"

export interface MobileDirectoryRequest {
  cursor?: Cursor
  deviceId?: Deviceid
  resource: Resource
}
