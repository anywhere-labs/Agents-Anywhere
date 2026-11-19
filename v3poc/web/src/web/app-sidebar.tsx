// shadcn Sidebar from workspace.json (`watch_list` in the real thing): pinned and recent sessions, projects (the working
// folders, as in Effi Cloud) with their sessions, devices with presence, and the account.
import { useSyncExternalStore } from 'react'
import { CircleAlertIcon, FolderIcon, LaptopIcon, LoaderCircleIcon, MonitorIcon, ServerIcon } from 'lucide-react'
import type { SessionSummary, Workspace } from '@protocol/timeline'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { useTimeline } from '@/timeline/use-timeline'
import { peekSession, sessionsVersion, subscribeSessions, type DemoSession } from './sessions'

const PLATFORM_ICON = { macos: LaptopIcon, linux: ServerIcon, windows: MonitorIcon }

export function AppSidebar({ workspace, active, read, onOpen }: { workspace: Workspace; active: string; read: Set<string>; onOpen: (id: string) => void }) {
  useSyncExternalStore(subscribeSessions, sessionsVersion)
  const pinned = workspace.sessions.filter((s) => s.pinned)
  const recent = workspace.sessions.filter((s) => !s.pinned).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
  const row = (s: SessionSummary) => (
    <SidebarMenuItem key={s.id}>
      <SidebarMenuButton isActive={s.id === active} onClick={() => onOpen(s.id)} className="pr-8">
        <span className="truncate">{s.title}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        <SessionState summary={s} live={peekSession(s.id)} unread={s.unread && !read.has(s.id)} />
      </SidebarMenuBadge>
    </SidebarMenuItem>
  )
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">AA</div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium">Agents Anywhere</span>
            <span className="truncate text-xs text-muted-foreground">v3 PoC · 演示数据</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>置顶</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{pinned.map(row)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>最近</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{recent.map(row)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>项目</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspace.projects.map((p) => {
                const device = workspace.devices.find((d) => d.id === p.device_id)
                const sessions = workspace.sessions.filter((s) => s.cwd === p.cwd && s.device_id === p.device_id)
                return (
                  <SidebarMenuItem key={`${p.device_id}:${p.cwd}`}>
                    <SidebarMenuButton title={`${p.cwd} · ${device?.name ?? ''}`}>
                      <FolderIcon />
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">{device?.name}</span>
                    </SidebarMenuButton>
                    {sessions.length > 0 && (
                      <SidebarMenuSub>
                        {sessions.map((s) => (
                          <SidebarMenuSubItem key={s.id}>
                            <SidebarMenuSubButton isActive={s.id === active} onClick={() => onOpen(s.id)} render={<button type="button" />}>
                              <span className="truncate">{s.title}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>设备</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspace.devices.map((d) => {
                const Icon = PLATFORM_ICON[d.platform]
                return (
                  <SidebarMenuItem key={d.id}>
                    <SidebarMenuButton className={d.presence === 'offline' ? 'pr-14 text-muted-foreground' : 'pr-14'}>
                      <Icon />
                      <span className="truncate">{d.name}</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>
                      <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                        <span className={d.presence === 'online' ? 'size-1.5 rounded-full bg-emerald-500' : 'size-1.5 rounded-full bg-muted-foreground/40'} />
                        {d.presence === 'online' ? '在线' : '离线'}
                      </span>
                    </SidebarMenuBadge>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Avatar size="sm">
            <AvatarFallback>{workspace.account.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{workspace.account.name}</span>
            <span className="truncate text-xs text-muted-foreground">{workspace.account.email}</span>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** The row's state: from the live store once the session has been opened, else from the summary. */
function SessionState({ summary, live, unread }: { summary: SessionSummary; live?: DemoSession; unread: boolean }) {
  if (live) return <LiveState session={live} unread={unread} />
  return <StateDot state={summary.state} unread={unread} />
}

function LiveState({ session, unread }: { session: DemoSession; unread: boolean }) {
  const s = useTimeline(session.store)
  const state = s.control?.pending.length ? 'waiting' : (s.control?.state ?? 'idle')
  return <StateDot state={state} unread={unread} />
}

function StateDot({ state, unread }: { state: SessionSummary['state']; unread: boolean }) {
  if (state === 'running') return <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" aria-label="运行中" />
  if (state === 'waiting') return <span className="size-2 rounded-full bg-amber-500" aria-label="等待确认" />
  if (state === 'error') return <CircleAlertIcon className="size-3.5 text-destructive" aria-label="出错" />
  if (unread) return <span className="size-2 rounded-full bg-blue-500" aria-label="未读" />
  return null
}

