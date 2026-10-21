import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeConnectorProject } from '../../src/host/connector/project.js'

/** 打包内的只读负载：`lib/bundled-connector` 的最小可用形态。 */
async function packagedPayload(root: string, cli = 'print("connector")\n'): Promise<string> {
  const source = join(root, 'bundled-connector')
  await mkdir(join(source, 'connector'), { recursive: true })
  await writeFile(join(source, 'pyproject.toml'), '[project]\nname = "anywhere-cli"\n')
  await writeFile(join(source, 'connector', 'cli.py'), cli)
  return source
}

function connectorConfig(root: string, connectorSourceDir: string) {
  return { stateRoot: join(root, 'state'), connectorSourceDir, uvPath: 'uv', apiBaseUrl: 'https://api.example.test' }
}

test('mirrors the connector project outside the package and keeps the resolved lockfile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-connector-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await packagedPayload(root)
  const config = connectorConfig(root, source)

  const mirror = await materializeConnectorProject(config)
  assert.equal(mirror.startsWith(join(config.stateRoot, 'connector-source')), true)
  assert.equal(mirror.startsWith(source), false)
  assert.equal(await readFile(join(mirror, 'connector', 'cli.py'), 'utf8'), 'print("connector")\n')

  // uv 在项目目录里写锁；之后的启动复用同一份副本，锁因此留着。
  await writeFile(join(mirror, 'uv.lock'), 'version = 1\n')
  assert.equal(await materializeConnectorProject(config), mirror)
  assert.equal(await readFile(join(mirror, 'uv.lock'), 'utf8'), 'version = 1\n')
  // 插件包目录保持只读语义：里面不该出现 uv.lock。
  assert.equal(existsSync(join(source, 'uv.lock')), false)
})

test('republishes a changed payload without deleting an aged mirror that may still be running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-connector-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await packagedPayload(root)
  const config = connectorConfig(root, source)
  const first = await materializeConnectorProject(config)

  await writeFile(join(source, 'connector', 'cli.py'), 'print("connector v2")\n')
  const second = await materializeConnectorProject(config)
  assert.notEqual(second, first)
  assert.equal(await readFile(join(second, 'connector', 'cli.py'), 'utf8'), 'print("connector v2")\n')
  // 镜像的年龄无法证明已停止使用；其他通道或长时间运行的 Connector 仍会读取源码。
  assert.equal(existsSync(first), true)

  const aged = new Date(Date.now() - 48 * 60 * 60_000)
  await utimes(first, aged, aged)
  assert.equal(await materializeConnectorProject(config), second)
  assert.equal(await readFile(join(first, 'connector', 'cli.py'), 'utf8'), 'print("connector")\n')
  assert.equal(existsSync(second), true)
})

test('concurrent publishers return the same complete mirror and clean their own staging directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-connector-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await packagedPayload(root)
  const config = connectorConfig(root, source)

  const mirrors = await Promise.all(Array.from({ length: 12 }, () => materializeConnectorProject(config)))
  assert.equal(new Set(mirrors).size, 1)
  assert.equal(await readFile(join(mirrors[0], 'connector', 'cli.py'), 'utf8'), 'print("connector")\n')
  assert.equal((await readdir(join(config.stateRoot, 'connector-source'))).length, 1)
})

test('rejects an incomplete packaged payload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-connector-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await packagedPayload(root)
  await rm(join(source, 'pyproject.toml'))
  await assert.rejects(materializeConnectorProject(connectorConfig(root, source)), /未找到内部 Connector 源码/)
})
