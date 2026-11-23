"use client"

import { NewConversation } from "@/components/workbench/new-conversation"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"

export default function NewConversationPage() {
  return (
    <WorkbenchShell>
      <NewConversation />
    </WorkbenchShell>
  )
}
