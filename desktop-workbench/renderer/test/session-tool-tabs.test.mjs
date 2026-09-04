import assert from "node:assert/strict"
import test from "node:test"

import {
  createSessionToolTab,
  INITIAL_SESSION_TOOL_TABS_STATE,
  sessionToolTabsReducer,
  terminalTabId,
} from "../src/components/session-tool-tabs.ts"

function terminal(terminalId, label) {
  return {
    terminalId,
    sessionId: "browse_connector-1",
    label,
    root: "/repo",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    purpose: "user",
    pid: 123,
    status: "running",
    exitCode: null,
    scrollbackBytes: 0,
    scrollbackSeq: 0,
    createdAt: "2026-09-05T00:00:00Z",
  }
}

test("review and files stay singletons while terminal tabs can have multiple instances", () => {
  let state = INITIAL_SESSION_TOOL_TABS_STATE
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionToolTab("files", "files"),
  })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionToolTab("files-again", "files"),
  })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionToolTab("terminal:pending:1", "terminal", "Terminal"),
  })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionToolTab("terminal:pending:2", "terminal", "Terminal 2"),
  })

  assert.deepEqual(state.tabs.map((tab) => tab.id), [
    "files",
    "terminal:pending:1",
    "terminal:pending:2",
  ])
  assert.equal(state.activeTabId, "terminal:pending:2")
})

test("restored backend terminals become first-level tabs", () => {
  const first = terminal("trm_1", "Terminal")
  const second = terminal("trm_2", "Terminal 2")
  const state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "restore-terminals",
    terminals: [first, second],
  })

  assert.deepEqual(state.tabs.map((tab) => tab.id), [terminalTabId("trm_1"), terminalTabId("trm_2")])
  assert.deepEqual(state.tabs.map((tab) => tab.title), ["Terminal", "Terminal 2"])
  assert.equal(state.activeTabId, terminalTabId("trm_1"))
})

test("resolving a pending terminal removes a duplicate restored tab", () => {
  const resolved = terminal("trm_1", "Terminal")
  let state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "open-tool",
    tab: createSessionToolTab("terminal:pending:1", "terminal", "Terminal"),
  })
  state = sessionToolTabsReducer(state, { type: "restore-terminals", terminals: [resolved] })
  state = sessionToolTabsReducer(state, {
    type: "resolve-terminal",
    id: "terminal:pending:1",
    terminal: resolved,
  })

  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0]?.id, "terminal:pending:1")
  assert.equal(state.tabs[0]?.terminal?.terminalId, "trm_1")
})

test("resetting terminal tabs preserves other tool tabs", () => {
  let state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "open-tool",
    tab: createSessionToolTab("review", "review"),
  })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionToolTab("terminal:pending:1", "terminal", "Terminal"),
  })
  state = sessionToolTabsReducer(state, { type: "reset-terminals" })

  assert.deepEqual(state.tabs.map((tab) => tab.id), ["review"])
  assert.equal(state.activeTabId, "review")
})
