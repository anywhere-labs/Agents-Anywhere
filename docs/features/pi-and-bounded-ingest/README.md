# Pi Runtime 与有界历史同步迁入

## 范围与来源

用户要求把已验证的同步修复和 Pi Connector 接入代码同步到本仓库。
基线：`main` 的 `7df5b31f`；工作分支：`codex/sync-fix-pi-runtime`。
只修改仓库代码、合成测试和文档，不部署、不重启现用桌面版，不复制凭据、
模型配置、历史、虚拟环境、诊断日志或 lockfile，也不推送远端。

- 同步修复：移植已验证的有界 ingest 补丁及回归测试。
- Pi：基于 `Seryta/pi-agents-anywhere` 的 MIT 源码，固定基础提交
  `9ec8eb089eb7e4564ed6efe0ebdbe0a5e1252710`，加上经过摘要校验的流式/审批/
  附件、Windows 启动与版本探测补丁。核心代码与既有安装比对一致；不引入
  外部 CLI 或 `.pth` 注册钩子，保留许可证和来源记录。
- 已对照本机 Pi 1.1.0 的 RPC、命令、事件、扩展 UI 和会话格式文档。

## 行为契约

1. HTTP 历史请求按 UTF-8 编码后的字节数分页，默认每页 8 MiB。
   仅增量 `timeline.sync` 按完整 item 拆分，保留 ID、顺序和 metadata。
   临时失败后从第一个未被接受的页继续，已接受的通知不重发。
2. `complete=true` 始终是整份替换快照，不是末页标志。不得分片、降级或
   截断；它和单个不可拆分条目超过页大小时单独整份发送，本地不设上限，
   只有服务端 413 才算超限。被拒的通知只跳过它自己，同批其他通知照常
   送达。所有批次成功才提交检查点，失败不虚假确认。
3. 413 仅冷却相应轮询会话，其他会话继续；源变化或冷却到期重试。DSH 完整
   快照被拒时只隔离该会话（报告 unavailable、不保存检查点、暂停其增量），
   commit 仍然 ACK，其他会话继续同步，runtime 照常进入 running。413 以外的
   拒绝可能是临时的，按 30 秒起、最长 30 分钟的退避请求新的完整捕获重传。
4. 默认 registry 的 Codex/Claude/DSH 保持原顺序，追加且只注册一次 Pi。
   标准 CLI 和桌面源码构建均使用同一注册表，无额外安装 hook。
5. Pi 保留 `ask-writes` 默认值、流式、审批拒绝/断线不执行、附件、原生
   会话和空闲回收行为。Pi CLI/Node 由用户另装，模型凭据不由 AA 接管。
6. 用通用的、默认 no-op 的 `on_backend_reconnect()` 生命周期回调替代外部
   monkeypatch；RuntimeInstance 转发，Pi 重报真实会话状态。保留 DSH 原有
   event `resynchronize()` 条件，不擅自对轮询 DSH 调用事件恢复。
7. 不改跨端 wire schema/API、不改权限默认值、不引入模型真实请求。

## 分工与阶段

当前阶段：已存在实现的迁入/兼容性验证，注册和生命周期 glue 采用红测先行。
先前本会话的执行器包装器不可用，因此由主线程直接迁移与验证；不并行实现
相同范围，不使用失败的包装器反复重试。

| 模块 | 策略 | 验证 |
|---|---|---|
| ingest / runtime_sync | 复用补丁；仅组合重连回调 | 有界、拒绝、重试、检查点回归 |
| runtimes/pi | 迁移 MIT 核心源码，调整 Python 包引用 | 上游合成 RPC/投影/审批/附件测试 |
| providers / lifecycle | 最小新增组合点，不做 Pi 特判 | registry 唯一性、实例转发、其他运行时隔离 |
| wheel / desktop payload | 确保 approval.ts 和 LICENSE 入包 | wheel 清单与桌面源码资源规则检查 |

## 验收与边界

在隔离 WSL Python 3.12 环境运行合成测试，避免 POSIX fake Pi 在 Windows 上的
执行限制。Windows 另做空 agent 目录的无模型 RPC smoke，以及合成审批扩展/
原生注册测试。不连接真实 AA Server，不启动第二个 Connector、不做真实模型/
计费/附件/审批会话。

回滚：本分支基于未修改的 main；还原本次跟踪文件并移除本次新增文件即可。
不使用 `git clean` 清理用户文件，不涉及现用安装。新构建和真实界面验收另行授权。

## 进度

- 原始同步补丁 `git apply --check --directory=connector` 通过。
- Pi 来源补丁 4 个摘要/应用校验通过。14 个源码/资源中 12 个与现用版一致，
  config 仅说明文字不同，cli 为幂等性调整；外部 cli/hook 不搬入原生实现。
- 修改前红测：有界请求、默认 Pi registry、轮询重连回调均行为性失败。
- 迁入后完整 Connector 套件：1197 passed、2 skipped、1 warning；两个跳过
  都是 Darwin 路径身份语义。原有测试只更新追加 Pi 后的 registry 期望，
  原前三个类型和架构断言均保留。
- Windows：实际审批 TypeScript 矩阵及 native glue 7 passed；Pi 1.1.0
  离线 get_state 成功、审批资源可加载、子进程已退出；没有发送模型 prompt。
- 构建 wheel 成功：Pi provider/runtime、approval.ts、MIT LICENSE、有界
  ingest 模块齐全；资源与源码一致，无自动 `.pth`、外部 pi_aa 包或私有配置。
- 修改文件 Ruff、`git diff --check` 通过。桌面源码资源过滤器包含新增包，
  但没有构建/安装正式 Electron 包，也没有运行真实 AA 服务端/模型会话。
- 测试中发现的失败均定位并保留说明：POSIX fake Pi 的 CRLF shebang 修为
  LF 并加 Git 属性；审批 harness 从外部包路径切为本包实际路径；测试
  launcher 的 CODEX_HOME 修正为隔离 HOME 下的 .codex（不改业务代码）。
- 冷启动 Pi 状态重报曾被 60 秒防抖误跳过：增加 uptime=5 秒的确定性
  红测（实际 0 次、期望 1 次），将尚未执行的时间哨兵改为 None 后转绿。
  原有冷却/重连测试保持断言，不通过延长等待或跳过掩盖问题。
- 隐私检查覆盖新增文件与修改行，共 47 个文件。两项命中分别是标准
  JSON Schema 公共地址和上游纯合成 provider fixture，人工复核非秘密。
  未复制真实凭据/模型配置/历史/日志/用户路径；规则扫描不能保证绝对无遗漏。
- 现用桌面 Connector 三个已部署修复文件的哈希保持不变；未部署、未重启。
- 后续 Mac SSH 验证完成：macOS 26.5.2 / arm64 上 1201 项全部通过，Pi 0.87.1
  离线 RPC 与 wheel 检查通过；两个 Darwin 用例实际执行通过。验证目录已清理。
- Mac 暴露的探针参数差异已用红测记录：旧 CLI 不支持 `--no-mcp`；改为按
  help 选择该可选参数，保留所有其他隔离措施。新增 2 项回归测试后，Linux
  全套为 1199 passed / 2 skipped，Windows Pi 1.1.0 smoke 保持成功。
- Mac 依赖准备超时、上传包过度过滤的收集失败及最终验收均如实记录于
  [mac-verification.md](mac-verification.md)，没有改动现用 Mac 服务或 Pi 安装。
- 用户已授权将迁入变更提交到当前本地分支；对应提交为 `f1f7a4f1`，未推送或部署。
- 后续补齐 Linux 实机基础 RPC：x86_64、Python 3.13.5、Pi 0.87.1，
  原生 registry 与真实 get_state/进程回收通过。按既有 Pi 服务用户执行，仅调整
  本次临时目录属主，验证后已清理；不改动现有安装/服务。见
  [Linux 验证记录](linux-real-pi-verification.md)。
- 按用户授权，三端 Pi 已统一到稳定版 1.1.0 并完成基础 RPC 检查；Mac/Linux
  配置哈希与历史清单未变化，保留私有软件回滚备份。Linux 原有专用 Node 是
  24.21.0，本次没有替换它或系统 Node；旧目录隔离/Node 识别记录已更正。见
  [Pi 升级验证](pi-latest-upgrade-verification.md)。
- 后续 issue #278 关联验证、实机验证和升级记录随下面的修复一起提交；
  它们不能作为 DSH 完整快照已修复的证据。
- 代码 review 后的修复（三个提交）：
  - ingest：不可拆分的通知超过页大小时单独整份发送，本地不再拒绝；被拒的
    通知只跳过它自己；临时失败从未被接受的页继续。
  - DSH：完整快照被服务端拒绝时只隔离该会话，runtime 照常进入 running
    （`Refs #278`，见 [#278 验证](issue-278-verification.md)）。
  - Pi：带检查点的增量时间线同步、流式临时 id 去冲突、sessionsDir 外路径
    拒绝、stderr 超长行、重连重报（含尚未落盘的会话、失败不进入冷却）、
    轮次结果、对话框关闭/超时、会话路径索引、runtime 能力白名单。
    重连测试的波动已查明：fake Pi 回复 prompt 后才写会话文件，测试改为等待
    本轮结束，另有用例覆盖尚未落盘的情况。
  - WSL Python 3.12 完整 Connector 套件：1237 passed、3 skipped；Pi 测试另外
    重复 3 轮均通过。真实 Pi、真实 AA Server、正式桌面包仍未验证。
- 用户要求由 Pi（`159-copy/gpt-6-astra`，xhigh，只读）复审上述提交，提出的
  8 个问题经代码核实全部成立，已修复：
  - Pi 扩展对话框改用平台交互类型（`confirmation` / `input_request` 表单），
    原 `pi.*` 类型不符合服务端 NoticeIn，通知被拒、对话框无法答复。
  - 状态/通知查询按文件路径匹配运行中的会话，AA 创建的会话不再被扫描报告为 idle。
  - 流式发布前删除检查点、未校准时不保存，一轮中途重启后整份替换。
  - 超过 64 MiB 的会话保留在 inventory 中并报告 unavailable，不再被标为缺失。
  - utility 进程启动加锁；get_state 超时（`PiRpcTimeout`）不再留下半初始化进程。
  - DSH：仅 413 视为不可重传，其他拒绝退避后用 `runtime.sync.refresh` 重传；
    `session.getState` 和 Host 元数据中的 source 也保持隔离状态。
  - 新增/修改的 18 项测试在修复前全部失败。WSL 完整套件 1250 passed、
    3 skipped；Pi 与 DSH 相关测试另外重复 3 轮均通过。
- 按用户要求做了 Windows 本机真实联调（本地 AA Server、本分支 Connector、Pi 1.1.0、
  真实模型、Web 客户端），发现并修复 8 项接入问题：思考等级无法在 AA 中选择、
  重复下发选择、空闲会话状态缺模型、扩展命令等对话框时 AA 报结果未知、命令不能带
  参数、缺少压缩命令、附件消息显示内部说明、一轮进行中用户消息排在输出之后。
  逐项结果见 [AA 真实联调记录](aa-e2e-verification.md)。新增和修改的测试在修复前
  失败；WSL 完整套件 1259 passed、3 skipped，Pi 测试重复 3 轮均通过。
