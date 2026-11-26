// Build of the mobile render bundle: ONE self-contained HTML file (inline JS, CSS and assets, no network) that the
// iOS / Android apps load into a WebView. See embed/README.md.
//
//   corepack yarn embed:build   → embed/dist/aa-render.html
//   corepack yarn embed:dev     → dev server with the fixture harness at /harness/
import { existsSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

const embedRoot = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(embedRoot, "..")
const pkg = JSON.parse(readFileSync(path.join(webRoot, "package.json"), "utf8")) as { version: string }

/** The page may not reach any network: everything it shows comes over the bridge (doc §1, "WebView 自己不联网"). */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src data: blob:",
].join("; ")

/** Pin the CSP into the page and name it aa-render.html (build only: the dev server needs its websocket). */
function renderBundle(): Plugin {
  let outDir = ""
  return {
    name: "aa-render-bundle",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = config.build.outDir
    },
    transformIndexHtml(html) {
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
    },
    closeBundle() {
      const from = path.join(outDir, "index.html")
      if (existsSync(from)) renameSync(from, path.join(outDir, "aa-render.html"))
    },
  }
}

/**
 * KaTeX's stylesheet lists every font three times (woff2, woff, ttf); inlined, the two fallbacks would be ~1 MB of a
 * file whose WebViews (WKWebView, Android System WebView) all read woff2. Keep woff2 only.
 */
function katexWoff2Only(): Plugin {
  return {
    name: "aa-render-katex-woff2",
    enforce: "pre",
    transform(code, id) {
      if (!/katex(\.min)?\.css($|\?)/.test(id)) return null
      return code.replace(/,\s*url\([^)]+\.woff\)\s*format\(["']woff["']\)/g, "").replace(/,\s*url\([^)]+\.ttf\)\s*format\(["']truetype["']\)/g, "")
    },
  }
}

const shim = (name: string) => path.join(embedRoot, "src", "shims", name)

export default defineConfig(({ command }) => ({
  root: embedRoot,
  base: "./",
  plugins: [katexWoff2Only(), react(), tailwindcss(), ...(command === "build" ? [viteSingleFile({ removeViteModuleLoader: true }), renderBundle()] : [])],
  resolve: {
    alias: [
      // Shiki with a curated grammar set instead of all ~300 (the full set would be most of the file).
      { find: /^shiki$/, replacement: shim("shiki.ts") },
      // Mermaid is ~2 MB: diagrams show as their source in the mobile bundle.
      { find: /^@streamdown\/mermaid$/, replacement: shim("mermaid.ts") },
      { find: /^@\//, replacement: `${webRoot}/` },
    ],
  },
  define: {
    __AA_EMBED_VERSION__: JSON.stringify(pkg.version),
    "process.env.NODE_ENV": JSON.stringify(command === "build" ? "production" : "development"),
  },
  build: {
    outDir: path.join(embedRoot, "dist"),
    emptyOutDir: true,
    target: ["es2022", "safari16", "chrome110"],
    cssCodeSplit: false,
    reportCompressedSize: false,
    sourcemap: !!process.env.EMBED_SOURCEMAP,
    chunkSizeWarningLimit: 100_000,
    rollupOptions: {
      input: path.join(embedRoot, "index.html"),
      onwarn(warning, warn) {
        // "use client" directives in shared components mean nothing here.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return
        warn(warning)
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5179,
    fs: { allow: [webRoot] },
  },
}))
