// A line diff of an edit's old_text / new_text (ACP diffs carry both sides, not a patch), as rows for Code Block's
// added / removed line variants. Plain LCS: edits are small; anything huge falls back to "all removed, all added".
export type DiffRow = { kind: 'same' | 'add' | 'del'; text: string }

/**
 * Memoised by the two strings (pushed items are replaced whole, so an edit's strings are the same objects every time
 * its turn re-renders): the LCS runs once per edit, not once per render. Bounded; cleared when it grows past that.
 */
const memo = new Map<string, Map<string, DiffRow[]>>()
let memoSize = 0

export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const hit = memo.get(oldText)?.get(newText)
  if (hit) return hit
  if (memoSize > 300) {
    memo.clear()
    memoSize = 0
  }
  const rows = computeLineDiff(oldText, newText)
  let inner = memo.get(oldText)
  if (!inner) memo.set(oldText, (inner = new Map()))
  inner.set(newText, rows)
  memoSize++
  return rows
}

export function clearDiffMemo() {
  memo.clear()
  memoSize = 0
}

function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText ? oldText.replace(/\n$/, '').split('\n') : []
  const b = newText ? newText.replace(/\n$/, '').split('\n') : []
  if (a.length * b.length > 400_000) return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push({ kind: 'del', text: a[i++] })
    else rows.push({ kind: 'add', text: b[j++] })
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++] })
  while (j < m) rows.push({ kind: 'add', text: b[j++] })
  return rows
}

export function diffCounts(rows: DiffRow[]) {
  let additions = 0
  let deletions = 0
  for (const r of rows) {
    if (r.kind === 'add') additions++
    else if (r.kind === 'del') deletions++
  }
  return { additions, deletions }
}
