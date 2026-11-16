// Desktop runs Node packages with its own Electron executable and
// ELECTRON_RUN_AS_NODE=1. Loaded with --import before the agent starts, this
// keeps the flag out of the commands the agent runs: VS Code or another
// Electron app started from there would otherwise run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;
