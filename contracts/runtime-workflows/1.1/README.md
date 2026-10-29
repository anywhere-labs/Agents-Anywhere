# Runtime 工作流 1.1

此契约为工作区准备和异步创建提供独立于 SessionNotice 的入口。标准会话事件、能力和目录使用 `contracts/protocol/1.1`；旧 `1.0` 产物保持冻结。Runtime Control 2.0 不增加逐请求协商。

| HTTP | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/v2/runtime-workflows/preparations` | 准备；HTTP 202，无平台会话 |
| POST | `/api/v2/runtime-workflows/creations` | 预留、分配平台会话并开始创建；HTTP 202 |
| GET | `/api/v2/runtime-workflows/{kind}/{id}` | 查询准备或创建；kind 为 `preparation` / `creation` |
| POST | `/api/v2/runtime-workflows/{kind}/{id}/responses` | 用请求版本、代际和回答身份回答 |
| POST | `/api/v2/runtime-workflows/{kind}/{id}/cancel` | 取消；已准入消息使用会话中断 |

操作归属用户、设备、实例和项目。客户端不能覆盖 cwd、运行类型或平台会话 ID。创建 ID 重试只返回同一平台身份，不同内容返回冲突；一次准备只能绑定一个创建操作。网络超时不会被当作消息未准入。

生成：`PYTHONPATH=server server/.venv/bin/python server/scripts/export_workflow_schemas.py`。

## 准备预留的确定拒绝

Runtime 明确报告没有预留时，创建操作保存 `phase=rejected`、`failureStage=reservation`、`platformSessionCreated=false`、`created=false`、`messageAccepted=false`，并在同一事务中释放本操作占用的准备。顶层 `sessionId` 为 null；查询、重试同一身份及取消均返回该终态，不重新执行预留。未知的传输结果继续保留占用与操作身份。
