# SpecRune 看板契约 1.0

SpecRune 任务看板在「工作设备」与「远端客户端」之间的只读数据契约。本契约的字段全部来自 SpecRune 既有产物，**不新增磁盘格式、不改 `specrune` CLI**：它们是 `specrune task list --json` / `specrune task show --json` 输出、任务目录下 `.specrune/tasks/<dir>/` 的文档文件、以及任务目录的 stat 时间——与 `~/.dsh/specrune/panel/lib/index.js` 的 `/specrune/*` 路由和 SpecRune Desktop 的 `/api/*` 已实现的是同一套语义。

## 为什么需要这份契约

任务看板的数据源只有三种本机资源：`.specrune/` 目录、本地 `specrune` CLI、本地 `git`。手机 App 看不到工作设备文件系统，只能经 Connector（工作设备上的进程）代理。为了让 Connector、Server、Android、iOS 用同一套字段，先冻结本契约，再在各端实现。

本契约**只定义只读数据面**（阶段 1）。写操作（worktree 分支增删、设父、升级）属阶段 2，不在 1.0 内。

## 数据流

```text
工作设备：specrune CLI / .specrune 文件
        │
        │  既有端点（无需改动）
        │  POST /connectors/{id}/shell/exec   → 跑 CLI，拿 stdout
        │  POST /connectors/{id}/fs/readText  → 读文档与配置
        ▼
Server（官方实例即可）
        ▼
iOS  SpecRuneKit 组合成下列逻辑端点   ← 本契约定义字段结构
        │
        ▼
    原生看板 UI
```

下列「端点与 schema 对应」表描述**逻辑端点**（客户端对外提供的数据形状）；手机端由客户端自行组合既有能力实现，详见文末「实现说明」。

## 通用约定

- **repo 参数**：Connector 收到的 `repo` 必须是该 Connector 工作设备上的绝对路径，且目录内存在 `.specrune/workflow.md`（证明是 SpecRune 项目）。不满足返回 `400 not_a_specrune_project`。**不做默认值**——自动取会话 workspace 是后续版本的事，1.0 一律显式传。
- **路径约束**：任务目录、文档、spec 引用文件一律解析后校验落在 `repo` 内（`relative` 不以 `..` 开头且非绝对路径），越界返回 `403 path_outside_repo`。
- **截断**：任何正文（`docs.*.content`、`spec.content`、`researchFiles[].content`）按 1 MiB（1048576 字节）生切，超长时 `truncated=true` 并给出 `bytes`（真实字节数）。客户端据此提示，不自行拼接。
- **字段来源标注**：字段旁 `[CLI]` 表示直接透传 CLI JSON；`[FS]` 表示 Connector 读文件/stat 得到；`[DERIVED]` 表示 Connector 基于前两者计算。
- **未知字段**：客户端保留不认识的可选字段，不因新增字段报错（`additionalProperties: true` 在响应根上）。
- **不实现**：gh/GitHub 集成、worktree 写操作、升级器、项目接入向导、DSH slot（会话行按钮/欢迎层）一律不在 1.0。

## 端点与 schema 对应

| 端点 | schema | 说明 |
| --- | --- | --- |
| `GET .../specrune/projects` | `project-list.response.schema.json` | 项目列表 + 活跃项目 |
| `GET .../specrune/tasks?repo=` | `task-list.response.schema.json` | 任务树（活跃 + 归档） |
| `GET .../specrune/task?repo=&ref=` | `task-detail.response.schema.json` | 任务详情（摘要 + 文档 + 上下文） |
| `GET .../specrune/spec?repo=&path=` | `spec-document.response.schema.json` | 规范正文（就地展开） |
| `GET .../specrune/session-task?repo=&session=` | `session-task.response.schema.json` | 会话↔任务关联 |

`.../specrune/*` 是 Server 侧对外路径；Connector 侧 RPC 方法一一对应：`specrune.projects`、`specrune.tasks`、`specrune.task`、`specrune.spec`、`specrune.sessionTask`。方法名与返回体在此一并冻结，避免两端各写一套。

## 错误响应

非 2xx 统一返回 `{ "error": string, "code"?: string }`。已分配的 `code`：

| code | HTTP | 条件 |
| --- | --- | --- |
| `not_a_specrune_project` | 400 | repo 为空、不存在或缺少 `.specrune/workflow.md` |
| `missing_param` | 400 | 缺 `repo` / `ref` / `path` / `session` |
| `path_outside_repo` | 403 | 解析后的路径越出 repo |
| `task_not_found` | 404 | ref 在当前 repo 下不存在（活跃或归档） |
| `spec_not_found` | 404 | spec 文件不存在 |
| `cli_failed` | 500 | `specrune` CLI 非零退出；`stderr` 摘要放 `error` |

## 与现有实现的对齐

- 字段语义以 `~/.dsh/specrune/panel/lib/index.js` 的 `/specrune/projects`、`/specrune/tasks`、`/specrune/task`、`/specrune/spec`、`/specrune/session-task` 处理器为准，逐字段核对（tasks 的 `at`/`born` 秒级时间戳、task 的 `docs.files`/`docs.docs`/`times`/`researchFiles`/`context` 拼装、spec 的 `.specrune/spec/` 前缀校验）。
- 不照抄宿主私有路由（`/specrune/ui-state`、`/specrune/host`、`/specrune/project/update*`、`/specrune/worktrees*` 等）——那些是桌面宿主 UI 状态或写操作，不属于只读看板。

## 实现说明：手机端走既有端点，不新增 Server 路由

iOS 端（`ios/Packages/SpecRuneKit`）**没有**按上面的端点表实现 HTTP 路由。原因是官方远程 Server 不认识新增 RPC 方法，也没有通用 RPC 透传端点；而官方**已有**的通用能力足够取全部数据：

| 需要的数据 | 既有端点 |
| --- | --- |
| 任务列表 / 任务摘要 | `POST /connectors/{id}/shell/exec?root=` 跑 `specrune task list --json --all` 或 `task show <ref> --json` |
| 文档正文、`.specrune/.version`、`.runtime/sessions/*.json` | `POST /connectors/{id}/fs/readText?root=` |
| 目录内容 | `POST /connectors/{id}/fs/readDir?root=` |

因此本契约在手机端的作用是**字段结构权威**（`TaskListItem` / 详情的 `docs`、`files`、`times`、`researchFiles`、`context` 形状、1 MiB 截断语义），端点表那一列是「逻辑端点」，由客户端自行组合。这也意味着**新增 specrune 功能不需要改 Server 或 Connector**。

错误码同样在客户端按「退出码 + stderr + 解析结果」归类，语义与下表一致。

## 版本演进

- 1.0：只读看板（本契约）。
- 后续：阶段 2 写操作另开 `contracts/specrune/1.1` 或在 `runtime-control` 下加 capability，不复用本版本。

## 文件清单

```text
contracts/specrune/1.0/
  README.md
  manifest.json                              # 5 个 schema 的 slug/path/sha256
  schemas/
    project-list.response.schema.json
    task-list.response.schema.json
    task-detail.response.schema.json
    spec-document.response.schema.json
    session-task.response.schema.json
```

## 验证

已用真实数据校验：取任一 SpecRune 项目（如 `specrune task list --json` / `task show <ref> --json`），按面板 `index.js` 的补字段逻辑拼装 `at`/`born`/`docs`/`files`/`times`/`context` 后，全部实例通过 Draft 2020-12 校验，schema 自身亦合法。

```bash
# 需要 jsonschema：pip install jsonschema（或临时 venv）
python3 - <<'PY'
import json, glob
from jsonschema import Draft202012Validator
for f in glob.glob("contracts/specrune/1.0/schemas/*.json"):
    Draft202012Validator.check_schema(json.load(open(f)))
    print("schema OK", f)
PY
```

手写契约不接入 `server/scripts/export_protocol_schemas.py`（那是 pydantic 导出，本契约独立于 protocol）。Connector/Server 实现本契约时按此 JSON 手写 DTO；若日后改为 pydantic 导出，再迁入该脚本。
