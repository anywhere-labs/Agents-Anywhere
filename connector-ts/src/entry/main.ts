// `anywhere-cli` executable entry (bundled into the npm package and the single-file build).
import { runCli } from './cli.js'

process.exitCode = await runCli(process.argv.slice(2))
