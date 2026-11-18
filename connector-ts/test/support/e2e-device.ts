// Device process for the end-to-end test (server/tests/test_v3_e2e.py): the real `anywhere-cli start` (runCli), replacing only what the test
// must not touch: the system keychain (noVault), v2 data import, and keeping the local database in this thread. Runtimes use the providers bundled in this build;
// the test installs the fake Agent as `opencode` on PATH.
//
//   node --experimental-transform-types --import ./test/support/ts-resolve.mjs test/support/e2e-device.ts \
//     <home> pair <serverUrl>     # pair: prints the pairing code, saves credentials and starts once a client claims it
//     <home> start                # start with saved credentials
//     <home> pair-client          # next to a running start: prints the aa-pair:// code of a client pairing (encrypted mode)
//     <home> rpc --config <path>  # the local control API a host drives (the DSH plugin's integration tests)
//
// Environment: MESHCALL_ROUTER_BINARY (Router for local control), AGENT_CONNECTOR_WORKSPACE_ROOTS, HOME, PATH.
// Exits cleanly on SIGTERM / SIGINT.
import { runCli } from '../../src/entry/cli.js'
import { noVault } from '../../src/keystore/index.js'

const [home, ...command] = process.argv.slice(2)
if (home === undefined || !['start', 'pair', 'pair-client', 'rpc'].includes(command[0] ?? '')) {
  process.stderr.write('usage: e2e-device.ts <home> (pair <serverUrl> | start | pair-client | rpc --config <path>)\n')
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
