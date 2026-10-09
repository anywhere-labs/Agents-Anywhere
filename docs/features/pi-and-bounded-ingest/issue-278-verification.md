# Issue #278 关联验证：增量分片不等于完整快照分片

关联：<https://github.com/anywhere-labs/Agents-Anywhere/issues/278>

验证基线：`f1f7a4f1`，`codex/sync-fix-pi-runtime`。
本轮仅增加合成验证测试与说明，不改生产代码、不部署、不评论或关闭 issue。
执行器不可用，主线程直接运行隔离的 Connector / SQLite 验证。

## 结论

**当前提交不能标记为 `Fixes #278`。** 可以标记 `Related to #278` / `Refs #278`：
它验证并解决了增量历史请求超限，但没有实现 DSH 的完整快照分片提交。
“没有再向 HTTP 入口发送超限请求”不等于“DSH 历史同步成功”。

Issue 截至本轮读取仍为 OPEN，描述的是 DSH 事件流的完整历史镜像。
原帖建议中的“只有末页 `complete=true`”与现有服务端契约不兼容，不能照搬。

## 后续：Connector 侧止血（仍为 `Refs #278`）

下文的结果矩阵记录的是 `f1f7a4f1` 的状态。之后的提交只改 Connector：

- 去掉 8 MiB 的本地原子上限。完整快照和不可拆分条目超过页大小时单独整份
  发送，只有服务端 413 才算超限，9 MiB 快照恢复为一次成功（与旧发送方式一致）。
- 被拒的通知只跳过它自己；临时失败从第一个未被接受的页继续，不重发已接受的通知。
- DSH `snapshot.commit` 被服务端永久拒绝（413 或 rejected）时，只隔离该会话：
  上报 `unavailable` / `history_too_large`，忽略它的 `checkpoint.save`，丢弃它后续的
  `timeline.itemUpsert` 与 `session.turnEnded`，inventory 中也标为 unavailable。
  commit 仍然 ACK，feed 继续处理其他会话，runtime 进入 `running`，不再无限重新订阅。
  同一 `throughSeq` 的捕获不再重复上传；之后被接受的新捕获会解除隔离。
- `connector/tests/test_issue_278_dsh_snapshot.py` 已从现状刻画改为验收这些行为。

超过服务端上限的会话历史仍然无法上传。真正修复需要分阶段的完整快照协议
（服务端暂存、校验后原子替换），在后续跨端 PR 中实现后才能标记 `Fixes #278`。

## 验证方式与安全范围

- 使用真实 `SyncRelay`、`RuntimeInstanceHost`、`ConnectorRuntimeHost` 和
  `ConnectorIngestClient`；HTTPX MockTransport 模拟 50 MiB 入口。
- 旧发送方式用等价的单次 JSON POST 复现，不启动旧 Connector。
- 55 MiB 合成文本分为 11 个 5 MiB item，桥接传输页本身可接受。
  不读取或上传用户的大历史，不连接实际 AA Server。
- 服务端使用真实 `Store` / `SqlTimelineStore` 与临时 SQLite 数据库。
  启动测试前清空继承环境，尤其不能继承 `AGENT_SERVER_DB_URL`：仓库的
  server conftest 可能对该变量指定的外部数据库执行清理。
- 没有操作正式 DSH 桌面版，未做真实 UI / Nginx / PostgreSQL 闭环。

## 结果矩阵

| 场景 | 实测结果 | 能否说明 #278 已解决 |
|---|---|---|
| 55 MiB 完整快照，旧单请求方式 | 模拟入口返回 HTTP 413；无检查点提交 | 复现问题 |
| 同一完整快照，当前补丁 | `ConnectorIngestSizeError(reason=atomic_notification)`；没有发出 HTTP 请求；无法保存 checkpoint | **不能** |
| 同一数据改为增量 `complete=false` | 每个请求不超过 8 MiB，全部 HTTP 200，ID/顺序完整 | 只证明增量分片传输成立 |
| DSH 消费循环遇到上述 size error | 桥接页 ACK 完成，但 commit 没有 ACK；再次订阅；状态一直为 starting；原 checkpoint 不前进 | **卡住状态仍可复现** |
| 9 MiB 完整快照 | 旧方式在 50 MiB 入口成功；当前 8 MiB 原子上限会拒绝 | 暴露额外兼容性风险 |
| 前两页增量、末页 complete=true | 服务端最后只保留末页，前页记录被删除 | **数据丢失，禁止作为修复** |
| 所有页均 complete=false | 新记录能写入，但旧的已删除记录仍残留 | 不是完整镜像替换 |
| 所有页均增量，原有 item 调整顺序 | 保留旧 orderSeq；真正完整替换才能重新排序 | 不能保证完整快照语义 |

缺少本地 checkpoint 也不能证明服务端为空，不能据此无条件把首次/恢复快照
降级为增量。中途失败或重装 Connector 后，服务端可能已有完整或部分历史。

## 代码链路

1. `connector/connector/runtimes/dsh/bridge/sync.py`
   - `snapshot.items` 可以多页接收、落临时 spool。
   - `snapshot.commit` 又把全部 item 合并成单个 `timeline.sync`，`complete=True`。
   - `run()` 捕获 size error 后仍写入 starting 并重新订阅。
   - commit 未成功，插件无法继续到 checkpoint / inventory 完成边界。
2. `connector/connector/server/ingest_batching.py`
   - 只拆增量 timeline；完整替换和不可分单条记录是原子通知。
   - 完整替换超 8 MiB 会本地拒绝，这是保护删除语义的边界，不是解决 #278。
3. `connector/connector/server/runtime_sync.py`
   - 冷却逻辑属于轮询扫描器；DSH 的 events 流不走这个单会话暂停分支。
4. `server/agent_server/services/connector_notifications.py`
   - `complete=True` 路由到 `replace_timeline_snapshot()`，不是追加末页。
5. `server/agent_server/infra/repositories/timeline.py`
   - 完整替换删除当前存储中、不在本次快照 ID 集内的记录。
   - 增量写入不做删除，且已有记录保留原先 orderSeq。

## 测试文件与证据

- `connector/tests/test_issue_278_dsh_snapshot.py`：基线时为 5 项现状刻画测试，
  部分断言当时仍被阻塞。之后已改为 6 项 Connector 侧隔离的验收测试（见上文“后续”）。
- `server/tests/test_issue_278_snapshot_semantics.py`：3 项，全部通过。
- 连同既有 `test_timeline_reconciliation.py`：服务端 10 项通过。
- Connector 关联回归（新用例、DSH event/checkpoint、ingest recovery）：30 项通过。
- 新增测试 Ruff 与 `git diff --check` 通过；lint 首次工具调用超时，单独执行后通过，未改测试断言。
- 较广 Connector 回归：1203 passed、2 个 Darwin 用例 skipped、1 failed。
  失败为既有 Pi `test_reannounce_session_states_after_reconnect`，观察到缺少
  `sess-live` 状态；单独定位复测为 1 passed。未修改该实现/断言，原因尚未
  查明，保留为独立待查项，不把重试通过写成完整回归全绿。
- 初始合成 runtime ID 不符合 rti_ 格式的 setup 错误已修正，不计入业务结论。

## 要真正修复 #278 的后续门槛

应设计并验证完整快照的分阶段原子提交，而不是只修改最后一页的布尔值：

1. begin / parts / commit：服务端按 connector、runtime、session、snapshot
   隔离暂存；每片按编码字节数限制，重复片幂等，不同内容的重复片拒绝。
2. 收齐并校验片数、条目数/唯一 ID、顺序和摘要之后，原子替换可见历史。
   未完成、取消或重启时，旧历史仍可用，checkpoint 不提前推进。
3. 提交必须与现有 session fence / revision 协调，防止陈旧快照删除或覆盖
   传输期间产生的更新。覆盖空快照、删除、重排、部分失败和恢复测试。
4. 永久超限要按会话隔离，并明确 bridge 的拒绝/跳过语义；不能伪造成功 ACK
   或 checkpoint，也不能把其他正常会话一起永久拖回 starting。
5. 定义暂存容量、超时回收和旧版本能力协商。旧服务端不能静默把新分片当作
   普通完整替换。此项涉及 Connector / Server / DSH 协议，需先确认契约。
6. 同时处理当前完整快照上限收紧至 8 MiB 的兼容性风险；临时放大上限最多
   缓解一部分请求，并不能代替可恢复、有界的完整快照协议。

本轮不擅自扩大到跨端协议实现，也没有把 issue 标记为已解决。下一步应先确认
完整快照契约与兼容策略，再进入失败验收测试和实现。
