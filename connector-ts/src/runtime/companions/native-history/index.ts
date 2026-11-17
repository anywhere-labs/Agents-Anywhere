// Native history companion layer: read-only indexing and replay of the session history a Runtime records locally (04-connector.md §2 companions/native-history).

export { dirNames, firstLine, walkJsonl, within, type WalkError } from './files.js'
export { MAX_HISTORY_BYTES, PiHistory, attachmentInfos, piHistoryEvents, piHistoryPage, piTimeline, readPiHistory, textContent, type PiTimelineItem } from './pi-history.js'
export { PAGE_SIZE, PiNativeIndex, summary, type PiAliasLookup, type PiSource } from './pi-index.js'
