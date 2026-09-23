# DSH 会话同步与连接生命周期调查

日期：2026-09-16。分支：`investigate/dsh-session-sync-lifecycle`。

范围：下文调查记录描述改动前的 `dsh-bridge-next` Host 与 Python Connector。后续实现见本节；验证结果另行记录，未进行用户运行实例的实机断网实验。

## 后续实现

- 删除 Host 内存检查点，新增协商式 `checkpointVersion:1`；Connector 按会话从现有 JSON 同步状态读写检查点。
- 会话历史相关通知使用同步 ingestion，成功后才允许 checkpoint.save；沿用 Connector 定期与退出刷盘，崩溃允许安全重传。
- Host 重建后按原生事件及附件收据指纹恢复，未变化的已结束会话跳过历史上传，同时保留重建投影。后续增量实现会先校验检查点处前缀，再上传后缀投影产生的新增或修改项；无有效检查点、前缀变化、检查点未结束生成或删除项仍补快照。
- 恢复支持已校验前缀后的变化项传输；仍需本地读历史、重建投影和全清单校准，不消除启动读取成本。
- 旧版协议不启用检查点恢复，手动刷新保持强制单会话完整校准。

验证记录：

- 插件 typecheck、build、check:build 通过；完整插件测试 150 项通过。
- 在线检查点合并到数据批次后，重跑 Host 销毁重建与回退场景，2 项通过。
- Connector 检查点/事件/重连/契约/状态存储/实例绑定/Host 相关测试 71 项通过；全部 `test_dsh*.py` 测试 71 项通过（两组有重叠，不相加）。
- Python 定向 Ruff 与 `git diff --check` 通过。
- 临时全新 `DSH_HOME` 下使用官方 `@deepseek-ai/dsh@0.1.5-rc.2` 创建 `checkpoint-test` profile 并 link 安装成功；profile bundles 与 `--dump-config` 均包含插件层。
- 真实 SDK/Loader、原生 AgentLoop → Python Connector → 测试后端组合测试通过，包括坏历史、双轮对话、丢 ACK 与重连。新增验证覆盖 JSON 刷盘/重读、ingestion 失败不推进、Host 销毁重建跳过未变化历史、下一事件直接增量、活动/不兼容检查点回退与手动刷新。

## 结论

同步链路为 DSH NativeRuntime → SyncFeed → Connector SyncRelay → RuntimeHost → AA Server。

当前并非每次重连都会重传全部历史：同一 NativeRuntime 生命周期、同一 namespace 下，有 revision 检查点的未变化会话会跳过历史快照。但检查点只有内存 Map，Host 重启或插件 Host 重载后丢失，下一次订阅会对所有可见会话重新读取、投影并发送完整历史。每次订阅仍会做会话清单校准。

检查点命中时只恢复 published/sourceAvailability，不恢复 projection。该会话后续收到原生持久事件时，若没有 projection，会重新 baseline。因此“重连时跳过历史”并不等于“重连后继续按事件增量”；这一额外单会话快照是代码路径推导，尚未实机测量。

证据：`src/host/dsh-runtime/native.ts:61`、`sync.ts:300`、`sync.ts:349`、`sync.ts:384`。已有 `tests/integration/runtime-events.test.ts:454` 覆盖同 Host 未变化重订阅不发快照、离线变化只重传变化会话；本次未运行。

## 生命周期矩阵

| 场景 | 当前行为 | 同步时机与范围 |
| --- | --- | --- |
| 首次连接、检查点缺失 | 创建 SyncRelay，订阅 SyncFeed | 全清单；所有可见会话完整快照，最后 inventory.complete |
| Connector 重启、DSH Host 保持运行 | 重新握手并订阅 | 同 namespace 可复用 Host 内存检查点；变化或 revision 不可用的会话完整快照 |
| DSH Host 重启、插件 Host 重载 | NativeRuntime 重建，检查点丢失 | Bridge 恢复并订阅后全量历史导入 |
| Connector → AA Server WebSocket 断开 | run_once 清理 WS 任务，不直接关闭 DSH Runtime/SyncRelay | 通知可回退 HTTP；断联本身不触发“最后一次全量同步” |
| AA Server WebSocket 建连，包括重连 | reconnect_event_runtimes → resynchronize | 关闭旧 Relay、创建新 Relay、重订阅并重新校准清单；是否重传历史由 Host 检查点决定 |
| Connector → DSH Bridge 断开 | 关闭 Relay，报告 runtime error，后台重复读取端点重连 | Bridge 恢复后订阅；快速退避后继续约 5 秒轮询，不因快速重试次数耗尽而永久停止 |
| 同步流失败、批次错序、队列溢出 | Relay 重试订阅，保留正常 RPC 连接 | 默认约 1 秒后重试；ACK 超时由 Host 关闭流并触发恢复，默认 60 秒 |
| 单会话手动刷新 | runtime.sync.refresh → native.refresh | 对指定会话重新 baseline；不是全局刷新 |
| 关闭或切换插件前端面板 | 不停止 Host 管理的 Connector | 在线同步继续；前端二维码轮询等由 UI 生命周期管理 |
| 手动停止、退出插件账号、Host dispose | 停止插件自己启动的 Connector 子进程 | 停止后无持续同步；退出账号删除账号文件，保留设备绑定以供复用 |
| 修改设置 | 运行中的 Connector 停止后重启；原本停止则不自动启动 | 重启后重新订阅；同步间隔不控制 DSH events 流 |
| 检测到 AA Desktop 安装 | 管理器停止插件自己的 Connector，交给 Desktop 管理 | DSH runtime 端点独立存在；后续由 Desktop 的 Connector 连接 |

证据入口：

- `connector/connector/server/client.py:245`：WS 建连、重订阅与断联清理；`:347`：通知 WS/HTTP 分流。
- `connector/connector/server/runtime_sync.py:82`：事件 runtime 重订阅；`:101`：周期历史扫描跳过 events runtime。
- `connector/connector/runtimes/dsh/runtime.py:64`、`:473`：重订阅与 Bridge 退出重连。
- `connector/connector/runtimes/dsh/bridge/sync.py:210`：同步流失败恢复与批次 ACK。
- `src/host/dsh-runtime/router.ts:52`：订阅替换旧流；`sync.ts:350`：清单与快照决策。
- `src/host/onboarding/manager.ts:130`、`:400`、`:450`、`:541`、`:553`、`:583`：自动恢复、控制、设置、退出、释放与 Desktop 管理权切换。
- `src/host/connector/process.ts:191`：先 connector.stop，再关闭 stdio，必要时终止自有进程。

## ACK 边界与风险

快照页 ACK 只代表收到该页；snapshot.commit 会等待完整快照的同步 HTTP ingestion。实时 timeline.itemUpsert 则走普通通知发布路径：assistant message 可先进入约 100ms 合并窗口，其他通知也可能进入 HTTP 待发送队列。SyncRelay 等待 operation 返回后就 ACK，Host 再推进检查点。因此实时 ACK 不是统一的服务端落库确认。

如果 ACK 后 Connector 崩溃或后台发送失败，而 DSH Host 保持运行，检查点可能已经领先于服务端。重连又可能因 revision 相同跳过快照，形成漏补风险。此结论来自 ACK/排队代码路径，尚未做故障注入验证，不能当作已复现问题。

证据：`connector/connector/runtimes/dsh/bridge/sync.py` 的 snapshot.commit 与 consume；`connector/connector/server/runtime_host.py:55`、`:259`；`connector/connector/server/notification_coalescer.py:32`；`connector/connector/server/client.py:347`；`src/host/dsh-runtime/sync.ts:384`。

## 建议的优化顺序

### 与 Codex / Claude 历史扫描的关键区别

已核对生产连接路径：`connector/connector/server/client.py:134` 注入同步 ingestion 与状态刷盘回调；`runtime_sync.py:352` 先等待 `_ingest_scanner_notifications` 成功，再调用 `prepared.commit()`，整轮扫描后在 `runtime_sync.py:229` 刷盘。Codex 的提交闭包在 `runtimes/codex/sessions/reader.py:237`，Claude 的提交闭包在 `runtimes/claude/history/syncer.py:176`。JSON 状态文件写入采用临时文件、文件 fsync、原子替换。

因此这些历史扫描的顺序是：准备快照与候选状态 → 服务端 ingestion 成功 → 推进同步状态 → 刷盘。若服务端已成功而状态尚未落盘就崩溃，恢复时可能重复发送，但不会因提前推进检查点而跳过未送达历史。这里特指历史扫描路径，不表示 Codex / Claude 的所有实时通知均具备落库 ACK。扫描器未注入 ingestion 时还存在 send_notification 回退，不能把该回退接口本身当作同等保证。

DSH 优化应同时交付“成功语义”和“检查点持久化”：

- transport ACK 只用于收页、流控，不能作为可跳过历史的依据。
- committed checkpoint 只覆盖服务端确认接收成功的连续数据范围；对应批次中的部分成功不能推进整个范围。
- Connector 掌握实际交付结果，建议由 Connector 保存已提交检查点并在订阅时传给 Host；Host 提供与该批数据绑定的原生 revision/序号及投影版本，不能在发送完成后重新读取最新 revision 充当提交水位。
- 最小方案可让 DSH 可恢复数据批次等待 ingestion 成功后提交；如保留实时合并与异步队列，则必须补充 delivery completion / commit barrier，保证合并后的发送仍正确覆盖原始水位。不能仅把当前 ACK 延迟或把 Map 落盘就视作完成。
- 验收要求：ingestion 失败不前进；成功后落盘前崩溃允许重放；落盘后重连才允许跳过；响应丢失可幂等重试。重复发送的幂等性需要按实际通知类型验证。

1. **先定义可恢复的交付检查点。** 区分已接收、已排队与服务端已提交。以服务端提交水位，或可可靠重放的持久队列为恢复依据；不能直接把现有内存 Map 写磁盘。
2. **保留清单校准，减少历史重传。** 初次导入、投影版本改变、缺少恢复依据时完整快照；重启/重连按会话 revision 与提交水位补变化；归档、缺失和读取失败继续独立同步来源状态，不清空平台历史。
3. **补齐重连后的 projection 恢复。** 可以本地重放构建 projection 而不重发历史，再按水位发送变化；进一步的原生序号续传需验证事件持久性、投影版本及 item 删除语义。当前 removed item 会触发单会话快照，不能直接取消该兜底。
4. **明确离线策略。** 当前 WS 断联仍走 HTTP。建议保留这一行为，但在 HTTP 也不可用时明确缓冲上限、恢复边界和健康状态；上线后以交付水位恢复，避免无条件全量。
5. **增加可量化日志。** 记录订阅原因、清单数、检查点命中数、快照原因、历史读取/投影/发送条数与字节数，以区分“全清单”与“全历史”。

持久化键至少需覆盖目标服务/账号或设备绑定、runtime namespace、原生会话身份和投影版本，并定义恢复出厂、切换服务及服务端数据重置时的失效规则。

## 后续验证重点

- 初次连接与同 Host 无变化重连；Host 重启但历史无变化。
- ACK 后、后台送达前杀死 Connector，验证服务端不会漏项。
- 单独断 WS、同时断 WS/HTTP、断 Bridge，比较恢复快照数。
- 检查点命中后首个新事件，验证不会不必要地重传完整会话。
- 快照中断、坏会话历史、归档、删除、投影版本变化与换 namespace。
- 用户停止后保持停止，Host 重载自动恢复的现有行为是否符合产品预期。

本次没有改运行配置、用户数据或启动/停止现有服务。
