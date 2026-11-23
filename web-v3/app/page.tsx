"use client"

import { DesktopThisComputer } from "@/components/desktop/this-computer"
import { AssistantPanel } from "@/components/workbench/assistant-panel"
import { NewConversation } from "@/components/workbench/new-conversation"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import { getDesktopBridge } from "@/lib/platform/desktop"
import { useWorkbench } from "@/lib/state/workbench-context"

function HomeContent() {
  const { preferences } = useWorkbench()
  // Assistant-first: the assistant is the main view (client-experience-proposal §2.2).
  if (preferences.assistantPrimary) return <AssistantPanel />
  // Device-first: home is the new-conversation launcher (v2's home route); recent work is in the sidebar.
  // Inside the desktop app, the "this computer" card (managed Connector, registration, pairing) sits above it.
  if (!getDesktopBridge()) return <NewConversation />
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
        <DesktopThisComputer />
      </div>
      <NewConversation />
    </div>
  )
}

export default function HomePage() {
  return (
    <WorkbenchShell>
      <HomeContent />
    </WorkbenchShell>
  )
}
