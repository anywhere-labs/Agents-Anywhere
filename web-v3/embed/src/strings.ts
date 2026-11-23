// The bundle's own words (the thread and terminal bring theirs). Two locales, set by native's `locale` message.

const zh = {
  loading: "正在加载对话…",
  empty: "还没有消息",
  stale: "离线 · 显示的是缓存内容，可能不是最新的",
  loadingOlder: "正在加载更早的消息…",
  loadOlder: "加载更早的消息",
  waiting: "等待原生层打开对话或终端",
  readonly: "只读",
}

export type EmbedStrings = typeof zh

const en: EmbedStrings = {
  loading: "Loading the conversation…",
  empty: "No messages yet",
  stale: "Offline · showing cached content, which may be out of date",
  loadingOlder: "Loading earlier messages…",
  loadOlder: "Load earlier messages",
  waiting: "Waiting for the app to open a conversation or a terminal",
  readonly: "Read-only",
}

export const STRINGS: Record<"zh-CN" | "en", EmbedStrings> = { "zh-CN": zh, en }
