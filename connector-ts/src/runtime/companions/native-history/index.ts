// 原生历史伴随层：Runtime 自己记在本机的会话历史，只读索引与回放（04-connector.md §2 companions/native-history）。

export { dirNames, firstLine, walkJsonl, within, type WalkError } from './files.js'
export { MAX_HISTORY_BYTES, PiHistory, piHistoryEvents, piHistoryPage, piTimeline, readPiHistory, textContent, type PiTimelineItem } from './pi-history.js'
export { PAGE_SIZE, PiNativeIndex, summary, type PiSource } from './pi-index.js'
