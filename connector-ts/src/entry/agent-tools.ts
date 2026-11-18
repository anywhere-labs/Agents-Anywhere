// `dist/agent-tools.js`: the `aa` tool server a Runtime starts for a session with collaboration on (ACP
// `mcpServers`). Its own small bundle, so it starts fast: it only relays tool calls to the Connector.
import { runAgentToolsRelay } from '../tools/mcp-relay.js'

declare const AA_CONNECTOR_VERSION: string | undefined

const version = typeof AA_CONNECTOR_VERSION === 'string' ? AA_CONNECTOR_VERSION : '0.0.0'

await runAgentToolsRelay({ input: process.stdin, output: process.stdout, env: process.env, version })
process.exit(0)
