# Limits

- **Snapshot mode for non-Chromium browsers.** Only Chromium-class browsers can
  read a directory directly. Elsewhere use **选择文件夹（快照模式）** or drag the
  folder onto the page — a one-shot read, so pick the folder again to refresh.
- **Directory memory lives in the browser, not on disk** (IndexedDB, keyed by
  the board's file path). Snapshot mode is never remembered. Chromium may ask
  once via **恢复上次目录**; switching browsers or clearing site data asks you to
  pick again.
- If the browser refuses the directory picker, the board falls back to
  snapshot mode by itself and says so.
- **Read-only.** No task status changes and no spec edits; the CLI is the only
  writer.
- **Out of scope by design.** `.state/` snapshots and legacy
  `workspace/*/journal-*.md` are not read; the runtime read side only honours
  `sessions/`.
- **Dangling detection is textual.** A document that spells the reference
  syntax out as an example counts as a reference, so a few false positives can
  appear in task artifacts. The board shows the source file for every hit.
- The only network request is an optional web font; offline it degrades to
  local fonts and the page still renders.
