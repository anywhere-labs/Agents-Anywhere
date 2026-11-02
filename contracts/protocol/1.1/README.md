# 平台协议 1.1

在冻结的 1.0 上增加可发现的 Runtime 类型和 1.1 事件版本识别；工作区准备与异步创建另见 `contracts/runtime-workflows/1.1`。Web、Electron 的类型由此目录生成到 `v1_1`，仍可读取 1.0 事件。

生成：`PYTHONPATH=server server/.venv/bin/python server/scripts/export_protocol_schemas.py --version 1.1`。生成 1.0 时导出器会保留原有枚举和常量；此次检查确认其 JSON 产物字节不变。
