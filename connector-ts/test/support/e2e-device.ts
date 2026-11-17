// 端到端测试（server/tests/test_v3_e2e.py）的设备进程：真正的 `anywhere-cli start`（runCli），只把测试不该碰的
// 东西换掉——系统钥匙串（noVault）、v2 数据导入，以及把本地库放在本线程里。Runtime 用本构建自带的 provider，
// 测试把假 Agent 装成 PATH 上的 `opencode`。
//
//   node --experimental-transform-types --import ./test/support/ts-resolve.mjs test/support/e2e-device.ts \
//     <home> pair <serverUrl>     # 配对：打印配对码，等客户端认领后保存凭据并启动
//     <home> start                # 用保存的凭据启动
//
// 环境变量：MESHCALL_ROUTER_BINARY（本地控制用的 Router）、AGENT_CONNECTOR_WORKSPACE_ROOTS、HOME、PATH。
// SIGTERM / SIGINT 正常退出。
import { runCli } from '../../src/entry/cli.js'
import { noVault } from '../../src/keystore/index.js'

const [home, ...command] = process.argv.slice(2)
if (home === undefined || (command[0] !== 'start' && command[0] !== 'pair')) {
  process.stderr.write('usage: e2e-device.ts <home> (pair <serverUrl> | start)\n')
  process.exit(64)
}
const argv = command[0] === 'pair' ? [...command, '--timeout', '60', '--poll-interval', '0.2'] : command

process.exitCode = await runCli(
  [...argv, '--debug'],
  {
    home,
    confirm: null,
    color: false,
    io: { out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`) },
    compose: { trust: { vault: noVault() }, legacyDataDir: false, storeMode: 'in-process' },
  },
)
