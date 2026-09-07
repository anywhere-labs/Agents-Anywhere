import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { checkClient } from './check-client.ts'

interface Manifest {
  name: string
  exports: Record<string, string | { types: string; default: string }>
  dsh: {
    bundle: { patch: string }
    client: { platform: string }
  }
}

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as Manifest

for (const target of Object.values(manifest.exports)) {
  for (const file of typeof target === 'string' ? [target] : [target.types, target.default]) {
    await access(new URL(file, root))
  }
}
await access(new URL(manifest.dsh.bundle.patch, root))
assert.equal(manifest.dsh.client.platform, 'web')

const hostEntry = manifest.exports['.']
const clientEntry = manifest.exports['./client']
assert.ok(hostEntry && typeof hostEntry !== 'string')
assert.ok(clientEntry && typeof clientEntry !== 'string')

for (const [entry, expectedExports] of [
  [hostEntry, ['apply', 'Config', 'name']],
  [clientEntry, ['apply', 'inject']],
] as const) {
  const file = fileURLToPath(new URL(entry.types, root))
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'))
  const source = program.getSourceFile(file)
  assert.ok(source)
  const checker = program.getTypeChecker()
  const module = checker.getSymbolAtLocation(source)
  assert.ok(module)
  const exportedNames = new Set(checker.getExportsOfModule(module).map(symbol => symbol.name))
  for (const name of expectedExports) assert.ok(exportedNames.has(name), `${entry.types} does not export ${name}`)
}

const host: unknown = await import(new URL(hostEntry.default, root).href)
assert.ok(host && typeof host === 'object' && 'apply' in host && typeof host.apply === 'function')

const clientSource = await readFile(new URL(clientEntry.default, root), 'utf8')
await checkClient(clientSource, manifest.name)
await access(new URL('lib/bundled-connector/pyproject.toml', root))
await access(new URL('lib/bundled-connector/connector/cli.py', root))

const allowedClientImports = new Set(['@deepseek-ai/cordis', 'react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])
for (const match of clientSource.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
  assert.ok(allowedClientImports.has(match[1]!), `Unexpected client runtime import: ${match[1]}`)
}

console.log('构建产物检查通过：Host、侧边栏入口与官方弹窗交互、注册与释放、CSS 热更新契约、类型声明和内部 Connector 源码。')
