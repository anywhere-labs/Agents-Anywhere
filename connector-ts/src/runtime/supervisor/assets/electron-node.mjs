// @ts-nocheck
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/infrastructure/electron-node.mjs @98dd0e6e5 (Electron as Node)
//
// Desktop runs Node packages with its own Electron executable plus ELECTRON_RUN_AS_NODE=1. Loaded with --import before
// the Agent starts, this removes that variable from the commands the Agent runs: otherwise VS Code or another
// Electron app launched from there would run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;
