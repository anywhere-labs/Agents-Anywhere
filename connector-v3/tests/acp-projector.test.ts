import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AcpTimelineProjector, configFromSessionResult, type AcpSessionUpdate } from "../src/core/acp-protocol.js";
import { SessionStore, SessionStoreError } from "../src/core/session-store.js";
import { WatchEventSchema, type AssistantMessage, type Message, type SessionListEvent, type WatchEvent } from "../src/core/timeline.js";

function setup() {
  let ms = Date.parse("2026-11-21T08:00:00.000Z");
  let n = 0;
  const newId = () => `id${++n}`;
  const store = new SessionStore({ device: { id: "dev_01", name: "MacBook" }, now: () => (ms += 1000), newId });
  const session = store.create({ agent: "codex", title: "Fix login", cwd: "/repo" });
  const projector = new AcpTimelineProjector({ store, sessionId: session.id, newId });
  const send = (content: string, client_msg_id = `c-${content}`) => store.appendUserMessage(session.id, { client_msg_id, content }).message;
  const all = (): Message[] => store.listMessages(session.id, { limit: 500 }).messages;
  const assistant = (): AssistantMessage[] => all().filter((m): m is AssistantMessage => m.role === "assistant");
  return { store, session, projector, send, all, assistant };
}

const text = (t: string): AcpSessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
const thought = (t: string): AcpSessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: t } });

const TIMEOUT = Symbol("timeout");

/** Pull everything already queued, keeping a still-pending `next()` for the following drain. */
class Reader<T> {
  private pending: Promise<IteratorResult<T>> | undefined;
  constructor(private readonly iterator: AsyncIterator<T>) {}

  async drain(): Promise<{ values: T[]; done: boolean }> {
    const values: T[] = [];
    for (;;) {
      const next = this.pending ?? this.iterator.next();
      const result = await Promise.race([next, new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), 5))]);
      if (result === TIMEOUT) {
        this.pending = next;
        return { values, done: false };
      }
      this.pending = undefined;
      if (result.done) return { values, done: true };
      values.push(result.value);
    }
  }
}

describe("AcpTimelineProjector", () => {
  it("coalesces agent_message_chunk into one TextPart with the turn's id", () => {
    const { store, session, projector, send, assistant } = setup();
    const user = send("hello");
    projector.beginTurn(user.id);
    assert.equal(store.getControl(session.id).state, "running");

    for (const chunk of ["Hel", "lo, ", "world"]) projector.handleUpdate(text(chunk));
    let items = assistant();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]?.parts, [{ type: "text", text: "Hello, world" }]);
    assert.equal(items[0]?.turn_id, user.id);
    assert.equal(items[0]?.done, false);
    assert.equal(items[0]?.seq, 1);

    projector.endTurn("end_turn");
    items = assistant();
    assert.equal(items[0]?.done, true);
    assert.equal(items[0]?.interrupted, undefined);
    assert.equal(store.getControl(session.id).state, "idle");
  });

  it("turns agent_thought_chunk into a ThinkingPart and closes it when text starts", () => {
    const { projector, send, assistant } = setup();
    projector.beginTurn(send("why?").id);
    projector.handleUpdate(thought("Let me "));
    projector.handleUpdate(thought("think."));
    projector.handleUpdate(text("Because."));
    const [thinking, answer] = assistant();
    assert.deepEqual(thinking?.parts, [{ type: "thinking", text: "Let me think." }]);
    assert.equal(thinking?.done, true);
    assert.deepEqual(answer?.parts, [{ type: "text", text: "Because." }]);
    assert.equal(answer?.done, false);
    assert.equal(thinking?.turn_id, answer?.turn_id);
  });

  it("projects tool_call + tool_call_update into one ToolPart with diffs and locations", () => {
    const { projector, send, assistant } = setup();
    projector.beginTurn(send("edit it").id);
    projector.handleUpdate(text("Editing."));
    projector.handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Edit src/app.ts",
      kind: "edit",
      status: "pending",
      rawInput: { path: "src/app.ts" },
      locations: [{ path: "src/app.ts", line: 12 }],
    });
    projector.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" });

    let [prose, tool] = assistant();
    assert.equal(prose?.done, true, "a tool call closes the text stretch");
    assert.equal(tool?.done, false);
    assert.equal(tool?.parts[0].type === "tool" && tool.parts[0].status, "in_progress");

    projector.handleUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [
        { type: "diff", path: "src/app.ts", oldText: "a", newText: "b" },
        { type: "diff", path: "src/new.ts", newText: "c" },
        { type: "content", content: { type: "text", text: "Applied 2 edits" } },
      ],
    });
    [prose, tool] = assistant();
    assert.equal(assistant().length, 2, "updates replace the same item");
    assert.equal(tool?.done, true);
    assert.deepEqual(tool?.parts[0], {
      type: "tool",
      id: "call_1",
      title: "Edit src/app.ts",
      kind: "edit",
      status: "completed",
      input: { path: "src/app.ts" },
      output: "Applied 2 edits",
      locations: [{ path: "src/app.ts", line: 12 }],
      diffs: [
        { path: "src/app.ts", old_text: "a", new_text: "b" },
        { path: "src/new.ts", new_text: "c" },
      ],
    });

    projector.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_1", rawOutput: { ok: true } });
    const final = assistant()[1]?.parts[0];
    assert.deepEqual(final?.type === "tool" && final.output, { ok: true }, "rawOutput wins over text content");
  });

  it("keeps one PlanPart per turn, replaced whole", () => {
    const { projector, send, assistant } = setup();
    projector.beginTurn(send("plan").id);
    projector.handleUpdate({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "high", status: "in_progress" }] });
    projector.handleUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Read", priority: "high", status: "completed" },
        { content: "Write", priority: "medium", status: "pending" },
      ],
    });
    let plans = assistant().filter((m) => m.parts[0].type === "plan");
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]?.parts[0], {
      type: "plan",
      entries: [
        { content: "Read", priority: "high", status: "completed" },
        { content: "Write", priority: "medium", status: "pending" },
      ],
    });
    assert.equal(plans[0]?.done, false);
    projector.endTurn();
    plans = assistant().filter((m) => m.parts[0].type === "plan");
    assert.equal(plans[0]?.done, true);
  });

  it("turns session/request_permission into a PendingRequest; the first answer wins", async () => {
    const { store, session, projector, send, assistant } = setup();
    projector.beginTurn(send("run tests").id);
    projector.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "call_9", title: "yarn test", kind: "execute", status: "pending" });
    const { request, outcome } = projector.requestPermission({
      sessionId: "acp-1",
      toolCall: { toolCallId: "call_9" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });

    const tool = assistant().find((m) => m.parts[0].type === "tool");
    assert.equal(request.message_id, tool?.id);
    assert.equal(request.tool_call_id, "call_9");
    assert.equal(request.title, "yarn test");
    assert.equal(store.summary(session.id).state, "waiting");
    assert.deepEqual(store.getControl(session.id).pending, [request]);

    const first = store.answerPendingRequest(session.id, { request_id: request.request_id, option_id: "allow", by: "t4", device: "iPhone" });
    assert.equal(first.answered.option_id, "allow");
    assert.throws(
      () => store.answerPendingRequest(session.id, { request_id: request.request_id, option_id: "deny", by: "someone" }),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "failed_precondition" && error.reason === "already_answered",
    );
    assert.deepEqual(await outcome, { outcome: { outcome: "selected", optionId: "allow" } });

    const control = store.getControl(session.id);
    assert.deepEqual(control.pending, []);
    assert.deepEqual(control.answered?.map((a) => [a.request_id, a.by, a.device, a.option_id]), [[request.request_id, "t4", "iPhone", "allow"]]);
    assert.equal(store.summary(session.id).state, "running");
  });

  it("cancels waiting permissions when the turn ends", async () => {
    const { store, session, projector, send, assistant } = setup();
    projector.beginTurn(send("go").id);
    const { request, outcome } = projector.requestPermission({
      sessionId: "acp-1",
      toolCall: { toolCallId: "call_2", title: "rm -rf build", kind: "execute" },
      options: [{ optionId: "ok", name: "OK", kind: "allow_once" }],
    });
    projector.endTurn("cancelled");
    assert.deepEqual(await outcome, { outcome: { outcome: "cancelled" } });
    assert.deepEqual(store.getControl(session.id).pending, []);
    assert.throws(() => store.answerPendingRequest(session.id, { request_id: request.request_id, option_id: "ok", by: "t4" }), SessionStoreError);
    const tool = assistant()[0];
    assert.equal(tool?.done, true);
    assert.equal(tool?.interrupted, true);
  });

  it("opens an autonomous turn for output outside a prompt", () => {
    const { projector, assistant } = setup();
    projector.handleUpdate(text("Background job finished."));
    const [item] = assistant();
    assert.equal(item?.turn_id, item?.id);
    assert.equal(item?.autonomous, true);
  });

  it("reports config options and mode changes on the session", () => {
    const { store, session, projector } = setup();
    projector.handleUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5",
          options: [{ group: "openai", name: "OpenAI", options: [{ value: "gpt-5", name: "GPT-5" }] }, { value: "o3", name: "o3" }],
        },
      ],
    });
    assert.deepEqual(store.get(session.id)?.config, [
      {
        id: "model",
        name: "Model",
        category: "model",
        current: "gpt-5",
        options: [
          { value: "gpt-5", name: "GPT-5", group: "OpenAI" },
          { value: "o3", name: "o3" },
        ],
      },
    ]);

    store.updateSession(session.id, {
      config: configFromSessionResult({ sessionId: "acp-1", modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] } }),
    });
    projector.handleUpdate({ sessionUpdate: "current_mode_update", currentModeId: "code" });
    assert.equal(store.get(session.id)?.config[0]?.current, "code");
  });
});

describe("SessionStore", () => {
  it("is idempotent on client_msg_id", () => {
    const { store, session } = setup();
    const a = store.appendUserMessage(session.id, { client_msg_id: "c1", content: "hi" });
    const b = store.appendUserMessage(session.id, { client_msg_id: "c1", content: "hi (retry)" });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.message.id, a.message.id);
    assert.deepEqual(b.message.parts, [{ type: "text", text: "hi" }]);
    assert.equal(store.get(session.id)?.message_count, 1);
  });

  it("pages messages without cutting a turn", () => {
    const { store, session, projector, send } = setup();
    for (const turn of ["one", "two", "three"]) {
      projector.beginTurn(send(turn).id);
      projector.handleUpdate(thought(`${turn}?`));
      projector.handleUpdate({ sessionUpdate: "tool_call", toolCallId: `${turn}-tool`, title: "ls", kind: "execute", status: "completed" });
      projector.handleUpdate(text(`${turn}!`));
      projector.endTurn();
    }
    // seq 0..11: [user, thinking, tool, text] × 3
    const last = store.listMessages(session.id, { limit: 2 });
    assert.deepEqual(last.messages.map((m) => m.seq), [8, 9, 10, 11], "extended back to the user message");
    assert.equal(last.has_more, true);

    const older = store.listMessages(session.id, { before_seq: 8, limit: 2 });
    assert.deepEqual(older.messages.map((m) => m.seq), [4, 5, 6, 7]);

    const exact = store.listMessages(session.id, { before_seq: 8, limit: 4 });
    assert.deepEqual(exact.messages.map((m) => m.seq), [4, 5, 6, 7]);

    const first = store.listMessages(session.id, { before_seq: 4, limit: 100 });
    assert.deepEqual(first.messages.map((m) => m.seq), [0, 1, 2, 3]);
    assert.equal(first.has_more, false);
  });

  it("keeps a steered message inside the turn it was inserted into", () => {
    const { store, session, projector, send } = setup();
    const start = send("start");
    projector.beginTurn(start.id);
    projector.handleUpdate(text("working"));
    store.appendUserMessage(session.id, { client_msg_id: "steer", content: "also do X", steered: true });
    projector.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "t", title: "x", status: "completed" });
    projector.handleUpdate(text("done"));
    // seq 0 user, 1 text, 2 steered, 3 tool, 4 text
    assert.deepEqual(store.listMessages(session.id, { limit: 3 }).messages.map((m) => m.seq), [0, 1, 2, 3, 4]);
  });

  it("watch: snapshot first, then the newest value per item", async () => {
    const { store, session, projector, send } = setup();
    const reader = new Reader<WatchEvent>(store.subscribeSession(session.id));
    const [snapshot] = (await reader.drain()).values;
    assert.equal(snapshot?.type, "snapshot");
    assert.ok(WatchEventSchema.safeParse(snapshot).success);

    const user = send("hello");
    projector.beginTurn(user.id);
    for (const chunk of ["a", "b", "c", "d"]) projector.handleUpdate(text(chunk));

    const { values } = await reader.drain();
    for (const event of values) assert.ok(WatchEventSchema.safeParse(event).success, JSON.stringify(event));
    const messages = values.filter((e) => e.type === "message").map((e) => (e.type === "message" ? e.message : undefined));
    assert.equal(messages.length, 2, "one event per item, not per chunk");
    assert.equal(messages[0]?.id, user.id);
    assert.deepEqual(messages[1]?.parts, [{ type: "text", text: "abcd" }]);
    assert.equal(values.filter((e) => e.type === "control").length, 1);

    // a watcher already waiting gets the change at once
    const waiting = reader.drain();
    projector.handleUpdate(text("e"));
    const live = (await waiting).values.find((e) => e.type === "message");
    assert.deepEqual(live?.type === "message" && live.message.parts, [{ type: "text", text: "abcde" }]);

    store.delete(session.id);
    assert.equal((await reader.drain()).done, true);
    assert.equal(store.watcherCount(session.id), 0);
  });

  it("watch: a rewind sends a fresh snapshot; fork copies up to a message", async () => {
    const { store, session, projector, send } = setup();
    const first = send("one");
    projector.beginTurn(first.id);
    projector.handleUpdate(text("1"));
    projector.endTurn();
    const second = send("two");
    projector.beginTurn(second.id);
    projector.handleUpdate(text("2"));
    projector.endTurn();

    const reply = store.listMessages(session.id).messages[1];
    assert.ok(reply);
    const forked = store.fork(session.id, reply.id, "Branch");
    assert.equal(forked.title, "Branch");
    assert.deepEqual(forked.forked_from, { session_id: session.id, message_id: reply.id });
    assert.deepEqual(store.listMessages(forked.id).messages.map((m) => m.id), [first.id, reply.id]);
    assert.equal(store.get(forked.id)?.message_count, 2);

    const reader = new Reader<WatchEvent>(store.subscribeSession(session.id));
    await reader.drain();
    const { removed } = store.rewind(session.id, second.id);
    assert.deepEqual(removed.map((m) => m.seq), [2, 3]);
    const [event] = (await reader.drain()).values;
    assert.equal(event?.type, "snapshot");
    assert.equal(event?.type === "snapshot" && event.messages.length, 2);
    // the rewound client_msg_id may be sent again
    assert.equal(store.appendUserMessage(session.id, { client_msg_id: "c-two", content: "two again" }).duplicate, false);
  });

  it("watch_list: snapshot, then coalesced updates", async () => {
    const { store, session } = setup();
    const reader = new Reader<SessionListEvent>(store.subscribeList());
    const [snapshot] = (await reader.drain()).values;
    assert.equal(snapshot?.type, "snapshot");
    assert.deepEqual(snapshot?.sessions.map((s) => s.id), [session.id]);
    assert.deepEqual(snapshot?.projects, ["/repo"]);

    const other = store.create({ agent: "claude", cwd: "/other" });
    store.rename(session.id, "Renamed");
    store.setPinned(other.id, true);
    const { values } = await reader.drain();
    // The reader was already waiting, so the first change arrives at once; the next two collapse into one.
    assert.equal(values.length, 2);
    assert.ok(values.every((v) => v.type === "update"));
    assert.deepEqual(values.at(-1)?.sessions.map((s) => [s.id, s.title, s.pinned]), [
      [session.id, "Renamed", false],
      [other.id, "", true],
    ]);
    assert.deepEqual(values.at(-1)?.projects, ["/repo", "/other"]);
  });

  it("exports and restores a snapshot, closing what was live", () => {
    const { store, session, projector, send } = setup();
    projector.beginTurn(send("hi").id);
    projector.handleUpdate(text("partial"));
    projector.requestPermission({ sessionId: "acp", toolCall: { toolCallId: "t", title: "x" }, options: [{ optionId: "a", name: "A", kind: "allow_once" }] });
    const saved = JSON.parse(JSON.stringify(store.exportSnapshot())) as unknown;

    const restored = new SessionStore({ device: { id: "dev_01", name: "MacBook" } });
    restored.loadSnapshot(saved);
    assert.equal(restored.getControl(session.id).state, "idle");
    assert.deepEqual(restored.getControl(session.id).pending, []);
    const items = restored.listMessages(session.id).messages;
    assert.ok(items.every((m) => m.done));
    const assistantItems = items.filter((m): m is AssistantMessage => m.role === "assistant");
    // the text stretch was closed normally when the tool call began; the tool was still open
    assert.equal(assistantItems.find((m) => m.parts[0].type === "text")?.interrupted, undefined);
    assert.equal(assistantItems.find((m) => m.parts[0].type === "tool")?.interrupted, true);
    assert.equal(restored.appendUserMessage(session.id, { client_msg_id: "c-hi", content: "hi" }).duplicate, true);
  });
});
