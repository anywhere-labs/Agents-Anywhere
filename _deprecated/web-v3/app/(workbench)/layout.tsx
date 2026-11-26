import type { ReactNode } from "react"

import { WorkbenchShell } from "@/components/workbench/workbench-shell"

// One shell for every workbench page (home, new conversation, conversations, devices, Orches, settings): the sidebar,
// Orches and their widths stay put while the page beside them changes, instead of being rebuilt on each navigation.
export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  return <WorkbenchShell>{children}</WorkbenchShell>
}
