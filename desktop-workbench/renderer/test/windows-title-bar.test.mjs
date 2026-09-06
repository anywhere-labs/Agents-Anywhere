import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/components/desktop/windows-title-bar.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("windows-title-bar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function loadFunction(name, globals, sourceFile = ast) {
  const declaration = sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  const code = ts.transpileModule(declaration.getText(sourceFile).replace("export ", ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText
  return vm.runInNewContext(`${code}\n${name}`, globals)
}

test("native controls receive sRGB hex colors resolved from the actual sidebar styling", () => {
  for (const [background, foreground] of [[23, 250], [250, 10]]) {
    const pixels = { "oklch(sidebar)": background, "oklch(sidebar-foreground)": foreground }
    const context = {
      clearRect() {}, fillRect() {}, fillStyle: "",
      getImageData() { return { data: [pixels[this.fillStyle], pixels[this.fillStyle], pixels[this.fillStyle], 255] } },
    }
    const readColors = loadFunction("readTitleBarColors", {
      getComputedStyle: () => ({ backgroundColor: "oklch(sidebar)", color: "oklch(sidebar-foreground)" }),
      document: { createElement: () => ({ getContext: () => context }) },
    })
    const colors = readColors({})
    assert.equal(colors.color, "#" + background.toString(16).padStart(2, "0").repeat(3))
    assert.equal(colors.symbolColor, "#" + foreground.toString(16).padStart(2, "0").repeat(3))
  }
})

test("title bar only reserves space on Windows and cleans up on unmount", () => {
  for (const platform of ["win32", "darwin", "linux", null]) {
    const dataset = {}
    let enabled = false
    let cleanup
    const component = loadFunction("WindowsTitleBar", {
      React: {
        useState: () => [false, value => { enabled = value }],
        useRef: () => ({ current: null }),
        useLayoutEffect: callback => { cleanup = callback() },
        useEffect() {},
      },
      useTheme: () => ({ resolvedTheme: "dark" }),
      getDesktopWorkbenchBridge: () => platform ? { platform, window: {} } : null,
      document: { documentElement: { dataset } },
    })
    assert.equal(component(), null)
    assert.equal(enabled, platform === "win32")
    assert.equal(dataset.windowsTitleBar, platform === "win32" ? "true" : undefined)
    cleanup?.()
    assert.equal(dataset.windowsTitleBar, undefined)
  }
})

test("theme synchronization waits for CSS to update and cancels stale animation frames", () => {
  let effect
  let frameCallback
  let cancelled
  const updates = []
  const component = loadFunction("WindowsTitleBar", {
    React: {
      useState: () => [true, () => {}],
      useRef: () => ({ current: {} }),
      useLayoutEffect() {},
      useEffect: callback => { effect = callback },
      createElement() {},
    },
    useTheme: () => ({ resolvedTheme: "light" }),
    getDesktopWorkbenchBridge: () => ({ window: { setTitleBarColors: colors => { updates.push(colors); return Promise.resolve() } } }),
    readTitleBarColors: () => ({ color: "#fafafa", symbolColor: "#0a0a0a" }),
    requestAnimationFrame: callback => { frameCallback = callback; return 7 },
    cancelAnimationFrame: frame => { cancelled = frame },
  })
  component()
  const cleanup = effect()
  assert.equal(updates.length, 0)
  frameCallback()
  assert.deepEqual(updates, [{ color: "#fafafa", symbolColor: "#0a0a0a" }])
  cleanup()
  assert.equal(cancelled, 7)
})

test("Windows title bar exposes a controls target without an app icon or name in both themes", () => {
  for (const resolvedTheme of ["dark", "light"]) {
    const elements = []
    const onControlsMount = () => {}
    const component = loadFunction("WindowsTitleBar", {
      React: {
        useState: () => [true, () => {}],
        useRef: () => ({ current: null }),
        useLayoutEffect() {},
        useEffect() {},
        createElement: (type, props) => { elements.push({ type, props }) },
      },
      useTheme: () => ({ resolvedTheme }),
    })
    component({ onControlsMount })
    const controls = elements.find(element => element.props["data-slot"] === "windows-title-bar-controls")
    assert.equal(controls.props.ref, onControlsMount)
    assert.ok(elements.every(element => element.type === "div"))
  }
})

test("title bar provider shares the mounted controls target with the workspace", () => {
  const target = {}
  const setTarget = () => {}
  const children = {}
  const provider = loadFunction("WindowsTitleBarProvider", {
    React: {
      useState: () => [target, setTarget],
      createElement: (type, props, ...children) => ({ type, props, children }),
    },
    WindowsTitleBarControlsContext: { Provider: "Provider" },
    WindowsTitleBar: "WindowsTitleBar",
  })
  const rendered = provider({ children })
  assert.equal(rendered.props.value, target)
  assert.equal(rendered.children[0].props.onControlsMount, setTarget)
  assert.equal(rendered.children[1], children)
})

test("navigation moves into the Windows title bar once and retains existing actions and disabled states", () => {
  const headerSource = readFileSync(new URL("../src/components/desktop/desktop-shell-header.tsx", import.meta.url), "utf8")
  const headerAst = ts.createSourceFile("desktop-shell-header.tsx", headerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const titleBarTarget of [null, {}]) {
    for (const canGoBack of [false, true]) {
      const elements = []
      const portals = []
      const calls = []
      const component = loadFunction("DesktopShellHeader", {
        React: {
          useContext: () => titleBarTarget,
          useState: () => [false, () => {}],
          useEffect() {},
          useCallback: callback => callback,
          createElement: (type, props, ...children) => {
            const element = { type, props, children }
            elements.push(element)
            return element
          },
        },
        WindowsTitleBarControlsContext: {},
        cn: (...values) => values.filter(Boolean).join(" "),
        useTranslations: () => key => key,
        useWorkspace: () => ({
          canGoBack,
          canGoForward: !canGoBack,
          goBack: () => calls.push("back"),
          goForward: () => calls.push("forward"),
        }),
        useDesktopConnector: () => ({ supported: false }),
        createPortal: (children, target) => { portals.push({ children, target }); return { type: "portal" } },
        HEADER_SIDEBAR_MIN_WIDTH: 224,
        DashboardSidebarToggle: "SidebarToggle",
        Button: "Button",
        ArrowLeft: "ArrowLeft",
        ArrowRight: "ArrowRight",
      }, headerAst)
      const header = component({ sidebarOpen: canGoBack, sidebarResizing: false })
      const toggle = elements.filter(element => element.type === "SidebarToggle")
      const buttons = elements.filter(element => element.type === "Button")
      assert.equal(toggle.length, 1)
      assert.equal(toggle[0].props.showOnDesktop, true)
      assert.equal(buttons.length, 2)
      assert.equal(buttons[0].props.disabled, !canGoBack)
      assert.equal(buttons[1].props.disabled, canGoBack)
      buttons[0].props.onClick()
      buttons[1].props.onClick()
      assert.deepEqual(calls, ["back", "forward"])
      assert.equal(portals.length, titleBarTarget ? 1 : 0)
      if (titleBarTarget) {
        assert.match(header.props.className, /absolute/)
        assert.doesNotMatch(header.props.className, /\bz-\d+/)
        assert.equal(header.props.style.left, canGoBack ? "var(--desktop-sidebar-width)" : 0)
        assert.equal(portals[0].target, titleBarTarget)
        assert.match(portals[0].children.props.className, /aa-window-no-drag/)
        assert.match(toggle[0].props.className, /text-sidebar-foreground/)
        assert.ok(!elements.some(element => element.props?.className?.includes("w-[6.5rem]")))
      } else {
        assert.match(header.props.className, /relative/)
        assert.equal(header.props.style, undefined)
        assert.ok(elements.some(element => element.props?.className?.includes("w-[6.5rem]")))
      }
    }
  }
})

test("only Windows places the same keyed shell header after the workspace without trapping the collapse button", () => {
  const shellSource = readFileSync(new URL("../src/components/demo.tsx", import.meta.url), "utf8")
  const shellAst = ts.createSourceFile("demo.tsx", shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const titleBarTarget of [null, {}]) {
    const component = loadFunction("DesktopResizableShell", {
      React: {
        useContext: () => titleBarTarget,
        useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
        useRef: initial => ({ current: initial }),
        useEffect() {},
        useCallback: callback => callback,
        useMemo: callback => callback(),
        createElement: (type, props, ...children) => ({ type, props, children }),
      },
      useSidebar: () => ({ open: true, setOpen() {} }),
      WindowsTitleBarControlsContext: {},
      DashboardSidebarControlsContext: { Provider: "Provider" },
      DEFAULT_DESKTOP_LAYOUT: { "dashboard-sidebar": 256, "dashboard-main": 1024 },
      DESKTOP_SIDEBAR_MIN_WIDTH: 224,
      cn: (...values) => values.filter(Boolean).join(" "),
      DesktopShellHeader: "DesktopShellHeader",
      ResizablePanelGroup: "ResizablePanelGroup",
      ResizablePanel: "ResizablePanel",
      ResizableHandle: "ResizableHandle",
      AppSidebar: "AppSidebar",
      SidebarInset: "SidebarInset",
      WorkspaceMain: "WorkspaceMain",
      SessionToolSidebarsHost: "SessionToolSidebarsHost",
    }, shellAst)
    const shell = component().children[0]
    const children = shell.children.filter(Boolean)
    assert.deepEqual(children.map(child => child.type), titleBarTarget
      ? ["ResizablePanelGroup", "DesktopShellHeader"]
      : ["DesktopShellHeader", "ResizablePanelGroup"])
    assert.equal(children.find(child => child.type === "DesktopShellHeader").props.key, "desktop-shell-header")
  }
})

test("only Windows reserves native chrome above the unchanged right sidebar", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8")
  assert.match(css, /html\[data-windows-title-bar\] \[data-slot="session-tool-sidebar"\]\s*\{\s*top: var\(--aa-title-bar-height\);\s*\}/)
  const sidebar = readFileSync(new URL("../src/components/session-tool-sidebar.tsx", import.meta.url), "utf8")
  assert.match(sidebar, /data-slot="session-tool-sidebar"/)
  assert.match(sidebar, /fixed inset-y-0 z-40/)
  const sessionHeader = readFileSync(new URL("../src/components/session-view-header.tsx", import.meta.url), "utf8")
  assert.match(sessionHeader, /relative z-50 rounded-md hover:bg-muted/)
})
