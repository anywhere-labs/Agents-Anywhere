"use client"

// A device's state as one mark, in the place of the device's own icon:
//   white dot          online
//   white closed lock  online, encrypted, not paired with this browser yet (locked)
//   white open lock    online, encrypted and paired
//   grey dot           offline
//   yellow dot         a problem: its status could not be read, or this browser pinned it for end-to-end encryption
//                      and it now reports normal mode (it will not be talked to in plaintext)
// Sized like a 16px icon so it lines up with the other rows' icons.
import { useSyncExternalStore } from "react"
import { LockIcon, LockOpenIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DeviceRecord } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { deviceInfoCache } from "@/lib/workbench/device-info"

export type DeviceState = "offline" | "online" | "locked" | "unlocked" | "problem"

export function deviceState(
  device: Pick<DeviceRecord, "presence" | "mode_hint">,
  { paired, error }: { paired: boolean; error: { code: string } | null }
): DeviceState {
  if (device.presence !== "online") return "offline"
  if (paired && device.mode_hint !== "encrypted") return "problem"
  if (error && error.code !== "e2e_not_paired") return "problem"
  if (device.mode_hint === "encrypted") return paired ? "unlocked" : "locked"
  return "online"
}

/** The device's state, with the last status read's error (from the shared device cache; nothing is fetched here). */
export function useDeviceState(device: Pick<DeviceRecord, "id" | "presence" | "mode_hint">): {
  state: DeviceState
  label: string
} {
  const { t } = useI18n()
  const { tunnelManager, deviceTrusts } = useWorkbench()
  const error = useSyncExternalStore(
    deviceInfoCache.subscribe,
    () => deviceInfoCache.get(tunnelManager, device.id).error,
    () => null
  )
  const paired = Boolean(deviceTrusts[device.id])
  const state = deviceState(device, { paired, error })
  const label =
    state === "offline"
      ? t("devices.offline")
      : state === "online"
        ? t("devices.online")
        : state === "locked"
          ? t("devices.stateLocked")
          : state === "unlocked"
            ? t("devices.stateUnlocked")
            : error && error.code !== "e2e_not_paired"
              ? `${t("devices.stateProblem")}: ${error.message}`
              : t("devices.stateProblemPinned")
  return { state, label }
}

export function DeviceStatusIcon({
  device,
  className,
}: {
  device: Pick<DeviceRecord, "id" | "presence" | "mode_hint">
  className?: string
}) {
  const { state, label } = useDeviceState(device)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state={state}
      className={cn("flex size-4 shrink-0 items-center justify-center", className)}
    >
      {state === "locked" ? (
        <LockIcon className="size-3.5! text-foreground" />
      ) : state === "unlocked" ? (
        <LockOpenIcon className="size-3.5! text-foreground" />
      ) : (
        <span
          className={cn(
            "size-2 rounded-full",
            state === "online" ? "bg-foreground" : state === "problem" ? "bg-warning" : "bg-muted-foreground/40"
          )}
        />
      )}
    </span>
  )
}
