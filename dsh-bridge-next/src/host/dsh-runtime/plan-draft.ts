import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function partialString(raw: string): string | undefined {
  const match = /"plan"\s*:\s*"/.exec(raw)
  if (!match) return undefined
  const start = match.index + match[0].length - 1
  let escape = false
  for (let i = start + 1; i < raw.length; i++) {
    if (raw[i] === '"' && !escape) {
      try { return JSON.parse(raw.slice(start, i + 1)) as string } catch { return undefined }
    }
    escape = raw[i] === '\\' && !escape
  }
  for (let trim = 0; trim < 7 && trim < raw.length - start; trim++) {
    try { return (JSON.parse(`${raw.slice(start, raw.length - trim)}"`) as string).replace(/[\uD800-\uDBFF]$/, '') } catch { /* split escape */ }
  }
  return undefined
}
export class PlanDrafts {
  private calls = new Map<string, { id: string, name: string, args: string, closed?: boolean }>()
  reset(session: string) {
    for (const key of this.calls.keys()) if (key.startsWith(`${session}:`)) this.calls.delete(key)
  }
  observe(session: string, turn: number, step: number, chunk: StreamChunk) {
    if (!('index' in chunk)) return undefined
    const key = `${session}:${turn}:${step}:${chunk.index}`
    if (chunk.type === 'block-start') {
      const start = chunk as unknown as { id?: string, name?: string }
      this.calls.set(key, { id: start.id ?? key, name: start.name ?? '', args: '' }); return undefined
    }
    if (chunk.type !== 'tool-call-delta' && chunk.type !== 'block-end') return undefined
    const old = this.calls.get(key)
    if (old?.closed) return undefined
    let call: { id: string, name: string, args: string, closed?: boolean }
    if (chunk.type === 'block-end') {
      if (chunk.block.type !== 'tool-call') return undefined
      call = { id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments, closed: true }
    } else {
      const same = !old || !chunk.id || old.id === chunk.id
      call = { id: chunk.id ?? old?.id ?? key, name: chunk.name ?? (same ? old?.name : '') ?? '', args: (same ? old?.args ?? '' : '') + (chunk.argumentsDelta ?? '') }
    }
    if (call.args.length > 4 * 1024 * 1024) { this.calls.delete(key); return undefined }
    this.calls.set(key, call)
    if (this.calls.size > 128) this.calls.delete(this.calls.keys().next().value!)
    const text = call.name === 'exit_plan_mode' ? partialString(call.args) : undefined
    return text === undefined ? undefined : { kind: 'draft', nativeId: call.id, text }
  }
}
