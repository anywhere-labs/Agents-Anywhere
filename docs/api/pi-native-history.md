# Pi 原生历史与顺序切换契约

Pi 的历史浏览由 Connector 直接读取 JSONL，不启动 Node、Pi SDK 或 ACP 执行实例，不创建配置。默认读取 `PI_CODING_AGENT_DIR`（否则 `~/.pi/agent`）内的会话及配置的额外历史目录。源文件位置只由 Connector 配置和索引决定，客户端不能传入任意文件路径。

执行优先使用本机 `pi` 安装提供的 SDK、依赖、配置及认证；`@openma/pi-acp` 是调用 SDK 的 ACP 适配器，不控制已打开的 CLI 进程。本机 SDK 不兼容或缺失时不静默回退。显式受管配置继续保留隔离环境；已有受管会话不得迁移到本机配置。

## 继续与释放

会话通过有效能力 `session.recover` 提供「继续任务」，通过 `session.close` 保留结束 AA 执行的能力。四端暂不展示 AA 已接手时的状态卡片及其中的「结束 AA 执行」按钮；浏览状态的「继续任务」入口和退出 CLI 确认仍保留，状态判断、恢复与释放逻辑不变。Pi 的原生来源能力附带 `metadata.nativeHistory=true`、`sourceRevision` 和 `requiresCliExitConfirmation=true`。会话状态含 `metadata.nativeHistory`、`sourceRevision`、`ownerGeneration`，错误包含 `code` 和可展示的 `message`。

`POST /api/v2/runtime-workflows/sessions/{sessionId}/recover` 在现有字段 `operationId`、`expectedGeneration` 外增加可选字段：

```json
{"cliExited": true, "sourceRevision": "sha256:..."}
```

Pi 原生来源要求 `cliExited=true`，表示用户已退出对应 CLI 会话；这不代表技术上的跨进程独占。`sourceRevision` 必须匹配索引的修订，首次恢复的 `expectedGeneration` 为浏览状态返回的所有者代际。后续恢复使用最新状态中的代际。请求经过 Server 的账号、设备、Runtime 和控制授权；Connector 再校验来源、文件修订、原生身份、工作目录、执行制品及审批守卫。

操作可返回 `phase=running/completed/rejected/outcome_unknown`；同一 `operationId` 保持同一输入与同一执行结果，客户端用同一请求查询进行中的恢复，不创建重复执行实例。恢复失败保留可读状态，不调用新建或分叉；完成且核验通过后才开放消息接纳。消息结果未知时不自动重投。

浏览零写入；执行允许原生历史追加及 SDK 必要的缓存、认证刷新。当前原地恢复只开放无需历史格式迁移的兼容格式，旧格式仍可浏览。工具审批覆盖受控工具与命令入口，不承诺拦截任意用户扩展内部副作用。守卫在首次加载、恢复与重载后的处理器顺序中保持首位。

## 同步与冲突

历史节点使用稳定原生身份投影。执行期间的 ACP 流式内容在持久化后以原生历史快照校准，重复扫描及恢复不新增重复节点。只对完整解析的文件发布完整快照；半行、读取失败不能清空已显示内容。

AA 内部所有权避免重复实例；原版 CLI 不受 AA 锁约束。受控 SDK 在写入前核对预期文件修订，执行期间同时监测来源变化；检测冲突后停止接纳并关闭执行实例，不自动合并、重投或分叉。该校验不提供文件系统级原子排他，无法消除原版 CLI 同时写入的竞态窗口。

用户结束 AA 执行后，等待执行进程确已释放，才能切回原 CLI。正常继续保留同一文件、原生会话 ID、历史与工作目录。
