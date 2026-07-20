import { Suspense } from "react"

import { FilePreviewPage } from "@/components/file-preview-page"

export default function PreviewPage() {
  return (
    <Suspense fallback={null}>
      <FilePreviewPage />
    </Suspense>
  )
}
