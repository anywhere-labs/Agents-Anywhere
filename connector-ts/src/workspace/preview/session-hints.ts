// What port preview knows of the sessions on this device (09-port-preview.md §5.1): the root processes of their
// Agents and AA terminals, and the local URLs their tools and terminals printed.
import { localUrlMatches, type SessionHints } from './session-ports.js'

/** A process a session runs: its Agent, or the shell of one of its AA terminals. */
export interface SessionProcess {
  readonly pid: number
  readonly sessionId: string
}

// CSI sequences (colours, cursor moves), OSC sequences (titles, hyperlinks) and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu

/** `text` without terminal escape sequences (dev servers colour the port: `localhost:\x1b[1m5173\x1b[22m/`). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Ports remembered at most; the oldest mention goes first. */
export const PRINTED_PORTS_MAX = 128
/** Streams (terminals) whose unfinished last line is kept; the oldest goes first. */
const STREAMS_MAX = 64
/** The end of a stream's output kept for the next chunk, so a URL split between chunks is still found. */
const TAIL_CHARS = 512

/**
 * Local URLs sessions printed, by port; a later mention of a port replaces an earlier one. Text comes whole (a tool
 * result) or as a stream of chunks (`stream` names it): a URL that reaches the end of a chunk may continue in the
 * next one, so it is read once the next chunk arrives.
 */
export class PrintedUrls {
  private readonly urls = new Map<number, { sessionId: string; url: string }>()
  private readonly tails = new Map<string, string>()

  public observe(sessionId: string, text: string, stream?: string): void {
    if (sessionId === '' || text === '') return
    let scanned = stripAnsi(text)
    if (stream !== undefined) {
      scanned = (this.tails.get(stream) ?? '') + scanned
      this.tails.delete(stream)
      this.tails.set(stream, scanned.slice(-TAIL_CHARS))
      while (this.tails.size > STREAMS_MAX) this.tails.delete(this.tails.keys().next().value!)
    }
    for (const { port, url, end } of localUrlMatches(scanned)) {
      if (stream !== undefined && end === scanned.length) continue
      this.urls.delete(port)
      this.urls.set(port, { sessionId, url })
    }
    while (this.urls.size > PRINTED_PORTS_MAX) this.urls.delete(this.urls.keys().next().value!)
  }

  public mentioned(): ReadonlyMap<number, { sessionId: string; url: string }> {
    return this.urls
  }
}

/**
 * The hints `sessionOfPort` reads. A process listed twice keeps its first session: callers list a shared Agent
 * process's busy session first.
 */
export function sessionHints(processes: Iterable<SessionProcess>, mentioned: ReadonlyMap<number, { sessionId: string; url: string }>): SessionHints {
  const roots = new Map<number, string>()
  for (const process of processes) {
    if (Number.isInteger(process.pid) && process.pid > 1 && process.sessionId !== '' && !roots.has(process.pid)) roots.set(process.pid, process.sessionId)
  }
  return { roots, mentioned }
}
