/**
 * `aa.v3.Sessions`: conversations on this device, as `v3poc/protocol/services.ts` describes them, and the calls the
 * v3 control plane's MCP tools make (`server-v3/aa_control/services/mcp_service.py`):
 *
 *   read_session    → list_messages({ session_id, cursor?, limit? })
 *   create_session  → create({ agent, cwd, title? })
 *   send_message    → send({ session_id, text, wait? })
 *   stop_session    → stop({ session_id })
 *   answer_approval → answer({ session_id, approval_id, decision: "approve" | "reject", reason? })
 *
 * So most requests accept both spellings (`id` or `session_id`, `content` or `text`, …). Optional fields accept
 * `null`, which is how the Python control plane sends an absent value.
 *
 * Turns: an idle session starts a turn at once; a busy one queues the message (`control.queued`) and starts it when
 * the turn ends. `delivery: "steer"` (and `steer_queued`) interrupts the running turn and sends the message next:
 * ACP has no native mid-turn steering.
 */

import { stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { InvalidArgumentError, MeshCallError, method, service, z, type RpcContext } from "meshcall";

import type { AcpContentBlock } from "../core/acp-protocol.js";
import type { DeviceGate, GateDecision } from "../core/gate.js";
import { SessionStoreError, type SessionStore } from "../core/session-store.js";
import {
  MessageSchema,
  SessionListEventSchema,
  SessionListSchema,
  SessionSchema,
  WatchEventSchema,
  type FilePart,
  type ImagePart,
  type PermissionOptionKind,
  type QueuedMessage,
  type UserMessage,
} from "../core/timeline.js";
import { turnReplyText, type AcpRuntimeHost, type TurnResult } from "../runtime/acp-host.js";
import { resolveUserPath } from "../runtime/device-ops.js";
import type { TunnelStreamTracker } from "./device-admin-service.js";
import { rpcGuard } from "./device-service.js";

export interface SessionsServiceDeps {
  gate: DeviceGate;
  store: SessionStore;
  runtimes: AcpRuntimeHost;
  streams: TunnelStreamTracker;
  /** Called after a conversation is deleted (e.g. to remove its attachment folder). Errors are ignored. */
  onSessionDeleted?: (session: { id: string; cwd: string }) => unknown;
  /** Longest `send({ wait: true })` waits for the reply (the control plane gives MCP sends 30 s). Default 28 s. */
  waitTimeoutMs?: number;
  newId?: () => string;
}

// ── Schemas ─────────────────────────────────────────────────────────────────────────────────────────────────────

const OkSchema = z.object({ ok: z.literal(true) });
const IdSchema = z.object({ id: z.string().min(1) });
/** `id` (v3poc) or `session_id` (MCP). */
const SessionRefFields = { id: z.string().min(1).nullish(), session_id: z.string().min(1).nullish() };

const ListRequestSchema = z.object({ limit: z.number().int().positive().max(500).nullish() });
const EmptySchema = z.object({});

const CreateRequestSchema = z.object({
  agent: z.string().min(1).max(64),
  title: z.string().max(256).nullish(),
  cwd: z.string().min(1).nullish(),
  /** `config_id → value`, applied once the agent reports its options. */
  config: z.record(z.string(), z.string()).nullish(),
});

const RenameRequestSchema = z.object({ id: z.string().min(1), title: z.string().max(256) });

const ListMessagesRequestSchema = z.object({
  ...SessionRefFields,
  before_seq: z.number().int().nonnegative().nullish(),
  /** MCP paging: the `next_cursor` of the previous page. */
  cursor: z.string().nullish(),
  limit: z.number().int().positive().max(500).nullish(),
});
const ListMessagesResponseSchema = z.object({
  messages: z.array(MessageSchema),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
});

const AttachmentRefSchema = z.object({
  path: z.string().min(1),
  name: z.string().nullish(),
  mime: z.string().nullish(),
  size: z.number().int().nonnegative().nullish(),
});

const SendRequestSchema = z.object({
  ...SessionRefFields,
  client_msg_id: z.string().min(1).max(128).nullish(),
  content: z.string().nullish(),
  text: z.string().nullish(),
  delivery: z.enum(["auto", "steer", "queue"]).nullish(),
  wait: z.boolean().nullish(),
  attachments: z.array(AttachmentRefSchema).nullish(),
});
const SendResponseSchema = z.object({
  message_id: z.string(),
  session_id: z.string(),
  delivered: z.enum(["started", "steered", "queued"]),
  reply_text: z.string().optional(),
  /** With `wait`: how the turn ended (`end_turn`, `cancelled`, `error`, …); absent if it is still running. */
  turn_result: z.string().optional(),
  /** With `wait` and `turn_result: "error"`: what the agent reported (for example "Authentication required"). */
  error: z.string().optional(),
});

const AnswerRequestSchema = z.object({
  ...SessionRefFields,
  request_id: z.string().min(1).nullish(),
  approval_id: z.string().min(1).nullish(),
  option_id: z.string().min(1).nullish(),
  decision: z.enum(["approve", "reject"]).nullish(),
  reason: z.string().max(2000).nullish(),
});

const StopRequestSchema = z.object({ ...SessionRefFields });
const SetConfigRequestSchema = z.object({ id: z.string().min(1), config_id: z.string().min(1), value: z.string() });
const RewindRequestSchema = z.object({ id: z.string().min(1), message_id: z.string().min(1), content: z.string().nullish() });
const RewindResponseSchema = z.object({ message_id: z.string().optional() });
const ForkRequestSchema = z.object({ id: z.string().min(1), message_id: z.string().min(1), title: z.string().max(256).nullish() });
const CompactRequestSchema = z.object({ id: z.string().min(1), instructions: z.string().max(4000).nullish() });
const MessageIdResponseSchema = z.object({ message_id: z.string() });
const QueuedRefSchema = z.object({ id: z.string().min(1), client_msg_id: z.string().min(1) });
const SteeredSchema = z.object({ delivered: z.literal("steered") });

type Delivered = "started" | "steered" | "queued";

const ALLOW_KINDS: PermissionOptionKind[] = ["allow_once", "allow_always"];
const REJECT_KINDS: PermissionOptionKind[] = ["reject_once", "reject_always"];
const DEFAULT_WAIT_MS = 28_000;

function sessionRef(request: { id?: string | null; session_id?: string | null }): string {
  const id = request.id ?? request.session_id;
  if (!id) throw new InvalidArgumentError("id (or session_id) is required");
  return id;
}

interface Waiter {
  promise: Promise<{ messageId: string; result: TurnResult }>;
  resolve: (value: { messageId: string; result: TurnResult }) => void;
}

// ── Service ─────────────────────────────────────────────────────────────────────────────────────────────────────

@service("aa.v3.Sessions", { targeted: true, description: "Agent conversations on this device: list, watch, send, answer approvals." })
export class SessionsService {
  readonly #gate: DeviceGate;
  readonly #store: SessionStore;
  readonly #runtimes: AcpRuntimeHost;
  readonly #streams: TunnelStreamTracker;
  readonly #waitTimeoutMs: number;
  readonly #newId: () => string;
  readonly #onSessionDeleted: SessionsServiceDeps["onSessionDeleted"];
  /** Sessions with a turn in flight (set before the agent is even started, so concurrent sends queue). */
  readonly #turns = new Map<string, Promise<void>>();
  /** `sessionId\0client_msg_id` → the end of that message's turn. */
  readonly #waiters = new Map<string, Waiter>();
  /** Stopped sessions: the queue waits for the next send instead of draining. */
  readonly #held = new Set<string>();

  constructor(deps: SessionsServiceDeps) {
    this.#gate = deps.gate;
    this.#store = deps.store;
    this.#runtimes = deps.runtimes;
    this.#streams = deps.streams;
    this.#waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_MS;
    this.#newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
    this.#onSessionDeleted = deps.onSessionDeleted;
  }

  /** Whether a turn is in flight (diagnostics / tests). */
  isBusy(sessionId: string): boolean {
    return this.#turns.has(sessionId);
  }

  // ── Listing ──

  @method({ description: "Sessions on this device, newest first, and their project folders.", readOnly: true, request: ListRequestSchema, response: SessionListSchema })
  list(request: z.output<typeof ListRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const list = this.#store.list();
    if (request.limit != null) list.sessions = list.sessions.slice(0, request.limit);
    return list;
  }

  @method.serverStream({ description: "The session list: a snapshot, then the whole list after every change.", request: EmptySchema, outputItem: SessionListEventSchema })
  async *watch_list(_request: z.output<typeof EmptySchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const tracked = this.#streams.open(ctx);
    try {
      for await (const event of this.#store.subscribeList({ signal: tracked.signal })) yield event;
    } finally {
      tracked.close();
    }
  }

  // ── Lifecycle ──

  @method({ description: "Start a conversation with an agent runtime of this device.", idempotent: false, request: CreateRequestSchema, response: SessionSchema })
  async create(request: z.output<typeof CreateRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const runtimes = this.#runtimes;
    if (!runtimes.has(request.agent)) {
      throw new InvalidArgumentError(`no agent runtime "${request.agent}" on this device (have: ${runtimes.list().map((r) => r.id).join(", ") || "none"})`, {
        details: { reason: "unknown_agent" },
      });
    }
    const cwd = await rpcGuard(() => resolveUserPath(request.cwd ?? "~"));
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) throw new InvalidArgumentError(`${cwd} is not a directory on this device`, { details: { reason: "invalid_cwd" } });

    const session = this.#store.create({ agent: request.agent, title: request.title ?? "", cwd, steer: "interrupt" });
    try {
      await runtimes.ensureSession(session.id);
    } catch (error) {
      this.#store.delete(session.id);
      throw error;
    }
    for (const [configId, value] of Object.entries(request.config ?? {})) {
      try {
        await runtimes.setConfig(session.id, configId, value);
      } catch {
        // An option the agent does not offer is ignored: the session itself is fine.
      }
    }
    return this.#store.get(session.id) ?? session;
  }

  @method({ description: "Rename a session.", idempotent: true, request: RenameRequestSchema, response: SessionSchema })
  rename(request: z.output<typeof RenameRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    return this.#store.rename(request.id, request.title);
  }

  @method({ description: "Delete a session and stop its agent.", destructive: true, idempotent: true, request: IdSchema, response: OkSchema })
  async delete(request: z.output<typeof IdSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    await this.#runtimes.closeSession(request.id);
    const session = this.#store.has(request.id) ? this.#store.get(request.id) : undefined;
    this.#store.delete(request.id);
    this.#turns.delete(request.id);
    this.#held.delete(request.id);
    if (session) {
      try {
        await this.#onSessionDeleted?.({ id: session.id, cwd: session.cwd });
      } catch {
        // Cleanup is best effort.
      }
    }
    return { ok: true as const };
  }

  // ── Timeline ──

  @method.serverStream({ description: "One conversation: a snapshot, then whole replacements of what changed.", request: IdSchema, outputItem: WatchEventSchema })
  async *watch(request: z.output<typeof IdSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const tracked = this.#streams.open(ctx);
    try {
      for await (const event of this.#store.subscribeSession(request.id, { signal: tracked.signal })) yield event;
    } finally {
      tracked.close();
    }
  }

  @method({ description: "Older items: before `before_seq` (or `cursor`), never cutting a turn.", readOnly: true, request: ListMessagesRequestSchema, response: ListMessagesResponseSchema })
  list_messages(request: z.output<typeof ListMessagesRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const id = sessionRef(request);
    let beforeSeq = request.before_seq ?? undefined;
    if (beforeSeq === undefined && request.cursor) {
      const parsed = Number.parseInt(request.cursor, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new InvalidArgumentError("cursor is not valid");
      beforeSeq = parsed;
    }
    const page = this.#store.listMessages(id, {
      ...(beforeSeq !== undefined ? { before_seq: beforeSeq } : {}),
      ...(request.limit != null ? { limit: request.limit } : {}),
    });
    const first = page.messages[0];
    return page.has_more && first !== undefined ? { ...page, next_cursor: String(first.seq) } : page;
  }

  // ── Sending ──

  @method({
    description: "Send a message (idempotent on client_msg_id). Idle: starts a turn. Busy: queued, or `delivery: steer` interrupts and goes next. `wait` returns the reply.",
    // Idempotent only with a client_msg_id; MCP sends without one, so retries must not resend blindly.
    idempotent: false,
    request: SendRequestSchema,
    response: SendResponseSchema,
  })
  async send(request: z.output<typeof SendRequestSchema>, ctx: RpcContext) {
    const decision = this.#gate.assertBusinessCallAllowed(ctx);
    const id = sessionRef(request);
    const content = request.content ?? request.text ?? "";
    // No client_msg_id (MCP): the call's idempotency key, if any, keeps a retried send from posting twice.
    const clientMsgId = request.client_msg_id ?? (ctx.idempotencyKey ? `idem:${ctx.idempotencyKey}` : `auto:${this.#newId()}`);
    const author = this.#authorOf(decision, ctx);
    const attachments = (request.attachments ?? []).map(toAttachmentPart);
    if (content.length === 0 && attachments.length === 0) throw new InvalidArgumentError("a message needs content (or text) or attachments");
    this.#held.delete(id);

    const control = this.#store.getControl(id); // not_found for an unknown session
    const result = (message_id: string, delivered: Delivered) => ({ message_id, session_id: id, delivered });

    // Already queued, or already in the timeline: answer the same thing again.
    if (control.queued.some((q) => q.client_msg_id === clientMsgId)) return result(clientMsgId, "queued");
    const existing = this.#findUserMessage(id, clientMsgId);
    if (existing !== undefined) {
      const response: z.input<typeof SendResponseSchema> = result(existing.id, "started");
      if (request.wait && !this.#turns.has(id)) response.reply_text = turnReplyText(this.#store, id, existing.id);
      else if (request.wait) await this.#awaitReply(id, clientMsgId, existing.id, ctx, response);
      return response;
    }

    const waiter = request.wait ? this.#waiter(id, clientMsgId) : undefined;
    let response: z.input<typeof SendResponseSchema>;
    if (!this.#turns.has(id)) {
      const { message } = this.#store.appendUserMessage(id, { client_msg_id: clientMsgId, content, author, attachments });
      this.#startTurn(id, message);
      response = result(message.id, "started");
    } else {
      const queued: QueuedMessage = { client_msg_id: clientMsgId, author, content };
      if (attachments.length > 0) queued.attachments = attachments;
      if (request.delivery === "steer") {
        this.#store.updateControl(id, { queued: [queued, ...control.queued] });
        await this.#runtimes.cancel(id);
        response = result(clientMsgId, "steered");
      } else {
        this.#store.updateControl(id, { queued: [...control.queued, queued] });
        response = result(clientMsgId, "queued");
      }
    }
    if (waiter !== undefined) await this.#awaitReply(id, clientMsgId, undefined, ctx, response, waiter);
    return response;
  }

  @method({
    description: "Answer an agent's permission request; the first answer wins. MCP may pass `decision: approve | reject` instead of an option id.",
    request: AnswerRequestSchema,
    response: OkSchema,
  })
  answer(request: z.output<typeof AnswerRequestSchema>, ctx: RpcContext) {
    const decision = this.#gate.assertBusinessCallAllowed(ctx);
    const id = sessionRef(request);
    const requestId = request.request_id ?? request.approval_id;
    if (!requestId) throw new InvalidArgumentError("request_id (or approval_id) is required");
    let optionId = request.option_id ?? undefined;
    if (optionId === undefined) {
      if (request.decision == null) throw new InvalidArgumentError("option_id (or decision) is required");
      const pending = this.#store.getControl(id).pending.find((p) => p.request_id === requestId);
      if (pending === undefined) throw SessionStoreError.notPending(requestId);
      const kinds = request.decision === "approve" ? ALLOW_KINDS : REJECT_KINDS;
      for (const kind of kinds) {
        optionId = pending.options.find((o) => o.kind === kind)?.id;
        if (optionId !== undefined) break;
      }
      if (optionId === undefined) {
        throw new MeshCallError("failed_precondition", `request ${requestId} offers no "${request.decision}" option`, { details: { reason: "no_matching_option" } });
      }
    }
    this.#runtimes.runtimeFor(id).answerPermission(id, { request_id: requestId, option_id: optionId, by: this.#authorOf(decision, ctx) || "unknown" });
    return { ok: true as const };
  }

  @method({ description: "Stop the running turn. Queued messages wait for the next send.", idempotent: true, request: StopRequestSchema, response: OkSchema })
  async stop(request: z.output<typeof StopRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const id = sessionRef(request);
    this.#store.getControl(id); // not_found for an unknown session
    if (this.#turns.has(id)) {
      this.#held.add(id);
      await this.#runtimes.cancel(id);
    }
    return { ok: true as const };
  }

  @method({ description: "Change an agent setting (model, mode, …).", idempotent: true, request: SetConfigRequestSchema, response: SessionSchema })
  async set_config(request: z.output<typeof SetConfigRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const session = this.#store.get(request.id);
    if (session === undefined) throw SessionStoreError.sessionNotFound(request.id);
    if (!session.config.some((o) => o.id === request.config_id)) {
      throw new InvalidArgumentError(`the agent offers no setting "${request.config_id}"`, { details: { reason: "unknown_config" } });
    }
    await this.#runtimes.setConfig(request.id, request.config_id, request.value);
    return this.#store.get(request.id) ?? session;
  }

  @method({
    description: "Remove a message and everything after it; with `content`, send that instead. The agent restarts with a fresh context (ACP cannot truncate one).",
    destructive: true,
    request: RewindRequestSchema,
    response: RewindResponseSchema,
  })
  async rewind(request: z.output<typeof RewindRequestSchema>, ctx: RpcContext) {
    const decision = this.#gate.assertBusinessCallAllowed(ctx);
    const id = request.id;
    if (this.#store.getMessage(id, request.message_id) === undefined) throw SessionStoreError.messageNotFound(request.message_id);
    await this.#settleTurn(id);
    this.#store.rewind(id, request.message_id);
    await this.#runtimes.closeSession(id);
    if (!request.content) return {};
    const { message } = this.#store.appendUserMessage(id, {
      client_msg_id: `rewind:${this.#newId()}`,
      content: request.content,
      author: this.#authorOf(decision, ctx),
    });
    this.#startTurn(id, message);
    return { message_id: message.id };
  }

  @method({ description: "Copy a session up to a message into a new one.", request: ForkRequestSchema, response: SessionSchema })
  fork(request: z.output<typeof ForkRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    return this.#store.fork(request.id, request.message_id, request.title ?? undefined);
  }

  @method({ description: "Ask the agent to compact its context (agents that offer a /compact command).", request: CompactRequestSchema, response: MessageIdResponseSchema })
  async compact(request: z.output<typeof CompactRequestSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const id = request.id;
    if (this.#turns.has(id)) throw new MeshCallError("failed_precondition", "wait for the running turn to finish", { details: { reason: "turn_running" } });
    await this.#runtimes.ensureSession(id);
    if (!this.#runtimes.availableCommands(id).some((c) => c.name === "compact")) {
      throw new MeshCallError("failed_precondition", "this agent does not offer compaction", { details: { reason: "compact_unsupported" } });
    }
    const itemId = this.#newId();
    const at = new Date().toISOString();
    const part = { type: "compaction" as const, id: itemId, status: "running" as const, trigger: "manual" as const, at };
    this.#store.upsertAssistantItem(id, { id: itemId, turn_id: itemId, done: false, parts: [part] });
    const prompt: AcpContentBlock[] = [{ type: "text", text: request.instructions ? `/compact ${request.instructions}` : "/compact" }];
    this.#runTurn(id, itemId, prompt, undefined, (result) => {
      if (!this.#store.has(id)) return;
      const status = result === "error" ? "failed" : result === "cancelled" ? "cancelled" : "completed";
      this.#store.upsertAssistantItem(id, { id: itemId, turn_id: itemId, done: true, parts: [{ ...part, status, ended_at: new Date().toISOString() }] });
    });
    return { message_id: itemId };
  }

  @method({ description: "Send a queued message now, interrupting the running turn.", request: QueuedRefSchema, response: SteeredSchema })
  async steer_queued(request: z.output<typeof QueuedRefSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const control = this.#store.getControl(request.id);
    const item = control.queued.find((q) => q.client_msg_id === request.client_msg_id);
    if (item === undefined) throw queuedNotFound(request.client_msg_id);
    this.#store.updateControl(request.id, { queued: [item, ...control.queued.filter((q) => q !== item)] });
    this.#held.delete(request.id);
    if (this.#turns.has(request.id)) await this.#runtimes.cancel(request.id);
    else this.#drainQueue(request.id);
    return { delivered: "steered" as const };
  }

  @method({ description: "Remove a queued message.", idempotent: true, request: QueuedRefSchema, response: OkSchema })
  unqueue(request: z.output<typeof QueuedRefSchema>, ctx: RpcContext) {
    this.#gate.assertBusinessCallAllowed(ctx);
    const control = this.#store.getControl(request.id);
    if (!control.queued.some((q) => q.client_msg_id === request.client_msg_id)) throw queuedNotFound(request.client_msg_id);
    this.#store.updateControl(request.id, { queued: control.queued.filter((q) => q.client_msg_id !== request.client_msg_id) });
    return { ok: true as const };
  }

  // ── Turns ──

  #startTurn(sessionId: string, message: UserMessage): void {
    this.#runTurn(sessionId, message.id, promptOf(message), message.client_msg_id);
  }

  #runTurn(sessionId: string, turnId: string, prompt: AcpContentBlock[], clientMsgId: string | undefined, onEnd?: (result: TurnResult) => void): void {
    this.#store.updateControl(sessionId, { state: "running", error: undefined });
    const done = this.#runtimes
      .prompt(sessionId, turnId, prompt)
      .catch((error: unknown): TurnResult => {
        // The agent did not even start: show why on the session.
        if (this.#store.has(sessionId)) {
          this.#store.updateControl(sessionId, { state: "error", error: error instanceof Error ? error.message : String(error) });
        }
        return "error";
      })
      .then((result) => {
        if (this.#turns.get(sessionId) === done) this.#turns.delete(sessionId);
        try {
          onEnd?.(result);
        } catch {
          // Best effort.
        }
        if (clientMsgId !== undefined) {
          const key = waiterKey(sessionId, clientMsgId);
          this.#waiters.get(key)?.resolve({ messageId: turnId, result });
          this.#waiters.delete(key);
        }
        this.#drainQueue(sessionId);
      });
    this.#turns.set(sessionId, done);
  }

  #drainQueue(sessionId: string): void {
    if (this.#turns.has(sessionId) || !this.#store.has(sessionId)) return;
    if (this.#held.has(sessionId)) return;
    const control = this.#store.getControl(sessionId);
    const [next, ...rest] = control.queued;
    if (next === undefined) return;
    this.#store.updateControl(sessionId, { queued: rest });
    const { message } = this.#store.appendUserMessage(sessionId, {
      client_msg_id: next.client_msg_id,
      content: next.content,
      author: next.author,
      ...(next.attachments ? { attachments: next.attachments } : {}),
    });
    this.#startTurn(sessionId, message);
  }

  /** Cancel the running turn (if any) and wait for it to end. */
  async #settleTurn(sessionId: string): Promise<void> {
    const turn = this.#turns.get(sessionId);
    if (turn === undefined) return;
    this.#held.add(sessionId);
    await this.#runtimes.cancel(sessionId);
    await Promise.race([turn, delay(10_000)]);
    this.#held.delete(sessionId);
  }

  #waiter(sessionId: string, clientMsgId: string): Waiter {
    const key = waiterKey(sessionId, clientMsgId);
    let waiter = this.#waiters.get(key);
    if (waiter === undefined) {
      let resolve!: Waiter["resolve"];
      const promise = new Promise<{ messageId: string; result: TurnResult }>((r) => (resolve = r));
      waiter = { promise, resolve };
      this.#waiters.set(key, waiter);
    }
    return waiter;
  }

  async #awaitReply(
    sessionId: string,
    clientMsgId: string,
    knownMessageId: string | undefined,
    ctx: RpcContext,
    response: z.input<typeof SendResponseSchema>,
    waiter: Waiter = this.#waiter(sessionId, clientMsgId),
  ): Promise<void> {
    const remaining = ctx.remainingMs();
    const budget = Math.max(0, Math.min(this.#waitTimeoutMs, remaining === null ? Infinity : remaining - 1000));
    const ended = await Promise.race([waiter.promise, delay(budget).then(() => undefined)]);
    const messageId = ended?.messageId ?? knownMessageId;
    if (ended !== undefined) {
      response.message_id = ended.messageId;
      response.turn_result = ended.result;
      if (ended.result === "error") response.error = (this.#store.has(sessionId) ? this.#store.getControl(sessionId).error : undefined) ?? "the agent failed";
    }
    if (messageId !== undefined && this.#store.has(sessionId)) response.reply_text = turnReplyText(this.#store, sessionId, messageId);
  }

  #findUserMessage(sessionId: string, clientMsgId: string): UserMessage | undefined {
    const { messages } = this.#store.listMessages(sessionId, { limit: 500 });
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "user" && message.client_msg_id === clientMsgId) return message;
    }
    return undefined;
  }

  /** Who sent this, for `author` / `answered.by`: other clients see an MCP origin as `mcp:<client>`. */
  #authorOf(decision: GateDecision, ctx: RpcContext): string {
    if (decision.via === "mcp") return `mcp:${decision.mcpClient ?? "external"}`;
    if (decision.clientPub) {
      const entry = this.#gate.listPairedClients().find((c) => c.client_pub === decision.clientPub);
      return entry?.label ?? `client:${decision.clientPub.slice(0, 8)}`;
    }
    if (decision.onBehalfOf) return decision.onBehalfOf;
    return ctx.tunnel?.principal ?? "";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

function waiterKey(sessionId: string, clientMsgId: string): string {
  return `${sessionId}\u0000${clientMsgId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function queuedNotFound(clientMsgId: string): MeshCallError {
  return new MeshCallError("not_found", `no queued message ${clientMsgId}`, { details: { reason: "queued_not_found", client_msg_id: clientMsgId } });
}

function toAttachmentPart(ref: z.output<typeof AttachmentRefSchema>): ImagePart | FilePart {
  const mime = ref.mime ?? "application/octet-stream";
  return { type: mime.startsWith("image/") ? "image" : "file", path: ref.path, name: ref.name ?? path.basename(ref.path), mime, size: ref.size ?? 0 };
}

/** A user message as an ACP prompt: the text, then attachments as resource links the agent can open. */
function promptOf(message: UserMessage): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  for (const part of message.parts) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else blocks.push({ type: "resource_link", uri: pathToFileURL(part.path).href, name: part.name, mimeType: part.mime, size: part.size });
  }
  return blocks;
}
