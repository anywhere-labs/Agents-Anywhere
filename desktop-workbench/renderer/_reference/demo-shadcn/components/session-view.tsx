"use client"

import * as React from "react"
import {
  ArrowUp,
  FolderTree,
  SquareTerminal,
  Hand,
  ChevronDown,
  ExternalLink,
  PanelLeft,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useSidebar } from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { ChatThread } from "@/components/chat-thread"
import { PanelHeader } from "@/components/panels/panel-header"
import { FilesPanelBody } from "@/components/panels/files-panel"
import { TerminalPanelBody } from "@/components/panels/terminal-panel"
import { CascadingSelector } from "@/components/cascading-selector"
import { AttachmentBar, DragOverlay, useAttachments } from "@/components/attachment-input"
import { useWorkspace, type PanelId } from "@/components/workspace-context"

const PANEL_META: Record<PanelId, { title: string; icon: typeof FolderTree }> = {
  files: { title: "Files", icon: FolderTree },
  terminal: { title: "Shell", icon: SquareTerminal },
}

export function SessionView() {
  const { toggleSidebar } = useSidebar()
  const { activeSessionId, sessions, connectors, panels, popupBlocked, setPanelMode, dismissPopupBlocked } =
    useWorkspace()
  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0]
  const connector = connectors.find((c) => c.id === session?.connectorId)

  const [approval, setApproval] = React.useState("ask")
  const [selectedModel, setSelectedModel] = React.useState("gpt-5.5")
  const [selectedReasoning, setSelectedReasoning] = React.useState("low")
  const [takeoverOn, setTakeoverOn] = React.useState(false)
  const [takeoverDialog, setTakeoverDialog] = React.useState<"on" | "off" | null>(null)

  const { attachments, isDragging, add, remove, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()

  const dockIds: PanelId[] = ["files", "terminal"]
  const dockedExpanded = dockIds.filter((id) => panels[id] === "docked")
  const hasDock = dockedExpanded.length > 0

  const approvalOptions = [
    { id: "ask", label: "Ask approval" },
    { id: "auto", label: "Auto approve" },
    { id: "readonly", label: "Read only" },
  ]
  const approvalLabel = approvalOptions.find((o) => o.id === approval)?.label ?? "Ask approval"

  const models = [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-4", label: "GPT-4" },
    { id: "claude-4", label: "Claude 4" },
  ]
  const reasoningOptions = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ]

  const renderBody = (id: PanelId) => {
    if (id === "files") return <FilesPanelBody />
    if (id === "terminal") return <TerminalPanelBody />
    return null
  }

  const handleTakeoverToggle = () => {
    setTakeoverDialog(takeoverOn ? "off" : "on")
  }

  const confirmTakeover = () => {
    setTakeoverOn((prev) => !prev)
    setTakeoverDialog(null)
  }

  return (
    <>
      <div
        className="contents"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <DragOverlay isDragging={isDragging} />

        {/* Outer horizontal resizable: chat | right dock */}
        <ResizablePanelGroup direction="horizontal" className="h-svh w-full">

          {/* Chat panel */}
          <ResizablePanel defaultSize={hasDock ? 66 : 100} minSize={30}>
            <div className="flex h-full flex-col">

              {/* Session header — sidebar trigger lives here to avoid overlap */}
              <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
                <button
                  type="button"
                  aria-label="展开侧边栏"
                  onClick={toggleSidebar}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <PanelLeft className="size-4" />
                </button>
                <Separator orientation="vertical" className="h-4" />
                <h1 className="truncate text-sm font-medium">{session.title}</h1>
                <Badge variant="secondary" className="shrink-0 gap-1.5 font-normal">
                  <span className={cn(
                    "size-1.5 rounded-full",
                    session?.connectorStatus === "online" ? "bg-emerald-500" : "bg-muted-foreground/40"
                  )} />
                  {connector?.name ?? session?.connectorId}/{session?.runtime}
                </Badge>
                <div className="ml-auto flex items-center gap-1">
                  <TogglePanelButton id="files" icon={FolderTree} />
                  <TogglePanelButton id="terminal" icon={SquareTerminal} />
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-auto">
                <ChatThread />
              </div>

              {/* Reply composer */}
              <div className="shrink-0 px-4 pb-4">
                <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card">
                  <div className="px-4 pt-4">
                    <Textarea
                      placeholder="Reply, or interrupt with new instructions…"
                      className="min-h-12 max-h-48 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-2">
                    <AttachmentBar
                      attachments={attachments}
                      onAttach={add}
                      onRemove={remove}
                      isDragging={isDragging}
                    />

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                          <Hand className="size-4" />
                          <span className="text-foreground">{approvalLabel}</span>
                          <ChevronDown className="size-3.5 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        {approvalOptions.map((opt) => (
                          <DropdownMenuItem key={opt.id} onSelect={() => setApproval(opt.id)}>
                            {opt.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <CascadingSelector
                      primaryOptions={models}
                      secondaryOptions={reasoningOptions}
                      selectedPrimary={selectedModel}
                      selectedSecondary={selectedReasoning}
                      onPrimaryChange={setSelectedModel}
                      onSecondaryChange={setSelectedReasoning}
                      secondaryLabel="Reasoning"
                    />

                    <div className="flex items-center gap-2">
                      <Switch
                        id="takeover"
                        checked={takeoverOn}
                        onCheckedChange={handleTakeoverToggle}
                      />
                      <Label htmlFor="takeover" className="cursor-pointer text-sm text-muted-foreground">
                        Takeover
                      </Label>
                    </div>

                    <Button size="icon" aria-label="发送" className="ml-auto rounded-full">
                      <ArrowUp className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>

            </div>
          </ResizablePanel>

          {/* Horizontal resize handle between chat and right dock */}
          {hasDock ? <ResizableHandle withHandle /> : null}

          {/* Right dock: vertical resizable panels */}
          {hasDock ? (
            <ResizablePanel defaultSize={34} minSize={20}>
              <ResizablePanelGroup
                key={dockedExpanded.join("-")}
                direction="vertical"
                className="h-full"
              >
                {dockedExpanded.map((id, index) => {
                  const meta = PANEL_META[id]
                  return (
                    <React.Fragment key={id}>
                      {index > 0 ? <ResizableHandle withHandle /> : null}
                      <ResizablePanel defaultSize={100 / dockedExpanded.length} minSize={15}>
                        <div className="flex h-full flex-col">
                          <PanelHeader
                            icon={meta.icon}
                            title={meta.title}
                            onDetach={() => setPanelMode(id, "floating")}
                            onRefresh={() => {}}
                            onClose={() => setPanelMode(id, "closed")}
                          />
                          <div className="min-h-0 flex-1 overflow-hidden">{renderBody(id)}</div>
                        </div>
                      </ResizablePanel>
                    </React.Fragment>
                  )
                })}
              </ResizablePanelGroup>
            </ResizablePanel>
          ) : null}

        </ResizablePanelGroup>
      </div>

      {/* Takeover confirmation dialog */}
      <Dialog open={takeoverDialog !== null} onOpenChange={(open) => !open && setTakeoverDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {takeoverDialog === "on" ? "启用 Takeover 模式" : "关闭 Takeover 模式"}
            </DialogTitle>
            <DialogDescription>
              {takeoverDialog === "on"
                ? "启用 Takeover 后，您将接管此会话的控制权，Agent 将暂停自动执行并等待您的指令。是否继续？"
                : "关闭 Takeover 后，Agent 将恢复自动执行模式。是否继续？"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTakeoverDialog(null)}>
              取消
            </Button>
            <Button onClick={confirmTakeover}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Popup blocked dialog */}
      <Dialog open={popupBlocked} onOpenChange={(open) => !open && dismissPopupBlocked()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ExternalLink className="size-4" />
              需要允许弹出窗口
            </DialogTitle>
            <DialogDescription>
              浏览器阻止了预览窗口的弹出。请在地址栏右侧点击被阻止的图标，选择
              <strong className="text-foreground"> &ldquo;始终允许&rdquo; </strong>
              此网站的弹出窗口，然后重新点击文件即可打开预览。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissPopupBlocked}>知道了</Button>
            <Button onClick={dismissPopupBlocked}>好的，我去设置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TogglePanelButton({ id, icon: Icon }: { id: PanelId; icon: typeof FolderTree }) {
  const { panels, setPanelMode } = useWorkspace()
  const active = panels[id] !== "closed"
  return (
    <button
      type="button"
      aria-label={PANEL_META[id].title}
      onClick={() => setPanelMode(id, active ? "closed" : "docked")}
      className={cn(
        "rounded-md p-2 transition-colors hover:bg-accent hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}
