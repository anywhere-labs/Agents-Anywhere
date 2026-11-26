"use client"

import { Suspense, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { DriveBrowser } from "@/components/drive/drive-browser"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { ControlApiError, resolveDrivePath } from "@/lib/api/control-http"
import { driveFileHref, driveHref, normalizeDrivePath } from "@/lib/drive/paths"
import { driveLocationOf } from "@/lib/drive/refs"
import { useWorkbench } from "@/lib/state/workbench-context"

// The open folder lives in the address (`/drive?path=/报告/2026`), so it survives reloads and can be linked; the
// query string (not a path segment) keeps the page a single static route for the Desktop export. `?file=<id>` opens
// a file's page; `?ref=drive:/…` (a reference linked from a reply) is resolved first and replaced by
// the folder, or by the file's folder and the file.
function DrivePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const reference = searchParams.get("ref")
  const path = normalizeDrivePath(searchParams.get("path"))
  if (reference !== null) return <OpenDriveRef reference={reference} />
  return (
    <div className="flex-1 overflow-y-auto">
      <DriveBrowser
        path={path}
        file={searchParams.get("file")}
        onNavigate={(next) => router.push(driveHref(next))}
        onOpenFile={(folder, id) => router.push(driveFileHref(folder, id))}
      />
    </div>
  )
}

function OpenDriveRef({ reference }: { reference: string }) {
  const { t } = useI18n()
  const router = useRouter()
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const serverUrl = activeAccount?.serverUrl ?? null

  useEffect(() => {
    if (!serverUrl) return
    let alive = true
    void (async () => {
      try {
        const resolved = await resolveDrivePath(serverUrl, await getFreshAccessToken(), { ref: reference })
        if (alive) router.replace(driveLocationOf(resolved))
      } catch (error) {
        if (!alive) return
        toast.error(
          error instanceof ControlApiError && (error.code === "drive_path_not_found" || error.code === "drive_invalid_ref")
            ? t("drive.refNotFound", { ref: reference })
            : t("drive.refFailed", { ref: reference, error: error instanceof Error ? error.message : String(error) })
        )
        router.replace(driveHref("/"))
      }
    })()
    return () => {
      alive = false
    }
  }, [getFreshAccessToken, reference, router, serverUrl, t])

  return <FullPageSpinner />
}

export default function DrivePage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <DrivePageInner />
    </Suspense>
  )
}
