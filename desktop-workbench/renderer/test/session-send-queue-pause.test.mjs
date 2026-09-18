import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import * as queue from "../src/components/session/message-queue.ts"

// Execute the actual send handler with its view and transport dependencies stubbed.
const detail = readFileSync(new URL("../src/components/session-detail.tsx", import.meta.url), "utf8")
const start = detail.indexOf("  const handleSend = async (")
const end = detail.indexOf("\n  React.useEffect(() => {", start)
const handler = ts.transpileModule(detail.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText

function fixture(sessionId, api) {
  queue.enqueueMessage(sessionId, { id: "old", content: "old", attachments: [], selections: {}, status: "queued" })
  queue.pauseMessageQueue(sessionId)
  let state = { session: { id: sessionId }, state: { status: "idle" }, items: [] }
  const context = {
    ...queue, sessionId, session: state.session, state,
    queuedMessages: queue.readMessageQueue(sessionId),
    sendInFlightRef: { current: false }, activeSessionIdRef: { current: sessionId },
    createClientId: () => "fresh", tNew: key => key, tSession: key => key,
    timelineFollowRef: { current: null }, eventSequenceCursor: { current: () => 0 },
    buildOptimisticUserMessage: () => ({ id: "fresh", source: {} }),
    addOptimisticMessage() {}, setSending() {},
    setState: update => { state = update(state) },
    nextOptimisticRuntimeState: () => ({ status: "waiting" }),
    mergeTimelineItems: (current, incoming) => [...current, ...incoming],
    selectionPatchFromComposerSelections: (_current, selections) => selections,
    runtimeState: { selections: {} },
    runtimeStateWithSelectionResult: current => current,
    dashboardApi: api, token: "fixture",
    sessionSourceErrorCode: () => null, markOptimisticMessageFailed() {},
    timelineClientMessageId: () => null, toast: { error() {}, success() {} },
  }
  return new Function(...Object.keys(context), `${handler}\nreturn handleSend`)(...Object.values(context))
}

for (const failure of ["selection", "send"]) {
  test(`${failure} failure keeps old messages paused even after the view returns to idle`, async () => {
    const sessionId = `fresh-failed-${failure}`
    const send = fixture(sessionId, {
      updateSessionSelections: async () => { throw new Error("selection failed") },
      sendSessionMessage: async () => { throw new Error("send failed") },
    })
    assert.equal(await send("new instruction", [], failure === "selection" ? { model: "other" } : {}), false)
    assert.equal(queue.messageQueueIsPaused(sessionId), true)
    await queue.drainMessageQueue(sessionId, async () => assert.fail("failed fresh send must not release old messages"))
    assert.equal(queue.readMessageQueue(sessionId)[0].id, "old")
  })
}

test("old messages remain paused until the fresh send is accepted", async () => {
  const sessionId = "fresh-success"
  let accept
  const send = fixture(sessionId, {
    sendSessionMessage: () => new Promise(resolve => { accept = resolve }),
  })
  const pending = send("new instruction", [], {})
  assert.equal(queue.messageQueueIsPaused(sessionId), true)
  await queue.drainMessageQueue(sessionId, async () => assert.fail("pending send must not release the queue"))
  accept({ ok: true, result: {} })
  assert.equal(await pending, true)
  assert.equal(queue.messageQueueIsPaused(sessionId), false)
  await queue.drainMessageQueue(sessionId, async item => { assert.equal(item.id, "old"); return true })
})
