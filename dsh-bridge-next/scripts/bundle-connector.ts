import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../connector/', import.meta.url))
const target = fileURLToPath(new URL('../lib/bundled-connector/', import.meta.url))
const ignored = new Set(['.venv', '__pycache__', '.pytest_cache', '.ruff_cache', '_reference', '_deprecated'])
await stat(new URL('../../connector/connector/cli.py', import.meta.url))
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const entry of ['pyproject.toml', 'README.md', 'connector']) {
  await cp(`${source}/${entry}`, `${target}/${entry}`, {
    recursive: true,
    filter: (path) => !relative(source, path).split(sep).some(part => ignored.has(part)) && !basename(path).endsWith('.pyc'),
  })
}
console.log('已复制内部 Connector 源码；运行环境将在用户连接设备时准备。')
