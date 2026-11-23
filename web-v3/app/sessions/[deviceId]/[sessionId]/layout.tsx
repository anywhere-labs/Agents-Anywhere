import type { ReactNode } from "react"

import { exportPlaceholderParams } from "@/lib/platform/export-params"
import { PathKeyed } from "@/lib/platform/route-params"

export function generateStaticParams() {
  return exportPlaceholderParams("deviceId", "sessionId")
}

export default function SessionLayout({ children }: { children: ReactNode }) {
  return <PathKeyed>{children}</PathKeyed>
}
