// In-memory session store: the Connector is the only source of truth for conversations (the v3 Server keeps none).
//
// Holds, per session: the `Session`, its ordered items (`seq` = position from 0), the `Control`, the sidebar flags
// (`unread`, `pinned`) and the `client_msg_id` → message id idempotency map. Every change is pushed to watchers as
// the whole current value (`watch` = snapshot, then replacements by id); each watcher keeps only the newest value
// per item, so a slow client skips frames instead of falling behind.
//
// Persistence is outside: `exportSnapshot()` / `loadSnapshot()` plus the `onChange` hook let
// `runtime/state-store.ts` save and restore. Portable: no Node built-ins.

import { InvalidArgumentError, MeshCallError, z } from "meshcall";

import {
  AssistantMessageSchema,
  ControlSchema,
  emptyControl,
  MessageSchema,
  SessionSchema,
  sessionToSummary,
  type AnsweredRequest,
  type AssistantMessage,
  type ConfigOption,
  type Control,
  type FilePart,
  type ImagePart,
  type Instant,
  type Message,
  type PendingRequest,
  type Session,
  type SessionList,
  type SessionListEvent,
  type SessionSummary,
  type UserMessage,
  type UserPart,
  type WatchEvent,
} from "./timeline.js";

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type SessionStoreErrorReason = "session_not_found" | "message_not_found" | "already_answered" | "not_pending";

/** Application error codes the session services answer with (`not_found`, `failed_precondition`). */
export class SessionStoreError extends MeshCallError {
  override readonly name = "SessionStoreError";

  constructor(code: "not_found" | "failed_precondition", reason: SessionStoreErrorReason, message: string, details: Record<string, unknown> = {}) {
    super(code, message, { details: { ...details, reason } });
  }

  static sessionNotFound(id: string): SessionStoreError {
    return new SessionStoreError("not_found", "session_not_found", `no session ${id}`, { session_id: id });
  }

  static messageNotFound(id: string): SessionStoreError {
    return new SessionStoreError("not_found", "message_not_found", `no message ${id}`, { message_id: id });
  }

  /** The first answer won; `answered` says who and how, for "已由某某在某设备上处理". */
  static alreadyAnswered(answered: AnsweredRequest): SessionStoreError {
    return new SessionStoreError("failed_precondition", "already_answered", `request ${answered.request_id} was already answered`, {
      answered,
    });
  }

  static notPending(requestId: string): SessionStoreError {
    return new SessionStoreError("failed_precondition", "not_pending", `request ${requestId} is not waiting for an answer`, {
      request_id: requestId,
    });
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  agent: string;
  title?: string;
  cwd?: string;
  branch?: string;
  config?: ConfigOption[];
  /** Defaults to a fresh id. */
  id?: string;
  steer?: Control["steer"];
  forked_from?: Session["forked_from"];
}

export interface AppendUserMessageInput {
  client_msg_id: string;
  content: string;
  author?: string;
  steered?: boolean;
  attachments?: (ImagePart | FilePart)[];
}

/** An assistant item as the projector writes it; `seq` and `created_at` are kept from its first appearance. */
export type AssistantItemInput = Omit<AssistantMessage, "seq" | "created_at" | "role"> & { created_at?: Instant };

export interface AnswerInput {
  request_id: string;
  option_id: string;
  /** Who answered (display name). */
  by: string;
  /** On which device. */
  device?: string;
}

export interface AnswerResult {
  request: PendingRequest;
  answered: AnsweredRequest;
}

export type SessionPatch = Partial<Pick<Session, "title" | "cwd" | "branch" | "config" | "agent">>;

/** `undefined` deletes an optional field. */
export type ControlPatch = { [K in keyof Control]?: Control[K] | undefined };

export type AnswerListener = (sessionId: string, result: AnswerResult) => void;

export interface SessionStoreOptions {
  /** This Connector, written into every session. */
  device: { id: string; name: string };
  /** Clock, for tests. */
  now?: () => number;
  /** Id factory, for tests. */
  newId?: () => string;
  /** Items in a watch snapshot (extended to a turn start). */
  snapshotLimit?: number;
  /** Answered requests kept in `control.answered`. */
  answeredLimit?: number;
  /** Called synchronously after every change; debounce persistence there. */
  onChange?: () => void;
}

export interface WatchOptions {
  signal?: AbortSignal;
}

// ── Snapshot (persistence) ──────────────────────────────────────────────────────────────────────────────────────

export const SessionRecordSnapshotSchema = z.object({
  session: SessionSchema,
  messages: z.array(MessageSchema),
  control: ControlSchema,
  unread: z.boolean(),
  pinned: z.boolean(),
  client_msg_ids: z.record(z.string(), z.string()),
});

export const SessionStoreSnapshotSchema = z.object({
  version: z.literal(1),
  sessions: z.array(SessionRecordSnapshotSchema),
});

export type SessionRecordSnapshot = z.infer<typeof SessionRecordSnapshotSchema>;
export type SessionStoreSnapshot = z.infer<typeof SessionStoreSnapshotSchema>;

export interface LoadSnapshotOptions {
  /**
   * The agent processes behind a saved snapshot are gone: stop showing sessions as running, drop their pending
   * requests and close unfinished items as interrupted. Default `true`.
   */
  resetLive?: boolean;
}

// ── Coalescing watcher queue ────────────────────────────────────────────────────────────────────────────────────

const SNAPSHOT = "snapshot";

/**
 * An async iterator over keyed, lazily computed values. Setting a key that is still queued keeps its place and
 * replaces its value; values are computed when the consumer pulls, so they are always the newest. A queued
 * snapshot makes every other push redundant.
 */
class CoalescingQueue<T> implements AsyncIterableIterator<T> {
  private readonly items = new Map<string, () => T | undefined>();
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  constructor(private readonly onClose: () => void) {}

  push(key: string, value: () => T | undefined): void {
    if (this.closed) return;
    if (this.waiter !== undefined) {
      const item = value();
      if (item === undefined) return;
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: item, done: false });
      return;
    }
    if (key !== SNAPSHOT && this.items.has(SNAPSHOT)) return;
    this.items.set(key, value);
  }

  /** Drop everything queued and start over with a snapshot. */
  reset(snapshot: () => T | undefined): void {
    this.items.clear();
    this.push(SNAPSHOT, snapshot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.items.clear();
    this.onClose();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    for (const [key, thunk] of this.items) {
      this.items.delete(key);
      const value = thunk();
      if (value !== undefined) return Promise.resolve({ value, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

function bindSignal(queue: { close(): void }, signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (signal.aborted) queue.close();
  else signal.addEventListener("abort", () => queue.close(), { once: true });
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface SessionRecord {
  session: Session;
  messages: Message[];
  /** message id → index in `messages`. */
  index: Map<string, number>;
  control: Control;
  unread: boolean;
  pinned: boolean;
  /** client_msg_id → user message id. */
  clientMsgIds: Map<string, string>;
  watchers: Set<CoalescingQueue<WatchEvent>>;
}

const clone = <T>(value: T): T => structuredClone(value);

const DEFAULT_SNAPSHOT_LIMIT = 100;
const MAX_PAGE = 500;

export class SessionStore {
  readonly device: { id: string; name: string };
  private readonly records = new Map<string, SessionRecord>();
  private readonly listWatchers = new Set<CoalescingQueue<SessionListEvent>>();
  private readonly answerListeners = new Set<AnswerListener>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly snapshotLimit: number;
  private readonly answeredLimit: number;
  private readonly onChange: (() => void) | undefined;

  constructor(options: SessionStoreOptions) {
    this.device = { ...options.device };
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.snapshotLimit = options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
    this.answeredLimit = options.answeredLimit ?? 20;
    this.onChange = options.onChange;
  }

  // ── Sessions ──

  list(): SessionList {
    const records = [...this.records.values()].sort((a, b) => compareDesc(a.session.updated_at, b.session.updated_at));
    const sessions: SessionSummary[] = records.map((r) => sessionToSummary(clone(r.session), r.control, r.unread, r.pinned));
    const projects: string[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      if (!seen.has(r.session.cwd)) {
        seen.add(r.session.cwd);
        projects.push(r.session.cwd);
      }
    }
    return { sessions, projects };
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): Session | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : clone(record.session);
  }

  getControl(id: string): Control {
    return clone(this.require(id).control);
  }

  getMessage(id: string, messageId: string): Message | undefined {
    const record = this.require(id);
    const index = record.index.get(messageId);
    return index === undefined ? undefined : clone(record.messages[index]);
  }

  summary(id: string): SessionSummary {
    const r = this.require(id);
    return sessionToSummary(clone(r.session), r.control, r.unread, r.pinned);
  }

  create(input: CreateSessionInput): Session {
    const id = input.id ?? this.newId();
    if (this.records.has(id)) throw new InvalidArgumentError(`session ${id} already exists`);
    const at = this.iso();
    const session: Session = {
      id,
      title: input.title ?? "",
      agent: input.agent,
      device: { ...this.device },
      cwd: input.cwd ?? "",
      created_at: at,
      updated_at: at,
      message_count: 0,
      config: clone(input.config ?? []),
    };
    if (input.branch !== undefined) session.branch = input.branch;
    if (input.forked_from !== undefined) session.forked_from = { ...input.forked_from };
    this.records.set(id, {
      session,
      messages: [],
      index: new Map(),
      control: emptyControl(input.steer),
      unread: false,
      pinned: false,
      clientMsgIds: new Map(),
      watchers: new Set(),
    });
    this.changed(undefined, { list: true });
    return clone(session);
  }

  rename(id: string, title: string): Session {
    return this.updateSession(id, { title });
  }

  updateSession(id: string, patch: SessionPatch): Session {
    const record = this.require(id);
    const session = record.session;
    if (patch.title !== undefined) session.title = patch.title;
    if (patch.cwd !== undefined) session.cwd = patch.cwd;
    if (patch.agent !== undefined) session.agent = patch.agent;
    if (patch.config !== undefined) session.config = clone(patch.config);
    if ("branch" in patch) {
      if (patch.branch === undefined) delete session.branch;
      else session.branch = patch.branch;
    }
    session.updated_at = this.iso();
    this.changed(record, { session: true, list: true });
    return clone(session);
  }

  delete(id: string): boolean {
    const record = this.records.get(id);
    if (record === undefined) return false;
    this.records.delete(id);
    for (const watcher of [...record.watchers]) watcher.close();
    this.changed(undefined, { list: true });
    return true;
  }

  setUnread(id: string, unread: boolean): void {
    const record = this.require(id);
    if (record.unread === unread) return;
    record.unread = unread;
    this.changed(undefined, { list: true });
  }

  setPinned(id: string, pinned: boolean): void {
    const record = this.require(id);
    if (record.pinned === pinned) return;
    record.pinned = pinned;
    this.changed(undefined, { list: true });
  }

  // ── Items ──

  /** Idempotent on `client_msg_id`: a repeat returns the message it created, with `duplicate: true`. */
  appendUserMessage(id: string, input: AppendUserMessageInput): { message: UserMessage; duplicate: boolean } {
    const record = this.require(id);
    if (!input.client_msg_id) throw new InvalidArgumentError("client_msg_id is required");
    const existingId = record.clientMsgIds.get(input.client_msg_id);
    if (existingId !== undefined) {
      const index = record.index.get(existingId);
      const existing = index === undefined ? undefined : record.messages[index];
      if (existing?.role === "user") return { message: clone(existing), duplicate: true };
    }
    const parts: UserPart[] = [];
    if (input.content.length > 0) parts.push({ type: "text", text: input.content });
    for (const attachment of input.attachments ?? []) parts.push(clone(attachment));
    if (parts.length === 0) throw new InvalidArgumentError("a message needs content or attachments");

    const message: UserMessage = {
      id: this.newId(),
      role: "user",
      created_at: this.iso(),
      seq: record.messages.length,
      done: true,
      client_msg_id: input.client_msg_id,
      rewindable: true,
      parts,
    };
    if (input.author !== undefined) message.author = input.author;
    if (input.steered) message.steered = true;
    this.insert(record, message);
    record.clientMsgIds.set(input.client_msg_id, message.id);
    this.changed(record, { message: message.id, session: true, list: true });
    return { message: clone(message), duplicate: false };
  }

  /** Whole replacement by `item.id`; the first appearance takes the next `seq`. */
  upsertAssistantItem(id: string, item: AssistantItemInput): AssistantMessage {
    const record = this.require(id);
    const index = record.index.get(item.id);
    const previous = index === undefined ? undefined : record.messages[index];
    if (previous !== undefined && previous.role !== "assistant") {
      throw new InvalidArgumentError(`message ${item.id} is a user message`);
    }
    const { created_at, ...rest } = clone(item);
    const message: AssistantMessage = AssistantMessageSchema.parse({
      ...rest,
      role: "assistant",
      seq: previous?.seq ?? record.messages.length,
      created_at: previous?.created_at ?? created_at ?? this.iso(),
    }) as AssistantMessage;
    if (previous === undefined || index === undefined) {
      this.insert(record, message);
    } else {
      record.messages[index] = message;
      record.session.updated_at = this.iso();
    }
    const fresh = previous === undefined;
    this.changed(record, { message: message.id, session: fresh, list: fresh || previous.done !== message.done });
    return clone(message);
  }

  /**
   * Items before `before_seq` (all when omitted), the newest `limit` of them, extended back to the start of the
   * turn the page boundary would cut.
   */
  listMessages(id: string, options: { before_seq?: number; limit?: number } = {}): { messages: Message[]; has_more: boolean } {
    const record = this.require(id);
    const messages = record.messages;
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(options.limit ?? this.snapshotLimit)));
    let end = messages.length;
    if (options.before_seq !== undefined) {
      end = 0;
      while (end < messages.length && (messages[end]?.seq ?? Infinity) < options.before_seq) end++;
    }
    let start = Math.max(0, end - limit);
    while (start > 0 && start < end && !isTurnStart(messages, start)) start--;
    return { messages: clone(messages.slice(start, end)), has_more: start > 0 };
  }

  /** Remove `messageId` and everything after it. Watchers get a new snapshot. Returns the removed items. */
  rewind(id: string, messageId: string): { removed: Message[] } {
    const record = this.require(id);
    const index = record.index.get(messageId);
    if (index === undefined) throw SessionStoreError.messageNotFound(messageId);
    const removed = record.messages.splice(index);
    const removedIds = new Set(removed.map((m) => m.id));
    for (const m of removed) record.index.delete(m.id);
    for (const [clientMsgId, messageIdOf] of record.clientMsgIds) {
      if (removedIds.has(messageIdOf)) record.clientMsgIds.delete(clientMsgId);
    }
    record.control.pending = record.control.pending.filter((p) => !removedIds.has(p.message_id));
    record.session.message_count = record.messages.length;
    record.session.updated_at = this.iso();
    for (const watcher of record.watchers) watcher.reset(() => this.snapshotEvent(record));
    this.changed(undefined, { list: true });
    return { removed: clone(removed) };
  }

  /** A new session with the items up to and including `messageId`, all finished. */
  fork(id: string, messageId: string, title?: string): Session {
    const source = this.require(id);
    const index = source.index.get(messageId);
    if (index === undefined) throw SessionStoreError.messageNotFound(messageId);
    const createInput: CreateSessionInput = {
      agent: source.session.agent,
      title: title ?? source.session.title,
      cwd: source.session.cwd,
      config: source.session.config,
      steer: source.control.steer,
      forked_from: { session_id: id, message_id: messageId },
    };
    if (source.session.branch !== undefined) createInput.branch = source.session.branch;
    const forked = this.create(createInput);
    const record = this.require(forked.id);
    for (const original of source.messages.slice(0, index + 1)) {
      const message = clone(original);
      message.done = true;
      this.insert(record, message);
      if (message.role === "user" && message.client_msg_id !== undefined) record.clientMsgIds.set(message.client_msg_id, message.id);
    }
    this.changed(undefined, { list: true });
    return clone(record.session);
  }

  // ── Control ──

  updateControl(id: string, patch: ControlPatch): Control {
    const record = this.require(id);
    const before = sessionToSummary(record.session, record.control, false, false).state;
    const control = record.control as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete control[key];
      else control[key] = clone(value);
    }
    const after = sessionToSummary(record.session, record.control, false, false).state;
    this.changed(record, { control: true, list: before !== after });
    return clone(record.control);
  }

  addPendingRequest(id: string, request: PendingRequest): Control {
    const record = this.require(id);
    const pending = record.control.pending;
    const at = pending.findIndex((p) => p.request_id === request.request_id);
    if (at >= 0) pending[at] = clone(request);
    else pending.push(clone(request));
    this.changed(record, { control: true, list: true });
    return clone(record.control);
  }

  /** Withdraw a request without an answer (the turn was cancelled). */
  removePendingRequest(id: string, requestId: string): boolean {
    const record = this.require(id);
    const before = record.control.pending.length;
    record.control.pending = record.control.pending.filter((p) => p.request_id !== requestId);
    if (record.control.pending.length === before) return false;
    this.changed(record, { control: true, list: true });
    return true;
  }

  /** First answer wins; a later one throws `SessionStoreError.alreadyAnswered`. */
  answerPendingRequest(id: string, input: AnswerInput): AnswerResult {
    const record = this.require(id);
    const control = record.control;
    const prior = control.answered?.find((a) => a.request_id === input.request_id);
    if (prior !== undefined) throw SessionStoreError.alreadyAnswered(clone(prior));
    const index = control.pending.findIndex((p) => p.request_id === input.request_id);
    const request = control.pending[index];
    if (request === undefined) throw SessionStoreError.notPending(input.request_id);
    if (!request.options.some((o) => o.id === input.option_id)) {
      throw new InvalidArgumentError(`request ${input.request_id} has no option ${input.option_id}`);
    }
    control.pending.splice(index, 1);
    const answered: AnsweredRequest = { request_id: input.request_id, by: input.by, option_id: input.option_id, at: this.iso() };
    if (input.device !== undefined) answered.device = input.device;
    control.answered = [...(control.answered ?? []), answered].slice(-this.answeredLimit);
    this.changed(record, { control: true, list: true });
    const result: AnswerResult = { request: clone(request), answered: clone(answered) };
    for (const listener of [...this.answerListeners]) {
      try {
        listener(id, clone(result));
      } catch {
        // A listener failing does not undo the answer.
      }
    }
    return result;
  }

  /** Told of every accepted answer (the ACP projector resolves the agent's permission request here). */
  addAnswerListener(listener: AnswerListener): () => void {
    this.answerListeners.add(listener);
    return () => this.answerListeners.delete(listener);
  }

  // ── Watch ──

  /** `watch({id})`: a snapshot, then whole replacements. Ends when the session is deleted or the caller stops. */
  subscribeSession(id: string, options: WatchOptions = {}): AsyncIterableIterator<WatchEvent> {
    const record = this.require(id);
    const queue: CoalescingQueue<WatchEvent> = new CoalescingQueue(() => record.watchers.delete(queue));
    record.watchers.add(queue);
    queue.reset(() => this.snapshotEvent(record));
    bindSignal(queue, options.signal);
    return queue;
  }

  /** `watch_list()`: a snapshot, then the whole list after changes (a slow watcher gets only the newest). */
  subscribeList(options: WatchOptions = {}): AsyncIterableIterator<SessionListEvent> {
    const queue: CoalescingQueue<SessionListEvent> = new CoalescingQueue(() => this.listWatchers.delete(queue));
    this.listWatchers.add(queue);
    queue.reset(() => ({ type: "snapshot", ...this.list() }));
    bindSignal(queue, options.signal);
    return queue;
  }

  /** Watchers of one session (diagnostics / tests). */
  watcherCount(id?: string): number {
    if (id === undefined) return this.listWatchers.size;
    return this.records.get(id)?.watchers.size ?? 0;
  }

  // ── Persistence ──

  exportSnapshot(): SessionStoreSnapshot {
    return {
      version: 1,
      sessions: [...this.records.values()].map((r) => ({
        session: clone(r.session),
        messages: clone(r.messages),
        control: clone(r.control),
        unread: r.unread,
        pinned: r.pinned,
        client_msg_ids: Object.fromEntries(r.clientMsgIds),
      })),
    };
  }

  /** Replace every session with a saved snapshot (validated). Live watchers get fresh snapshots or end. */
  loadSnapshot(input: unknown, options: LoadSnapshotOptions = {}): void {
    const snapshot = SessionStoreSnapshotSchema.parse(input);
    const resetLive = options.resetLive ?? true;
    const previous = new Map(this.records);
    this.records.clear();
    for (const saved of snapshot.sessions) {
      const messages = saved.messages as Message[];
      const record: SessionRecord = {
        session: saved.session as Session,
        messages: [],
        index: new Map(),
        control: saved.control as Control,
        unread: saved.unread,
        pinned: saved.pinned,
        clientMsgIds: new Map(Object.entries(saved.client_msg_ids)),
        watchers: previous.get(saved.session.id)?.watchers ?? new Set(),
      };
      for (const message of messages) {
        message.seq = record.messages.length;
        record.index.set(message.id, record.messages.length);
        record.messages.push(message);
        if (resetLive && !message.done) {
          message.done = true;
          if (message.role === "assistant") message.interrupted = true;
        }
      }
      for (const [clientMsgId, messageId] of record.clientMsgIds) {
        if (!record.index.has(messageId)) record.clientMsgIds.delete(clientMsgId);
      }
      record.session.message_count = record.messages.length;
      if (resetLive) {
        if (record.control.state === "running") record.control.state = "idle";
        record.control.pending = [];
      }
      this.records.set(record.session.id, record);
    }
    for (const [id, old] of previous) {
      const current = this.records.get(id);
      for (const watcher of [...old.watchers]) {
        if (current === undefined) watcher.close();
        else watcher.reset(() => this.snapshotEvent(current));
      }
    }
    this.changed(undefined, { list: true });
  }

  // ── Internals ──

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (record === undefined) throw SessionStoreError.sessionNotFound(id);
    return record;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private insert(record: SessionRecord, message: Message): void {
    message.seq = record.messages.length;
    record.index.set(message.id, record.messages.length);
    record.messages.push(message);
    record.session.message_count = record.messages.length;
    record.session.updated_at = this.iso();
  }

  private snapshotEvent(record: SessionRecord): WatchEvent | undefined {
    if (this.records.get(record.session.id) !== record) return undefined;
    const page = this.listMessages(record.session.id, { limit: this.snapshotLimit });
    return { type: "snapshot", session: clone(record.session), messages: page.messages, has_more: page.has_more, control: clone(record.control) };
  }

  private changed(record: SessionRecord | undefined, what: { message?: string; session?: boolean; control?: boolean; list?: boolean }): void {
    if (record !== undefined) {
      for (const watcher of record.watchers) {
        if (what.message !== undefined) {
          const messageId = what.message;
          watcher.push(`m:${messageId}`, () => {
            const index = record.index.get(messageId);
            const message = index === undefined ? undefined : record.messages[index];
            return message === undefined ? undefined : { type: "message", message: clone(message) };
          });
        }
        if (what.session) watcher.push("session", () => ({ type: "session", session: clone(record.session) }));
        if (what.control) watcher.push("control", () => ({ type: "control", control: clone(record.control) }));
      }
    }
    if (what.list) {
      for (const watcher of this.listWatchers) watcher.push("list", () => ({ type: "update", ...this.list() }));
    }
    try {
      this.onChange?.();
    } catch {
      // Persistence problems are the state store's to report.
    }
  }
}

// ── Turn boundaries ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a page may start at `messages[index]`: a user message that is not steered, or an assistant item opening
 * a turn (its `turn_id` differs from the turn the previous item belongs to).
 */
function isTurnStart(messages: Message[], index: number): boolean {
  const message = messages[index];
  if (message === undefined) return true;
  if (message.role === "user") return message.steered !== true;
  if (index === 0) return true;
  return turnOf(messages, index - 1) !== message.turn_id;
}

/** The turn an item belongs to; a steered user message belongs to the turn it was inserted into. */
function turnOf(messages: Message[], index: number): string | undefined {
  for (let i = index; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) return undefined;
    if (message.role === "assistant") return message.turn_id;
    if (message.steered !== true) return message.id;
  }
  return undefined;
}

function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}
