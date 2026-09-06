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
      const result = transform({ filename, code: await readFile(path), cssModules: { pattern: '[hash]_[local]' }, minify: true })
      const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
      const tagId = `${packageId}/${filename}`
      // Harness owns these tags and removes them before rematerializing a
      // client factory during HMR. No global theme or standalone stylesheet.
      return [
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
        `  const style = document.createElement('style');`,
        `  style.dataset.plugin = ${JSON.stringify(packageId)};`,
        `  style.dataset.pluginCss = tagId;`,
        `  style.textContent = ${JSON.stringify(result.code.toString())};`,
        `  document.head.appendChild(style);`,
        `}`,
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}
