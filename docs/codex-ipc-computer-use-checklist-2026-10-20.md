# Codex IPC 与 runtime phase：Computer Use 验收记录

日期：2026-10-20（Asia/Singapore）。范围：PR #299 的功能回归。

## 结论

初次验收完成 10 个可独立验收子项：9 项通过，1 项发现页面恢复问题；该恢复问题后续已实现修复并复测，见文末“创建失败恢复：实现后验收”。真实 Codex App/VS Code 双向 IPC 接管，以及 DSH 完整同步恢复没有完成，不能据此判定 #299 整体验收通过。

`[x]` 表示该项已经实际执行并核对结果，不代表结果一定通过；失败会明确标记。`[ ]` 表示范围尚未完整覆盖，旁边注明部分结果或阻碍。子项单独计数，避免把 AA 单端操作当作 IPC 双端通过。

## 被测环境

- 工作区：`/Users/wang/code/jxx/Agents-Anywhere`。
- 被测提交：`39b82d4fffb178a1217abd057e546374c57c030a`；源码组件版本 2.1.0。不是 #299 原始合并提交 `83783015`。
- Server/Web/Desktop 进程 cwd 均为当前工作区，2026-10-20 11:21 启动。
- Chrome Web：`http://127.0.0.1:5174`，用户完成登录；AA Electron：`http://127.0.0.1:5184`；Server：`http://127.0.0.1:8000`。
- 临时目录：`/tmp/aa-ipc-qa-20261020`，规范化为 `/private/tmp/aa-ipc-qa-20261020`。目录规范化使界面出现两个 QA 项目名称，均保留用于复核。
- Codex QA 会话：`sess_IgUVz-7-WbsMfw`，标题 `IPC AAIPC-QA-20261020-A AAIPC-ACK-A`。
- 新增测试 Runtime：`QA DSH 20261020`，`rti_NkyFwWlr3uWjzDr1`；测试结束后已停用。
- 使用 Computer Use 操作真实 AA Desktop 和 Chrome；CDP 只观察页面触发的网络响应；命令行只做环境核对、准备临时附件和读取日志。
- 截图、DOM/可访问性文本及响应证据保存在本地 [证据目录](../.local-dev/qa-20261020-ipc/)，未上传外部系统。

## 已实际完成的子项

- [x] UI-01【通过，IPC-02/04 的 AA 单端部分】AA Desktop 创建临时项目和 Codex 会话，提交 QA 消息并收到 `AAIPC-ACK-A`。不能证明另一 Codex 窗口收到消息。
- [x] UI-02【通过，IPC-07 的 AA 客户端部分】Desktop 将会话从 Low/GPT-5.6-Sol 切到 Medium/GPT-5.6-Luna；Web 打开同一会话后显示同一设置。最终已从 Web 恢复 Low/GPT-5.6-Sol。未验证 Codex 窗口同步或底层实际选模。
- [x] UI-03【通过，IPC-05 的 AA 中断部分】Web 提交输出 1 至 5000 的任务，运行时点击中断，输出停在 201，运行提示消失，输入框恢复。刷新后仍停在 201。[截图](../.local-dev/qa-20261020-ipc/05-web-interrupt.png)。第一次 Desktop 中断尝试没有阻止 1 至 500 完整输出，不计为通过。
- [x] UI-04【通过，Desktop 配置展示】配置面板显示两个 IPC 开关，均为 on，说明正确；取消关闭，没有保存或切换共享 Runtime 配置。[截图](../.local-dev/qa-20261020-ipc/02-ipc-config.png)。
- [x] UI-05【通过，RT-01/02/08 的 Desktop 等待阶段】新增独立 QA DSH 实例后显示“启动中 / 正在等待本地 DSH Bridge；请启动 DSH 并启用手机连接插件。”，没有故障徽标。[截图](../.local-dev/qa-20261020-ipc/03-dsh-waiting.png)。
- [x] UI-06【原始问题，后续已修复，RT-03 的 waiting_bridge 子场景】分别从 Desktop 和 Web 在 DSH 等待阶段创建任务。Web 实际响应是 `409 runtime_starting`，`retryable: true`，带 `phase.code=waiting_bridge`；两次创建操作没有触发新的 `runtime.start`。但两个客户端随后均保留 failed/“正在创建会话…”不可输入占位，没有就地重试入口。[响应](../.local-dev/qa-20261020-ipc/08-web-dsh-409.json)、[截图](../.local-dev/qa-20261020-ipc/08-web-dsh-409.png)。不覆盖 syncing 阶段。
- [x] UI-07【通过，IPC-10 的 AA 页面恢复部分】Web 在 `/bin/sleep 20` 回合运行中刷新，重新加载后仍显示原活动回合，随后收到一次 `QA_REFRESH_DONE`，输入框恢复。历史和模型选择保留。[截图](../.local-dev/qa-20261020-ipc/10-refresh-complete.png)。
- [x] UI-08【通过，IPC-11 的 AA 上传部分】Web 同时上传临时文本和图片，预览正常。没有在提示里给出答案，模型实际读出文本令牌 `ORANGE-7429`，并识别图片左红右蓝。用户修复 Chrome 扩展文件权限后重试成功。[截图](../.local-dev/qa-20261020-ipc/09-attachments.png)。未覆盖真实 Codex 窗口反向上传。
- [x] UI-09【通过，Web 配置展示】Web 配置面板显示 IPC 与 deeplink handoff 开关，状态和 Desktop 一致；取消关闭。[截图](../.local-dev/qa-20261020-ipc/06-web-config.png)。
- [x] UI-10【通过，RT-06/08 的 Web 等待阶段】刷新 Web 设备页后 phase 保留，观察实际 runtimes 响应：Codex 为 `running/phase=null/error=null`；QA DSH 为 `starting/phase.waiting_bridge/error=null`，页面文案与 API 一致。[响应摘要](../.local-dev/qa-20261020-ipc/07-runtime-phase.json)、[截图](../.local-dev/qa-20261020-ipc/07-web-dsh-waiting.png)。未覆盖 Connector 重连。

## 原计划完整项 TODO

### Codex IPC

- [ ] IPC-01：真实 Codex App 会话在 AA 中显示，核对双方历史和状态。阻碍：工具禁止访问 Codex App。
- [ ] IPC-02：AA 向真实 App owner 发消息，两端核对执行一次。AA 单端已完成 UI-01；另一端不可控制。
- [ ] IPC-03：真实 VS Code 插件发现、跟随、发送及同步。命令面板输入 Codex 显示“没有匹配的命令”；当前窗口为受限模式，未安装插件或扩大工作区信任。
- [ ] IPC-04：AA 创建会话后，真实 Codex App/VS Code 打开并继续。AA 创建完成；真实窗口验证受上述阻碍。
- [ ] IPC-05：双 owner 方向引导和中断。AA 中断完成 UI-03；没有完成运行中引导和双 owner 验证。
- [ ] IPC-06：跨端允许、拒绝审批，核对实际效果。缺少可控制的真实 Codex owner 窗口及待审批样本。
- [ ] IPC-07：双向模型、推理强度及权限同步，验证实际行为。AA 设置同步完成 UI-02；Codex 窗口及权限效果未完成。
- [ ] IPC-08：窗口打开与 AA 立即发送的竞态。不能控制真实窗口，未执行。
- [ ] IPC-09：Connector、owner、router 故障恢复。共享环境承载用户当前任务，没有隔离实例，未停机或终止进程。
- [ ] IPC-10：IPC snapshot/patch 流、切页、刷新及双端最终状态。AA 页面恢复完成 UI-07；不能将其视为 IPC 协议验收。
- [ ] IPC-11：真实 Codex 与 AA 双向图片及文件附件。AA 上传及内容读取完成 UI-08；真实窗口反向上传未完成。
- [ ] IPC-12：跨端回复用户输入请求并继续任务。没有可控制的另一端和可复核的用户输入请求样本。
- [ ] IPC-13：关闭 IPC 后检查自有与持锁线程，再恢复。只检查了配置；未切换共享实例开关，以免影响用户任务。
- [ ] IPC-14：open-in-codex-app 打开目标线程并核对交接。AA 命令建议中可见该命令；因 Codex App 控制被拒绝，没有执行或绕过限制。
- [ ] IPC-15：有写锁、无 owner 应答时自动交接。没有隔离的真实窗口及持锁场景，未执行。
- [ ] IPC-16：kill-chatgpt 后继续会话。当前 App 承载本次聊天，未退出或终止它。
- [ ] IPC-17：残留锁文件、无人持有的历史线程、零轮会话。普通新会话已创建；未构造锁文件和 owner 生命周期，保持未完成。

### Runtime phase

- [ ] RT-01：DSH 连接、同步至 running 的完整阶段。等待 Bridge 子项已完成；本机未发现可用 DSH App/Bridge。
- [ ] RT-02：等待 Bridge 后启动 Bridge 恢复。等待阶段已完成 UI-05，恢复未执行。
- [ ] RT-03：syncing 期间连续操作，核对 409 和不重复启动。waiting_bridge 下 Desktop/Web 各提交一次已完成 UI-06；真实 syncing 及连续重试未覆盖。
- [ ] RT-04：同步断连、恢复、历史完整性。无可连接 Bridge，未执行。
- [ ] RT-05：真实 error 与残留 error 的徽标。正常 waiting_bridge 不误报已确认；没有注入真实故障或残留 error。
- [ ] RT-06：刷新、Connector 重连后 phase 与事件/API 一致。Web 刷新和 API 一致完成 UI-10；Connector 重连及实时事件细节未覆盖。
- [ ] RT-08-Web：完整状态矩阵及配置字段。waiting_bridge 与 IPC 配置完成 UI-09/10，其他阶段未覆盖。
- [ ] RT-08-Desktop：完整状态矩阵及配置字段。waiting_bridge 与 IPC 配置完成 UI-04/05，其他阶段未覆盖。
- [ ] RT-08-iOS：无可控制的模拟器或真机画面，未执行。
- [ ] RT-08-Android：无可控制的模拟器或真机画面，未执行。

## 问题：启动冲突后留下不可输入的创建占位

复现：

1. 添加独立 DSH Runtime，保持 Bridge 不可用，确认实例为 starting/waiting_bridge。
2. 从临时项目新建任务，选择该实例，填写消息并发送。
3. Server 返回 `409 runtime_starting`、`retryable: true` 和等待 Bridge 原因。
4. 客户端先提示等待原因，随后停在临时会话页；消息标记 failed，输入框显示“正在创建会话…”且禁用，没有就地重试入口。
5. Desktop 与 Web 均观察到相同现象；没有等待 Bridge 恢复，因此恢复后该占位能否自愈未知。

判断：Server 的启动保护在此场景符合预期；客户端可重试失败后的交互恢复存在问题。尚未定位引入提交，不认定为 #299 新增回归。

## 证据与限制

- Computer Use 对 `com.openai.codex` 返回禁止访问（安全限制），未使用其他途径绕过。
- Chrome 附件权限最初缺失，用户已修复，之后上传及内容读取完成；该环境阻碍已解除。
- native typeText 的初始中文指令提交后只出现缩略内容，未将其直接认定为产品缺陷；后续采用 paste/Web fill 并核对全文。
- 第一次 Desktop 中断后 Web 读到完整 1 至 500；后续 Web 明确点击中断后停在 201，才作为成功证据。`01-aa-interrupted.png` 只是早期尝试截图，不能单独证明中断成功。
- 创建任务操作没有触发额外 runtime.start。另一次点击设备页“刷新”（触发 runtime.discover）在 11:42:16 产生两次 runtime.start RPC；这与创建任务的 409 检查分开记录，不能据此宣称整轮无额外启动。未验证 discover 下是否实际重建 Runtime。
- [聚焦 Server 日志](../.local-dev/qa-20261020-ipc/server-focused.log)仅包含 QA 会话与必要 Runtime 记录，不包含认证票据。
- 没有修改应用实现、创建或改动 tests/ 内容；没有部署、重启共享 Connector、终止 Codex App 或改动其权限。

## 收尾状态

QA DSH 实例已通过页面停用，显示“未启动”，原 Codex 仍为“运行中”。QA 会话已恢复 Low/GPT-5.6-Sol，保留临时会话、附件和项目供复核，没有删除用户数据。

[收尾截图](../.local-dev/qa-20261020-ipc/11-qa-dsh-stopped.png)


## 创建失败恢复：实现后验收（2026-10-20）

本节为后续修复的独立结果，不覆盖前文 #299 IPC 双端与真实 DSH Bridge 的未完成项。实现时当前工作区 HEAD 为 `989d4ceb`，修复尚未提交。Web 与 Desktop 同步增加工作区所有的创建草稿、创建中/失败状态、手动重试、返回编辑及未知结果保护；Server、数据库与 API 契约未改。

### Server 启动保护与客户端恢复

- [x] REC-01【Web，真实 waiting_bridge】重新启用 QA DSH 后提交任务，出现“任务尚未创建”、Bridge 等待原因及重试/返回编辑/查看设备会话，失败页不再显示永久禁用的创建输入框。[失败页截图](../.local-dev/qa-20261020-recovery/web-failed-retry.png)
- [x] REC-02【Web，真实 waiting_bridge】点击一次重试产生一次 `create-and-start` 请求，仍为 409，临时会话 URL 不变，消息不重复，重新出现恢复按钮。双击与并发重试的单请求保护另外通过临时状态机检查。
- [x] REC-03【原生 Desktop，真实 waiting_bridge】失败页显示同样的恢复入口；执行重试后仍停留同一临时会话，返回编辑恢复原文及原 Runtime。[失败页](../.local-dev/qa-20261020-recovery/desktop-failed-retry.png)、[恢复编辑页](../.local-dev/qa-20261020-recovery/desktop-restored-editor.png)
- [x] REC-04【Web，受控 409】支持附件的 Codex 场景，在请求到达 Server 前注入 `runtime_starting + retryable`，返回编辑后保留原文、项目路径、Runtime、权限选择和两个文件；修改文字后离开页面再回来，修改与附件仍保留。[恢复编辑截图](../.local-dev/qa-20261020-recovery/web-restored-editor.png)
- [x] REC-05【Web，受控拒绝后真实重试】移除拦截后手动重试，Server 真实返回 200，绑定一个正式会话 `sess_vtCA1IWRMJ3eqg`；模型从原附件读出 `ORANGE-7429`，识别图片左红右蓝。此项验证客户端恢复到真实 Codex 执行，不代表真实 DSH Bridge 恢复。[截图](../.local-dev/qa-20261020-recovery/web-retry-success.png)
- [x] REC-06【Web，真实成功】纯附件任务创建成功，返回一个附件，正式会话 `sess_8tOZPzuMgEPdiw` 正常展示；该会话后续发送消息收到 `QA_EXISTING_ACK`。[截图](../.local-dev/qa-20261020-recovery/file-only-existing-message.png)
- [x] REC-07【Web，真实成功回包】暂缓纯附件创建请求，先切到设备页，再放行请求；成功后仍停留设备页，未强制跳回，能从设备列表打开正式会话。[结果摘要](../.local-dev/qa-20261020-recovery/leave-create-result.json)
- [x] REC-08【Web，受控 500】注入 500 后显示“创建结果未确认”，只提供查看设备会话入口，不显示直接重试或返回编辑以重复创建。[截图](../.local-dev/qa-20261020-recovery/web-result-unknown.png)
- [x] REC-09【Web，图片预览】最终代码恢复编辑后，图片实际加载 complete=true、naturalWidth=160、naturalHeight=80；放弃草稿后文字及附件清空。[截图](../.local-dev/qa-20261020-recovery/web-restored-image-final.png)
- [x] REC-10【Web，非默认模型】Medium/GPT-5.6-Luna 在失败后返回编辑仍原样保留。收尾恢复 Low/GPT-5.6-Sol。[截图](../.local-dev/qa-20261020-recovery/web-model-restored.png)
- [x] REC-11【临时 headless 功能检查】验证同身份重试、双提交保护、File 内容保留、正式会话绑定、非 runtime_starting 冲突不重试、未知结果不重复创建、退出登录后的迟到响应隔离及预览资源清理。[运行结果](../.local-dev/qa-20261020-recovery/smoke.log)
- [ ] REC-12【真实 DSH Bridge 恢复】本机仍没有可用 Bridge，未验证 Bridge 就绪后 DSH 的真实手动重试执行；不以 Codex 的成功替代。
- [ ] REC-13【原生 Desktop 附件端到端】已验证原生 Desktop 文本失败恢复；带附件的恢复与真实执行主要在 Web 验证，没有重复执行原生文件选择与后续真实读取。

受控故障仅在 QA 标签页拦截指定创建 API 的 Fetch 请求，不改变应用实现或 Server 响应逻辑；每次注入后清除拦截。500 为测试注入，不是本次发现的真实 Server 故障。真实 waiting_bridge 仍由 Server 原生返回。

### 工程检查

- [x] Web `yarn typecheck`、`yarn protocol:check`。
- [x] Desktop `yarn renderer:typecheck`。
- [x] 27 项相关现有测试通过：workspace inventory、new-session runtime inventory、project workspaces、attachment MIME。[日志](../.local-dev/qa-20261020-recovery/related-tests.log)
- [x] `git diff --check`。
- [ ] Web 全量测试全绿：实际 379 通过、5 个测试模块加载失败。对未修改的 HEAD 副本运行同样 5 个模块，仍全部失败，错误包括 redux 模块缓存与 exports 读取异常；属于已复现的基线环境问题，未修改测试或依赖绕过。[当前日志](../.local-dev/recovery-web-test.log)、[基线日志](../.local-dev/recovery-baseline-test.log)

测试没有新增或修改 tests/ 及现有测试文件；额外状态机检查脚本仅放在临时目录。QA DSH 测试实例已停用，原 Codex 保持运行；本地测试草稿已明确放弃，保留创建成功的 QA 会话与截图供复核。未部署、未提交。
