# 设计：SpecRune 任务看板接入手机端

## 架构与边界

**只有 iOS 改，Connector 与 Server 原样复用**：

```text
工作设备                         云端（官方即可）            手机
┌────────────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ Connector（不改）       │   │ Server（不改）    │   │ iOS              │
│  shell.exec ────────────┼──▶│ POST /connectors │──▶│ Packages/        │
│   → 跑 specrune CLI     │   │  /{id}/shell/exec│   │  SpecRuneKit     │
│  fs.readText ───────────┼──▶│ POST /{id}/fs/   │   │  · SpecRuneClient│
│   → 读 .specrune/ 文件  │   │  readText        │   │  · 看板 UI       │
│  fs.readDir ────────────┼──▶│ POST /{id}/fs/   │   │  · 会话页        │
│   → 列目录              │   │  readDir         │   └──────────────────┘
└────────────────────────┘   └──────────────────┘
```

**边界**：
- Connector：只执行命令与读文件，不认识 specrune。
- Server：只鉴权与转发，不认识 specrune。
- iOS：承担全部 specrune 语义——拼命令、解析 JSON、组装模型、错误分类、渲染。这是「零改上游」的代价，也是它的收益：官方服务器直接可用。

## 零改上游结构（用户追加要求，已实证）

目标：**Connector 与 Server 一行不改**，功能全部住在 iOS 侧的独立 SPM 包，以后加功能只动包内。

```text
ios/
  Packages/SpecRuneKit/                   ← 新增：独立 SPM 包（全部功能）
    Package.swift
    Sources/SpecRuneKit/
      DTO.swift                           契约 DTO（nonisolated）
      SpecRuneClient.swift                取数：shell/exec + fs/readText + fs/readDir
      Models.swift                        DTO → UI 模型
      Views/SpecRuneBoardView.swift       看板（三栏自适应 + Duo）
  Agents Anywhere.xcodeproj               ← 改：加 XCLocalSwiftPackageReference（照 Textual 先例）
  Models/Chat/ChatShellSelection.swift    ← 改：加一个 case
  Views/ChatShell/*                       ← 改：入口注册
  API/V2/V2ConnectorAPI.swift             ← 改：加一个 shellExec 方法
```

**为什么能零改上游**：官方 Server 已有三条端点就够取全部数据，且都是既有能力：

| 需要的数据 | 既有端点 | 说明 |
| --- | --- | --- |
| 任务列表 | `POST /connectors/{id}/shell/exec?root=` | 跑 `specrune task list --json --all` |
| 任务摘要 | 同上 | 跑 `specrune task show <ref> --json` |
| 文档正文 | `POST /connectors/{id}/fs/readText?root=` | 读 `prd.md` / `design.md` / `implement.md` |
| 目录内容 | `POST /connectors/{id}/fs/readDir?root=` | 列任务目录、判断文件存在 |
| 项目版本戳 | 同上 readText | 读 `.specrune/.version` |
| 会话↔任务 | 同上 readText | 读 `.specrune/.runtime/sessions/dsh_<id>.json` |
| 项目清单 | `GET /api/v2/projects`（已有） | 再逐个 readText 判断 `workflow.md` |

**实证数据**：`specrune task list --json --all` = 3 566 B、`task show` = 451 B，远小于 `shell.exec` 的 `MAX_OUTPUT_CHARS = 64 000`；无 tty（stdin=DEVNULL）下输出纯净 JSON、exit=0、stderr 空。

**取舍**：`shell.exec` 返回的是 `stdout` 字符串，错误语义只有 `exitCode` + `stderr`，拿不到结构化 code。因此**错误分类放在 iOS 侧**：`exitCode != 0` 且 stderr 含 not found → 视为 CLI 缺失；JSON 解析失败 → 视为项目损坏。契约 1.0 的 `code` 表降级为 iOS 内部错误枚举，字段结构不变。

**为什么不改 Connector/Server**：官方远程 Server 不认识新增 RPC 方法，也没有通用 RPC 透传端点；本地改 Connector 也传不上去。加了扩展也只能在自建 Server 上用，属死代码。

## 数据流与契约

契约 [contracts/specrune/1.0](../../contracts/specrune/1.0/README.md) 的**字段结构仍是权威**（`SpecRuneTask` / 详情 / spec 的字段名、`truncated`/`bytes` 语义、1 MiB 截断口径）；变化的是「端点」这一层——不再有 Server 路由，而是 iOS 侧的取数流程：

```text
iOS SpecRuneClient
  ├─ listTasks(repo)        → shell/exec: specrune task list --json --all   → 解析 JSON
  ├─ taskSummary(repo, ref) → shell/exec: specrune task show <ref> --json    → 解析 JSON
  ├─ readDoc(repo, relPath) → fs/readText (maxBytes)                        → 文档正文
  ├─ listDir(repo, relPath) → fs/readDir                                    → 目录内容
  └─ sessionTask(repo, sid) → fs/readText .runtime/sessions/dsh_<id>.json   → current_task
```

**repo 参数**：项目绝对路径，来自 `V2Project`。取数前先用 `fs/readText .specrune/workflow.md` 判断是否 SpecRune 项目；不是则视为「该项目无看板」，列表里置灰而不报错。

**错误分类（iOS 侧）**：

| 现象 | 归类 | UI |
| --- | --- | --- |
| `shell.exec` 的 `exitCode != 0` 且 stderr 含 not found / no such file | CLI 缺失 | 「工作设备未安装 SpecRune」 |
| `exitCode != 0` 其它 | CLI 失败 | 显示 stderr 摘要 |
| `stdout` 不是合法 JSON | 项目损坏/版本不符 | 「无法读取任务数据」 |
| `stdoutTruncated == true` | 任务过多超 64K | 提示「任务过多，仅显示部分」 |
| `readText` 404 | 文件不存在 | 按字段留空，不报错 |
| 设备离线 | 连接失败 | 复用既有离线态 |

**CLI 定位**：由工作设备的 shell 环境决定（`PATH`）。iOS 侧不指定绝对路径——用户装在 `~/.dsh/specrune/bin` 但不在 PATH 时，回退用 `~/.dsh/specrune/bin/specrune` 显式路径重试一次。

## 兼容与迁移

- **无数据库变更**，无 Alembic 迁移。
- **无破坏性 API 变更**：只新增端点，不动既有 `/api/v2` 路径。
- **契约先行**：`contracts/specrune/1.0` 已落盘，各端按其手写 DTO；不接入 pydantic 导出脚本（该契约独立于 protocol）。
- **`ChatShellSelection` 扩展**：新增 `case specRune(V2ConnectorID)`。该枚举是 `Codable` 且用于恢复上次导航（`V2RestorationStore`），新增 case 需保证旧存档解码不失败——实现时给旧存档加兜底（未知 case → `.newSession`）。
- **iOS 版本**：不升版本号（`x.0.x` PATCH 允许各端独立），仅新增功能。

## 权衡

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 改哪一端 | 只改 iOS | 官方远程 Server 不认识新增 RPC，改 Connector 也传不上去；`shell/exec` + `fs/*` 已够 |
| 专用 RPC vs 复用 `shell/exec` | `shell/exec` | 前者要同时改三端且官方 Server 不支持；后者零上游改动 |
| CLI 调用 vs 直读文件 | 两者都用 | 任务列表/详情必须走 CLI（它解析 task.json 与派生字段）；文档正文用 `fs/readText` 拿全（避开 64K 上限） |
| 错误语义 | 放 iOS | `shell/exec` 只给 `exitCode`+`stderr`；结构化 code 由 iOS 按现象归类 |
| 入口 | 独立 tab（用户定） | 更显眼；代价是需扩 `ChatShellSelection` 与侧栏/rail |
| 会话关联 | 做（用户定） | 体验连贯；代价是多一次 `readText` 读 `.runtime/sessions/*.json` |

## 回滚

- Connector / Server **零改动**，无需回滚。
- iOS 回滚 = 删 `ios/Packages/SpecRuneKit` + 移除 xcodeproj 的包引用 + 移除 `ChatShellSelection` 的 case 与侧栏/rail 入口，并确认旧存档解码兜底仍在。
- 无数据迁移、无契约变更，回滚无残留。

## 备选方案

**方案 A：iOS 直连既有 `shell/exec` + `fs/readText`（采用）**
零改 Connector、零改 Server，官方远程 Server 直接可用。代价是 iOS 侧拼 shell 命令、解析 stdout JSON，错误分类也落在 iOS。

**方案 B：Connector 加专用 RPC（`specrune.*`）+ Server 加转发端点**
类型安全、错误语义清晰（结构化 code）、可在 Connector 侧缓存。**但官方远程 Server 不认识新方法，也没有通用 RPC 透传端点**——本地改 Connector 传不上去，必须自建 Server 或等官方发版。否决（作为将来官方支持后的升级路径保留）。

**方案 C：给 Connector / Server 各加一个极薄「扩展注册表」再挂 specrune**
能满足「以后加功能只动扩展目录」，但注册表本身就是上游改动，且仍绕不开方案 B 的 Server 问题（官方 Server 没有这个注册表）。否决。

**方案 D：Server 直连工作设备的本地 HTTP**
要求把面板端口暴露到公网。缺点：NAT/防火墙、鉴权面、安全风险，且面板端口只绑 localhost。否决。

**方案 E：iOS 内嵌 WebView 复用面板 React 代码**
UI 逻辑零重写，但面板依赖 DSH slot 宿主与同源 `/specrune/*`，手机无宿主。否决。
