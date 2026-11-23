// Words for drive paths and drive errors (docs/v3/assistant-and-files-proposal.md §6.1–6.2).

import { ControlApiError } from "@/lib/api/control-http"
import { DRIVE_ROOT, systemFolderOf, type DriveNameProblem } from "@/lib/drive/paths"
import type { DriveUploadPlan } from "@/lib/drive/entries"
import type { MessageKey, Vars } from "@/lib/i18n"
import { formatSize } from "@/lib/workbench/time"

export type Translate = (key: MessageKey, vars?: Vars) => string

/** How a folder reads: the root and the two server-created folders have their own names. */
export function driveFolderLabel(path: string, name: string, t: Translate): string {
  if (path === DRIVE_ROOT) return t("drive.root")
  switch (systemFolderOf(path)) {
    case "transfers":
      return t("drive.transfers")
    case "orches":
      return t("drive.orches")
    default:
      return name
  }
}

const NAME_PROBLEMS: Record<DriveNameProblem, MessageKey> = {
  empty: "drive.nameEmpty",
  slash: "drive.nameSlash",
  dots: "drive.nameDots",
  control: "drive.nameControl",
  too_long: "drive.nameTooLong",
}

export function driveNameProblemMessage(problem: DriveNameProblem, t: Translate): string {
  return t(NAME_PROBLEMS[problem])
}

const ERROR_MESSAGES: Record<string, MessageKey> = {
  drive_path_conflict: "drive.errorConflict",
  drive_parent_is_file: "drive.errorParentIsFile",
  drive_managed_path: "drive.errorManaged",
  drive_system_folder: "drive.errorSystem",
  drive_move_into_self: "drive.errorIntoSelf",
  drive_encrypted_name: "drive.errorEncryptedName",
  drive_invalid_path: "drive.errorInvalid",
  drive_invalid_ref: "drive.errorInvalid",
  drive_path_not_found: "drive.errorGone",
  drive_folder_not_found: "drive.errorGone",
  not_found: "drive.errorGone",
  drive_quota_exceeded: "drive.errorQuota",
  file_too_large: "drive.errorTooLarge",
  drive_not_configured: "drive.disabledTitle",
  upload_expired: "drive.errorUpload",
  upload_not_found: "drive.errorUpload",
  upload_size_mismatch: "drive.errorUpload",
}

/** A drive error in the user's words; `name` is the name the action was about. */
export function driveErrorMessage(err: unknown, t: Translate, name = ""): string {
  if (err instanceof ControlApiError) {
    const key = ERROR_MESSAGES[err.code]
    return key ? t(key, { name }) : err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** Why a picked file was not queued for upload. */
export function driveUploadRejection(
  plan: Exclude<DriveUploadPlan, { ok: true }>,
  name: string,
  t: Translate
): string {
  switch (plan.reason) {
    case "empty":
      return t("drive.uploadEmpty", { name })
    case "too_large":
      return t("drive.uploadTooLarge", { name, limit: formatSize(plan.limit ?? 0) })
    case "quota":
      return t("drive.uploadNoSpace", { name, limit: formatSize(plan.limit ?? 0) })
    default:
      return t("drive.disabledTitle")
  }
}
