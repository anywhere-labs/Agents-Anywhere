import { itemId } from './identity.js'
import { json, record, type Data, type Json } from './types.js'

export function toolContent(name: string, rawArguments: unknown): Data {
  let input: Json = typeof rawArguments === 'string' ? rawArguments : json(rawArguments ?? {})
  if (typeof rawArguments === 'string') {
    try { input = JSON.parse(rawArguments) as Json } catch { /* Preserve incomplete or invalid JSON verbatim. */ }
  }
  const args = record(input)
  const content: Data = { kind: 'tool_call', title: name, toolName: name, input }
  if (name === 'bash' || name === 'pwsh') {
    content.kind = 'command'
    if (typeof args.command === 'string') content.command = args.command
  } else if (name === 'web_search') {
    content.kind = 'web_search'
    if (typeof args.query === 'string') content.query = args.query
  } else if (name === 'ask_user_question' || name === 'exit_plan_mode') {
    content.kind = 'input_request'
    content.readOnly = true
  } else if (name.startsWith('mcp__')) {
    content.kind = 'mcp'
    // The full registration name is authoritative; normalized names may contain hashes.
    content.name = name
  } else {
    const action: Record<string, string> = {
      subagent: 'invoke', subagent_fork: 'spawn', send_message: 'send_input',
      wait_agent: 'wait', interrupt_agent: 'close', list_agents: 'unknown',
    }
    if (action[name]) {
      content.kind = 'agent_call'
      content.action = action[name]!
      if (typeof args.target === 'string') content.targetIds = [args.target]
    }
  }
  return content
}

export function resultContent(blocks: unknown): { output: string, result: Json } {
  const values = Array.isArray(blocks) ? blocks : []
  const output = values.map(block => {
    const value = record(block)
    if (value.type === 'image') return '[图片暂不支持跨设备预览]'
    return typeof value.text === 'string' ? value.text : ''
  }).filter(Boolean).join('\n')
  return { output, result: json(values) }
}

export function enrichToolResult(content: Data, meta: unknown): Data {
  const result: Data = { ...content }
  if (meta !== undefined) result.dshResultMeta = json(meta)
  if (content.isError === true) return result

  // Native write creates deliberately have empty meta.diffs. The successful
  // result identifies the operation; the call arguments hold the full new file.
  const writeStatus = content.toolName === 'write' && typeof content.output === 'string'
    ? /^<path>[\s\S]*<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\n(Created|Updated) file\r?\n<\/content>$/.exec(content.output.trim())?.[1]
    : undefined
  const input = record(content.input)
  if (writeStatus === 'Created' && typeof input.file_path === 'string' && input.file_path.trim()
      && typeof input.content === 'string') {
    result.kind = 'file_change'
    result.changes = [{ path: input.file_path, kind: 'add', diff: diffLines(input.content, '+'), contextual: false }]
    return result
  }

  const diffs = record(meta).diffs
  if (['write', 'edit', 'str_replace_editor'].includes(String(content.toolName)) &&
      Array.isArray(diffs) && diffs.length && diffs.every(diff => {
        const d = record(diff)
        return typeof d.path === 'string' && (d.oldText === null || typeof d.oldText === 'string') && typeof d.newText === 'string'
      })) {
    result.kind = 'file_change'
    // Native diffs are contextual excerpts, NOT complete before/after files.
    result.changes = diffs.map(diff => {
      const d = record(diff)
      // A pure insertion hunk can have oldText=null even in an existing file.
      return { path: d.path as string, kind: writeStatus === 'Updated' ? 'update' : d.oldText === null ? 'add' : 'update',
        diff: [diffLines(d.oldText as string | null, '-'), diffLines(d.newText as string, '+')].filter(Boolean).join('\n'),
        contextual: true }
    })
  }
  return result
}

function diffLines(text: string | null, prefix: '+' | '-'): string {
  if (!text) return ''
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(line => `${prefix}${line}`).join('\n')
}

export function parentToolItem(externalId: string, callId: string): string {
  return itemId(externalId, 'tool', callId)
}
