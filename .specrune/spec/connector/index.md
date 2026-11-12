# Connector Layer Spec

> Connector（`connector/`）的代码契约。检查命令：
> `cd connector && uv run ruff check connector tests && uv run pytest -q`。

## Files

| File | Topic |
|------|-------|
| [runtime-commands.md](./runtime-commands.md) | Runtime 指令目录（listCommands/executeCommand）直通契约 |
| [dsh-plugin-packaging.md](./dsh-plugin-packaging.md) | DSH 插件独立安装包的构建、产物边界与校验 |
