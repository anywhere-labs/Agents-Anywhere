import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import type { OutputAsset, OutputChunk } from 'rolldown'
import { shared } from './vite.shared.ts'

// The mobile renderer: ONE self-contained HTML file, copied into the iOS demo. It is a local file in the app, so size is
// not a concern, but start-up is: everything in one inlined script means parsing and running every Shiki grammar,
// Mermaid and KaTeX before the first frame. So the build is code-split (CommonJS chunks) and then folded into the file:
//   - the entry and the chunks it needs at once are evaluated at start-up;
//   - every other chunk is kept as text in a <script type="text/aa-chunk"> after them (never parsed by the browser),
//     and evaluated (`new Function`) the first time something imports it: a grammar, Shiki itself, Mermaid, KaTeX;
//   - those come after the entry in the document, so the page is up before the parser has even reached them; an
//     import that arrives earlier waits for the document to finish parsing.
const OUT = resolve(import.meta.dirname, 'dist/renderer')
const IOS = resolve(import.meta.dirname, '../ios/AAv3PoC/Renderer/renderer.html')

/** Inside a <script> element's text, "</script" ends the element and "<!--" changes how the rest is parsed. */
const scriptText = (code: string) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

/** The chunk loader: CommonJS `require` over the <script type="text/aa-chunk"> texts, evaluated on first use. */
const LOADER = `(function(){var c={};function q(n){var m=c[n];if(m)return m.exports;var s=document.getElementById('aa:'+n);if(!s)throw new Error('aa chunk not found: '+n);m=c[n]={exports:{}};new Function('exports','require','module',s.textContent+'\\n//# sourceURL=aa-chunk/'+n)(m.exports,q,m);return m.exports}window.__aaRequire=q;window.__aaImport=function(n){return c[n]||document.readyState!=='loading'?Promise.resolve().then(function(){return q(n)}):new Promise(function(y,j){document.addEventListener('DOMContentLoaded',function(){try{y(q(n))}catch(e){j(e)}},{once:true})})}})()`

function singleFileLazyChunks(): Plugin {
  return {
    name: 'aa-single-file-lazy-chunks',
    apply: 'build',
    enforce: 'post',
    // Folded together from what was written (rolldown's bundle cannot be rewritten in place reliably).
    writeBundle(_, bundle) {
      const html = bundle['renderer.html'] as OutputAsset | undefined
      if (!html) return
      const chunks = Object.values(bundle).filter((x): x is OutputChunk => x.type === 'chunk')
      const css = Object.values(bundle).filter((x): x is OutputAsset => x.type === 'asset' && x.fileName.endsWith('.css'))
      const byName = new Map(chunks.map((c) => [c.fileName, c]))
      // Dynamic imports (CommonJS output: `Promise.resolve().then(()=>require("./x.js"))`) go through the loader's
      // async path; static requires lose the "./". A dynamic import of a stylesheet (KaTeX's) names a chunk that was
      // never emitted: its CSS is in the <style> already, so it resolves to nothing.
      const relink = (code: string) =>
        code
          .replace(/Promise\.resolve\(\)\.then\(\(\)=>require\("\.\/([\w.-]+\.js)"\)\)/g, (_, f: string) => (byName.has(f) ? `__aaImport("${f}")` : 'Promise.resolve({})'))
          .replace(/require\("\.\/([\w.-]+\.js)"\)/g, (m, f: string) => (byName.has(f) ? `require("${f}")` : m))
      const entry = chunks.find((c) => c.isEntry)!
      // What the entry needs before it can run: its static imports, transitively.
      const eager = new Set<string>()
      const visit = (name: string) => {
        if (eager.has(name)) return
        eager.add(name)
        for (const i of byName.get(name)?.imports ?? []) if (byName.has(i)) visit(i)
      }
      visit(entry.fileName)
      if (process.env.AA_STATS) {
        const pkg = (id: string) => (id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? 'src')
        const by = new Map<string, number>()
        for (const n of eager) for (const [id, m] of Object.entries(byName.get(n)!.modules)) by.set(pkg(id), (by.get(pkg(id)) ?? 0) + m.renderedLength)
        console.log('[aa] eager', [...eager], [...by].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}K`).join(', '))
      }
      const chunkTag = (c: OutputChunk) => `<script type="text/aa-chunk" id="aa:${c.fileName}">${scriptText(relink(c.code))}</script>`
      let out = readFileSync(resolve(OUT, 'renderer.html'), 'utf8')
        .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>\s*/g, '')
        .replace(/<link rel="stylesheet"[^>]*>\s*/g, '')
      out = out.replace('</head>', () => `<style>${css.map((c) => String(c.source)).join('\n')}</style>\n</head>`)
      const tail = [
        ...[...eager].map((n) => chunkTag(byName.get(n)!)),
        `<script>${LOADER}</script>`,
        `<script>__aaRequire(${JSON.stringify(entry.fileName)})</script>`,
        ...chunks.filter((c) => !eager.has(c.fileName)).map(chunkTag),
      ].join('\n')
      out = out.replace('</body>', () => `${tail}\n</body>`)
      for (const f of [...byName.keys(), ...css.map((c) => c.fileName)]) rmSync(resolve(OUT, f), { force: true })
      writeFileSync(resolve(OUT, 'renderer.html'), out)
    },
    closeBundle() {
      // AA_NO_IOS_COPY=1: build only into dist/ (baselines, experiments) and leave the app's copy alone.
      if (process.env.AA_NO_IOS_COPY) return
      mkdirSync(resolve(IOS, '..'), { recursive: true })
      copyFileSync(resolve(OUT, 'renderer.html'), IOS)
      const kb = (statSync(IOS).size / 1024).toFixed(0)
      console.log(`\n  renderer.html → ${IOS} (${kb} KB)\n`)
    },
  }
}

export default defineConfig({
  ...shared,
  base: './',
  plugins: [...(shared.plugins ?? []), singleFileLazyChunks()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: 'safari16',
    assetsDir: '',
    // Fonts and images as data: URLs, CSS in one <style>: nothing outside the file.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    // CommonJS chunks (rolldown turns `import.meta` into `{}` there; nothing the renderer runs needs it).
    rollupOptions: { input: resolve(import.meta.dirname, 'renderer.html'), output: { format: 'cjs' } },
  },
})
