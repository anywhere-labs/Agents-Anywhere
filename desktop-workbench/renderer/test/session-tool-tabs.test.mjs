import assert from "node:assert/strict"
import test from "node:test"

import {
  createSessionFilePreviewTab,
  createSessionToolTab,
  INITIAL_SESSION_TOOL_TABS_STATE,
  sessionToolTabsReducer,
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

test("review and generic files stay singletons while terminal tabs can have multiple instances", () => {
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

test("each direct file preview opens a new tab without replacing the generic files tab", () => {
  const firstFile = {
    source: "workspace",
    name: "first.ts",
    path: "src/first.ts",
    root: "/repo",
  }
  const secondFile = {
    source: "attachment",
    name: "second.pdf",
    path: "second.pdf",
    root: "/repo",
    sourceUrl: "/api/v2/sessions/session-1/attachments/file_2/open",
    mediaType: "application/pdf",
  }

  let state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "open-tool",
    tab: createSessionToolTab("files", "files"),
  })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionFilePreviewTab("files:preview:1", firstFile),
  })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionFilePreviewTab("files:preview:2", secondFile),
  })

  assert.deepEqual(state.tabs.map((tab) => tab.id), ["files", "files:preview:1", "files:preview:2"])
  assert.deepEqual(state.tabs.map((tab) => tab.title), [null, "first.ts", "second.pdf"])
  assert.deepEqual(state.tabs.map((tab) => tab.filePreview), [null, firstFile, secondFile])
  assert.equal(state.activeTabId, "files:preview:2")
  assert.equal(state.open, true)
})

test("resolving a pending terminal keeps the tab identity", () => {
  const resolved = terminal("trm_1", "Terminal")
  let state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "open-tool",
    tab: createSessionToolTab("terminal:pending:1", "terminal", "Terminal"),
  })
  state = sessionToolTabsReducer(state, {
    type: "resolve-terminal",
    id: "terminal:pending:1",
    terminal: resolved,
  })

  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0]?.id, "terminal:pending:1")
  assert.equal(state.tabs[0]?.terminal?.terminalId, "trm_1")
})

test("review cards switch turns in the same tab and generic review returns to the latest turn", () => {
  const firstTarget = { orderSeq: 3, resetVersion: 1 }
  const secondTarget = { orderSeq: 8, resetVersion: 1 }
  let state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "open-tool",
    tab: { ...createSessionToolTab("review", "review"), reviewTarget: firstTarget },
  })
  state = sessionToolTabsReducer(state, { type: "collapse-sidebar" })
  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: { ...createSessionToolTab("review-again", "review"), reviewTarget: secondTarget },
  })
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeTabId, "review")
  assert.equal(state.open, true)
  assert.deepEqual(state.tabs[0].reviewTarget, secondTarget)

  state = sessionToolTabsReducer(state, {
    type: "open-tool",
    tab: createSessionToolTab("review", "review"),
  })
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0].reviewTarget, null)
})

function browseFile(state, name, preview = true) {
  return sessionToolTabsReducer(state, {
    type: "open-tool", preview,
    tab: createSessionFilePreviewTab(`file:${name}:${state.tabs.length}`, {
      source: "workspace", name, path: `/repo/${name}`, root: "/repo",
    }),
  })
}

test("first file is kept; later single-clicks replace only the temporary preview", () => {
  let state = browseFile(INITIAL_SESSION_TOOL_TABS_STATE, "a.ts")
  assert.equal(state.tabs[0].preview, false)
  state = browseFile(state, "b.ts")
  assert.equal(state.tabs[1].preview, true)
  const stablePreviewId = state.activeTabId
  state = browseFile(state, "c.ts")
  assert.equal(state.activeTabId, stablePreviewId)
  assert.deepEqual(state.tabs.map(tab => tab.title), ["a.ts", "c.ts"])
  assert.deepEqual(state.tabs.map(tab => tab.preview), [false, true])
  assert.equal(state.activeTabId, state.tabs[1].id)
})

test("double-click fixes an existing preview without duplicating or losing its identity", () => {
  let state = browseFile(browseFile(INITIAL_SESSION_TOOL_TABS_STATE, "a.ts"), "b.ts")
  const previewId = state.activeTabId
  state = browseFile(state, "b.ts", false)
  assert.equal(state.activeTabId, previewId)
  assert.equal(state.tabs.length, 2)
  assert.equal(state.tabs[1].preview, false)
  state = browseFile(state, "c.ts")
  assert.deepEqual(state.tabs.map(tab => tab.title), ["a.ts", "b.ts", "c.ts"])
  assert.deepEqual(state.tabs.map(tab => tab.preview), [false, false, true])
})

test("opening the breadcrumb picker fixes the current preview before browsing another file", () => {
  let state = browseFile(browseFile(INITIAL_SESSION_TOOL_TABS_STATE, "a.ts"), "b.ts")
  state = sessionToolTabsReducer(state, { type: "pin-tab", id: state.activeTabId })
  state = browseFile(state, "c.ts")
  assert.deepEqual(state.tabs.map(tab => tab.title), ["a.ts", "b.ts", "c.ts"])
  assert.deepEqual(state.tabs.map(tab => tab.preview), [false, false, true])
})

test("editing fixes previews and saving never makes them replaceable again", () => {
  let state = browseFile(browseFile(INITIAL_SESSION_TOOL_TABS_STATE, "a.ts"), "b.ts")
  const editedId = state.activeTabId
  state = sessionToolTabsReducer(state, { type: "set-tab-dirty", id: editedId, dirty: true })
  state = browseFile(state, "c.ts")
  assert.equal(state.tabs.find(tab => tab.id === editedId).dirty, true)
  assert.equal(state.tabs.find(tab => tab.id === editedId).preview, false)
  state = sessionToolTabsReducer(state, { type: "set-tab-dirty", id: editedId, dirty: false })
  state = browseFile(state, "d.ts")
  assert.deepEqual(state.tabs.map(tab => tab.title), ["a.ts", "b.ts", "d.ts"])
})

test("selecting an already fixed file activates it without duplicating or unfixing it", () => {
  let state = browseFile(browseFile(INITIAL_SESSION_TOOL_TABS_STATE, "a.ts"), "b.ts")
  const fixedId = state.tabs[0].id
  state = browseFile(state, "a.ts")
  assert.equal(state.activeTabId, fixedId)
  assert.equal(state.tabs.length, 2)
  assert.equal(state.tabs[0].preview, false)
  assert.equal(state.tabs[1].preview, true)
})

test("the browser's first file reuses its tab; subsequent files use a separate preview", () => {
  let state = sessionToolTabsReducer(INITIAL_SESSION_TOOL_TABS_STATE, {
    type: "open-tool", tab: createSessionToolTab("browser", "files"),
  })
  const open = (name) => {
    state = sessionToolTabsReducer(state, {
      type: "open-tool", preview: true, sourceTabId: "browser",
      tab: createSessionFilePreviewTab(`new:${name}`, {
        source: "workspace", name, path: `/repo/${name}`, root: "/repo",
      }),
    })
  }
  open("a.ts")
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeTabId, "browser")
  assert.equal(state.tabs[0].id, "browser")
  assert.equal(state.tabs[0].title, "a.ts")
  assert.equal(state.tabs[0].preview, false)
  assert.equal(state.tabs[0].filePreview.path, "/repo/a.ts")
  open("b.ts")
  assert.deepEqual(state.tabs.map(tab => [tab.title, tab.preview]), [["a.ts", false], ["b.ts", true]])
  assert.equal(state.activeTabId, "new:b.ts")
  open("c.ts")
  assert.deepEqual(state.tabs.map(tab => [tab.title, tab.preview]), [["a.ts", false], ["c.ts", true]])
})

test("opening an existing dirty file updates its browse context without replacing the tab", () => {
  let state = browseFile(INITIAL_SESSION_TOOL_TABS_STATE, "a.ts")
  const id = state.activeTabId
  state = sessionToolTabsReducer(state, { type: "set-tab-dirty", id, dirty: true })
  const target = { ...state.tabs[0].filePreview, browsePath: "/repo", browseExpandedPaths: ["/repo/src"] }
  state = sessionToolTabsReducer(state, {
    type: "open-tool", preview: true,
    tab: createSessionFilePreviewTab("unused", target),
  })
  assert.equal(state.activeTabId, id)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0].dirty, true)
  assert.equal(state.tabs[0].preview, false)
  assert.deepEqual(state.tabs[0].filePreview.browseExpandedPaths, ["/repo/src"])
})
