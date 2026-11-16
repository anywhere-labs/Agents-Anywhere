// @ts-nocheck
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/infrastructure/electron-node.mjs
//
// Desktop 用自己的 Electron 可执行文件加 ELECTRON_RUN_AS_NODE=1 跑 Node 包。以 --import 在 Agent 启动前载入，
// 把这个变量从 Agent 运行的命令里去掉：否则从那里启动的 VS Code 或别的 Electron 应用会被当成普通 Node 运行。
delete process.env.ELECTRON_RUN_AS_NODE;
