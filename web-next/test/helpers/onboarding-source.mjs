import { readFileSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url))
export function registerSource() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (['next/navigation', 'next/link', 'next/headers'].includes(specifier)) {
        return nextResolve(`${specifier}.js`, context)
      }
      const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : ''
      if (specifier.startsWith('@/') || (parent.startsWith(sourceRoot) && specifier.startsWith('.'))) {
        const base = specifier.startsWith('@/') ? resolve(sourceRoot, specifier.slice(2)) : resolve(dirname(parent), specifier)
        const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(path => existsSync(path) && /\.(tsx?|css)$/.test(path))
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith('.css')) {
        return { format: 'module', shortCircuit: true, source: 'export {}' }
      }
      if (url.startsWith(pathToFileURL(sourceRoot).href) && /\.tsx?$/.test(url)) {
        return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        }).outputText }
      }
      return nextLoad(url, context)
    },
  })
}
