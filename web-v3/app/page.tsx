"use client"

import { AssistantPanel } from "@/components/workbench/assistant-panel"
import { NewConversation } from "@/components/workbench/new-conversation"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import { useWorkbench } from "@/lib/state/workbench-context"

function HomeContent() {
  const { preferences } = useWorkbench()
  // Assistant-first: the assistant is the main view (client-experience-proposal §2.2).
  if (preferences.assistantPrimary) return <AssistantPanel />
  // Device-first: home is the new-conversation launcher (v2's home route); recent work is in the sidebar.
  return <NewConversation />
}

export default function HomePage() {
  return (
    <WorkbenchShell>
      <HomeContent />
    </WorkbenchShell>
  )
}
