import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/components/desktop/windows-title-bar.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("windows-title-bar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function loadFunction(name, globals) {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  const code = ts.transpileModule(declaration.getText(ast).replace("export ", ""), {
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
    appIcon: { src: "/_next/static/media/icon-mac-source.png" },
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

test("title bar preserves the native application icon in both themes", () => {
  const iconImport = ast.statements.find(node => ts.isImportDeclaration(node) && node.importClause?.name?.text === "appIcon")
  assert.ok(iconImport)
  const componentUrl = new URL("../src/components/desktop/windows-title-bar.tsx", import.meta.url)
  const iconUrl = new URL(iconImport.moduleSpecifier.text, componentUrl)
  assert.equal(iconUrl.href, new URL("../../build/icon-mac-source.png", import.meta.url).href)
  assert.deepEqual(readFileSync(iconUrl).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

  for (const resolvedTheme of ["dark", "light"]) {
    const elements = []
    const appIcon = { src: "/_next/static/media/icon-mac-source.png" }
    const component = loadFunction("WindowsTitleBar", {
      React: {
        useState: () => [true, () => {}],
        useRef: () => ({ current: null }),
        useLayoutEffect() {},
        useEffect() {},
        createElement: (type, props) => { elements.push({ type, props }) },
      },
      useTheme: () => ({ resolvedTheme }),
      appIcon,
    })
    component()
    const icon = elements.find(element => element.type === "img")
    assert.equal(icon.props.src, appIcon.src)
    assert.match(icon.props.className, /shrink-0/)
  }
})
