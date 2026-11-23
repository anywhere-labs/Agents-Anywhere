import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { TsdownPlugin } from 'tsdown'

/** External-package equivalent of Harness packages/client/tsdown.client.ts. */
export function clientCss(packageId: string, root: string): TsdownPlugin {
  const prefix = '\0dsh-css:'
  const suffix = '.mjs'
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css') || !importer) return null
      return prefix + resolve(dirname(importer), source) + suffix
    },
    async load(id) {
      if (!id.startsWith(prefix)) return null
      const path = id.slice(prefix.length, -suffix.length)
      this.addWatchFile(path)
      const filename = relative(root, path).replaceAll('\\', '/')
      const result = transform({ filename, code: await readFile(path), cssModules: { pattern: '[hash]_[local]' }, minify: true, analyzeDependencies: true })
      let css = result.code.toString()
      for (const dependency of result.dependencies ?? []) {
        if (dependency.type !== 'url' || !/^\.\.?\/.*\.woff2$/.test(dependency.url)) {
          throw new Error(`Unsupported client CSS dependency in ${filename}; only local WOFF2 fonts can be embedded.`)
        }
        const asset = resolve(dirname(path), dependency.url)
        this.addWatchFile(asset)
        // Client factories have no static asset base URL. Embed the font so it
        // loads in both DSH Desktop and Web and follows the CSS HMR lifecycle.
        css = css.replaceAll(dependency.placeholder, `data:font/woff2;base64,${(await readFile(asset)).toString('base64')}`)
      }
      const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
      const tagId = `${packageId}/${filename}`
      // DSH 0.2.2 and earlier remove these tags before rematerializing a client
      // factory; 0.2.3 leaves them in place, so a replaced factory (HMR or a
      // plugin update) rewrites its tag instead of keeping the old text. DSH
      // 0.2.3's meta.stylesheets is not used: earlier versions ignore it and
      // would load no styles. No global theme or standalone stylesheet.
      return [
        `const tagId = ${JSON.stringify(tagId)};`,
        `const css = ${JSON.stringify(css)};`,
        `if (typeof document !== 'undefined') {`,
        `  let style = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');`,
        `  if (style === null) {`,
        `    style = document.createElement('style');`,
        `    style.dataset.plugin = ${JSON.stringify(packageId)};`,
        `    style.dataset.pluginCss = tagId;`,
        `    style.textContent = css;`,
        `    document.head.appendChild(style);`,
        `  } else if (style.textContent !== css) style.textContent = css;`,
        `}`,
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}
