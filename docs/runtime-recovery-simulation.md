# Codex / DSH 增量恢复模拟验证

## 2026-09-17：Codex 增量读取补充

- 新增 `connector/tests/test_codex_incremental_reads.py`，使用真实临时 SQLite 索引、JSON 检查点和分页 RPC 模拟。240 轮首次读取 12 页；刷盘重建后历史读取为 0；新增一轮读取 1 页、上传 1 项。未提交检查点时重试同样的增量。
- 覆盖旧轮次文字/工具结果修改、轮次删除、消息删除、重排、未完成轮次、损坏检查点、未知索引 schema、投影落后、继承历史、源文件缺失及读取期间变化。变化后的检查点与独立完整投影逐项比较，包含排序。
- 使用隔离目录中的原生历史及数据库副本，分别启动 `0.147.0` 和 `0.154.0-alpha.6.2` 的真实 Codex app-server。两者均验证首次读取 7 项、检查点重建后 0 次历史 RPC；向隔离投影追加确定性测试轮次后，读取 1 页、上传 1 项。没有向模型发送消息，也没有改写用户的原生数据库。这验证协议组合，不代替真实模型流式生成测试。
- 单会话恢复失败不再反复强制读取其他已恢复会话。实际桌面进程持有写锁时仍需原客户端释放；本改动只改善冲突报告，不绕过 Codex 的写入互斥。

复现专项测试：在 `connector/` 执行 `uv run pytest tests/test_codex_incremental_reads.py tests/test_codex_sdk_client.py tests/test_connector_runtime.py -q`。

下文是 2026-09-16 的增量上传验证记录；新的读取优化仅用于能通过原生索引校验的 Codex 会话，其余场景保留完整读取。

日期：2026-09-16。仅使用测试临时目录、测试账号与临时 SQLite；未连接用户服务、未调用真实模型。

## 本轮 6 个核心场景

| Agent | 模拟场景 | 实测结果 |
| --- | --- | --- |
| Codex | ingestion 前网络错误 | 检查点不推进，重建 Connector 对象后补传 2 项：1 项修改、1 项新增 |
| Codex | 后端提交成功后丢失 HTTP 响应 | 重建后重传 2 项，数据库没有重复或遗漏 |
| Codex | ingestion 成功、检查点刷盘前退出 | 从磁盘旧检查点恢复，补传 2 项 |
| Codex | 检查点刷盘后退出 | 从磁盘恢复，上传 0 项 |
| DSH | 销毁 Host、丢弃 Connector 对象，再读取磁盘检查点；历史未变 | 上传 0 条历史项、0 个完整快照 |
| DSH | 离线新增 1 条消息，重建 Host 和 Connector | 上传 1 条增量、0 个完整快照；数据库只存在 1 条对应消息 |

每个 Codex 场景还检查首次基线、无变化重启，以及恢复成功再刷盘重启：后两者均上传 0 条历史项。

## 验证层次

- `connector/tests/test_codex_recovery_simulation.py`：使用脚本化 SDK 历史、真实扫描器、实例隔离 JSON 存储和模拟 ingestion，验证提交边界、重传数量及最终条目集合。
- `connector/tests/codex_recovery_probe.py`：把同样四种故障接到实际 AA 后端 ASGI ingestion 与临时数据库，验证返回结果和数据库最终内容。
- `connector/tests/dsh_event_probe.py` + `dsh-bridge-next/tests/integration/runtime-events.test.ts`：真实 DSH SDK/原生 AgentLoop、Bridge socket、Python Connector、实际后端 ingestion 和数据库。测试扩展了磁盘恢复与 Host 销毁重建，并保留坏历史隔离、双轮对话、流式内容、丢响应、归档与删除等原有断言。
- 定向 pytest（Codex 故障模拟、DSH 检查点、存储迁移）16 项通过；DSH 跨语言组合测试通过；Codex 实际后端四场景通过；修改测试文件 Ruff 和 `git diff --check` 通过。

## 复现

在 `connector/` 执行：

```sh
uv run pytest tests/test_codex_recovery_simulation.py tests/test_dsh_checkpoints.py tests/test_runtime_storage.py -q
```

在 `server/` 执行：

```sh
uv run --with-editable ../connector --with pytest python ../connector/tests/codex_recovery_probe.py
```

在 `dsh-bridge-next/`（已安装依赖并完成 build）执行：

```sh
corepack yarn exec tsx --test --test-name-pattern='official native loop crosses' tests/integration/runtime-events.test.ts
```

## 边界

“退出”通过丢弃运行时和存储对象、重建对象并重新读取真实 JSON 模拟；不是操作系统断电或 SIGKILL 实验。DSH Host 则实际执行插件 dispose 后重新加载。网络故障通过 HTTP transport 注入，未切断系统网络。Codex 原生 SDK 历史为脚本数据；DSH 模型适配器也使用确定性测试输出。

结果证明上述恢复路径的行为，不能代替真实设备长时间运行、网络抖动、磁盘损坏/空间不足或海量历史性能验证。检查点失效、DSH 未结束生成的检查点及删除校准仍可能触发单会话快照，这是保留的恢复兜底。
