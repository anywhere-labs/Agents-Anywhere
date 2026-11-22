// A small parser for `git diff` output (Device/git_diff): one entry per file with its hunks' lines and +/− counts.

export interface DiffLine {
  kind: "add" | "del" | "same" | "hunk"
  text: string
}

export interface DiffFile {
  path: string
  /** Previous path for renames. */
  from?: string
  status: "modified" | "added" | "deleted" | "renamed" | "binary"
  additions: number
  deletions: number
  lines: DiffLine[]
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      cur = { path: m?.[2] ?? raw.slice(11), status: "modified", additions: 0, deletions: 0, lines: [] }
      if (m && m[1] !== m[2]) {
        cur.from = m[1]
        cur.status = "renamed"
      }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (raw.startsWith("new file mode")) cur.status = "added"
    else if (raw.startsWith("deleted file mode")) cur.status = "deleted"
    else if (raw.startsWith("Binary files")) cur.status = "binary"
    else if (raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("index ")) continue
    else if (raw.startsWith("rename from") || raw.startsWith("rename to") || raw.startsWith("similarity index")) continue
    else if (raw.startsWith("@@")) cur.lines.push({ kind: "hunk", text: raw })
    else if (raw.startsWith("+")) {
      cur.additions++
      cur.lines.push({ kind: "add", text: raw.slice(1) })
    } else if (raw.startsWith("-")) {
      cur.deletions++
      cur.lines.push({ kind: "del", text: raw.slice(1) })
    } else if (raw.startsWith(" ")) cur.lines.push({ kind: "same", text: raw.slice(1) })
    else if (raw === "\\ No newline at end of file") continue
  }
  return files
}
