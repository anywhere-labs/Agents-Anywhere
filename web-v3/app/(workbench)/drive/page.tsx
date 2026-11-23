"use client"

import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { DriveBrowser } from "@/components/drive/drive-browser"
import { FullPageSpinner } from "@/components/spinner"
import { driveHref, normalizeDrivePath } from "@/lib/drive/paths"

// The open folder lives in the address (`/drive?path=/报告/2026`), so it survives reloads and can be linked; the
// query string (not a path segment) keeps the page a single static route for the Desktop export.
function DrivePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const path = normalizeDrivePath(searchParams.get("path"))
  return (
    <div className="flex-1 overflow-y-auto">
      <DriveBrowser path={path} onNavigate={(next) => router.push(driveHref(next))} />
    </div>
  )
}

export default function DrivePage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <DrivePageInner />
    </Suspense>
  )
}
