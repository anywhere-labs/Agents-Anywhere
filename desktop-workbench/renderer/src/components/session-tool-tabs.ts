import type { TerminalView } from "@/features/dashboard/types"
import type { SessionFilePreviewTarget } from "@/components/session/session-file-preview-context"

export type SessionToolKind = "review" | "terminal" | "files"

export type SessionToolTab = {
  id: string
  kind: SessionToolKind
  title: string | null
  terminal: TerminalView | null
  filePreview: SessionFilePreviewTarget | null
  error: string | null
}

export type SessionToolTabsState = {
  open: boolean
  expanded: boolean
  preferredWidth: number | null
  resizing: boolean
  tabs: SessionToolTab[]
  activeTabId: string | null
}

export type SessionToolTabsAction =
  | { type: "toggle-sidebar" }
  | { type: "collapse-sidebar" }
  | { type: "toggle-expanded" }
  | { type: "set-preferred-width"; width: number }
  | { type: "set-resizing"; resizing: boolean }
  | { type: "open-tool"; tab: SessionToolTab }
  | { type: "activate-tab"; id: string }
  | { type: "close-tab"; id: string }
  | { type: "set-tab-title"; id: string; title: string | null }
  | { type: "resolve-terminal"; id: string; terminal: TerminalView }
  | { type: "fail-terminal"; id: string; error: string }

export const INITIAL_SESSION_TOOL_TABS_STATE: SessionToolTabsState = {
  open: false,
  expanded: false,
  preferredWidth: null,
  resizing: false,
  tabs: [],
  activeTabId: null,
}

export function createSessionToolTab(
  id: string,
  kind: SessionToolKind,
  title: string | null = null,
): SessionToolTab {
  return { id, kind, title, terminal: null, filePreview: null, error: null }
}

export function createSessionFilePreviewTab(
  id: string,
  filePreview: SessionFilePreviewTarget,
): SessionToolTab {
  return {
    id,
    kind: "files",
    title: filePreview.name,
    terminal: null,
    filePreview,
    error: null,
  }
}

export function sessionToolTabsReducer(
  state: SessionToolTabsState,
  action: SessionToolTabsAction,
): SessionToolTabsState {
  if (action.type === "toggle-sidebar") {
    return state.open
      ? { ...state, open: false, expanded: false }
      : { ...state, open: true }
  }
  if (action.type === "collapse-sidebar") {
    return { ...state, open: false, expanded: false }
  }
  if (action.type === "toggle-expanded") {
    return { ...state, expanded: !state.expanded }
  }
  if (action.type === "set-preferred-width") {
    if (state.preferredWidth === action.width) return state
    return { ...state, preferredWidth: action.width }
  }
  if (action.type === "set-resizing") {
    if (state.resizing === action.resizing) return state
    return { ...state, resizing: action.resizing }
  }
  if (action.type === "open-tool") {
    const singleton = action.tab.kind === "review"
      || (action.tab.kind === "files" && !action.tab.filePreview)
    if (singleton) {
      const existing = state.tabs.find((tab) => (
        tab.kind === action.tab.kind
        && (tab.kind !== "files" || !tab.filePreview)
      ))
      if (existing) return { ...state, open: true, activeTabId: existing.id }
    }
    return {
      ...state,
      open: true,
      tabs: [...state.tabs, action.tab],
      activeTabId: action.tab.id,
    }
  }
  if (action.type === "activate-tab") {
    if (!state.tabs.some((tab) => tab.id === action.id)) return state
    return { ...state, activeTabId: action.id }
  }
  if (action.type === "close-tab") {
    const closedIndex = state.tabs.findIndex((tab) => tab.id === action.id)
    if (closedIndex === -1) return state
    const tabs = state.tabs.filter((tab) => tab.id !== action.id)
    const activeTabId = state.activeTabId === action.id
      ? tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null
      : state.activeTabId
    return { ...state, tabs, activeTabId }
  }
  if (action.type === "set-tab-title") {
    const tab = state.tabs.find((item) => item.id === action.id)
    if (!tab || tab.title === action.title) return state
    return {
      ...state,
      tabs: state.tabs.map((item) => (
        item.id === action.id ? { ...item, title: action.title } : item
      )),
    }
  }
  if (action.type === "resolve-terminal") {
    const pending = state.tabs.find((tab) => tab.id === action.id && tab.kind === "terminal")
    if (!pending) return state
    return {
      ...state,
      tabs: state.tabs.map((tab) => (
        tab.id === action.id
          ? { ...tab, title: action.terminal.label || tab.title, terminal: action.terminal, error: null }
          : tab
      )),
    }
  }
  if (action.type === "fail-terminal") {
    const tab = state.tabs.find((item) => item.id === action.id && item.kind === "terminal")
    if (!tab) return state
    return {
      ...state,
      tabs: state.tabs.map((item) => (
        item.id === action.id ? { ...item, error: action.error } : item
      )),
    }
  }
  return state
}
