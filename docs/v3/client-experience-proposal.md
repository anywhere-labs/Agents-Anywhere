# AA v3 客户端体验：信息架构、界面模式与附件

状态：定稿草案（2026-11-23 夜间整理，待 t4wefan 确认）。适用于 Web、Desktop、iOS、Android 四端。视觉规范以 [anywhere-ui](https://github.com/anywhere-labs/anywhere-ui) 为准（`docs/design-system.md`、`templates/console-next`），终端交互见 [terminal-proposal.md](terminal-proposal.md)，随身助手见 [assistant-and-files-proposal.md](assistant-and-files-proposal.md)。

## 0. 视觉与交互参考（t4wefan，2026-11-23）

| 端 / 部位 | 参考 | 约束 |
| --- | --- | --- |
| Web、Desktop 的输入框（composer） | Effi：`effi-evo/web`（`src/components/ai-elements/prompt-input.tsx` 及其用法），以及 Effi Cloud 的 `cloud/web/src/ai/composer.tsx`、`attachments.tsx` | 必须遵守 anywhere-ui 设计系统（语义色板、两级圆角、胶囊控件、无边框），不照搬 Effi 的颜色和字体 |
| Web、Desktop 的对话界面（消息样式、工具 / 思考 / 子 Agent 展示、对话选项）与右侧栏 | Effi Cloud 的 dev 设备对话页：`effi-evo/cloud/web/src/ai/`（`conversation.tsx`、`parts.tsx`、`tools.tsx`、`panel.tsx`、`file-preview.tsx`、`subagents.tsx`、`config.tsx` 等），截图在 `cloud/web/screenshots/` | 同上，一律以 anywhere-ui 为准 |
| iOS、Android | 暂以 v2 iOS（本仓库 `ios/`）的结构和交互为准 | 新版 iOS 与 Android 视觉对齐，以 Apple 设计规范（Human Interface Guidelines、Liquid Glass）为准；Android 照 iOS 的视觉实现 |

## 1. 业务层级

```text
账号
├── 随身助手（Pi Lite）：对话历史、云端工作区（与设备无关）
└── 设备（工作电脑，普通 / 加密）
    ├── Agent（Claude Code、Codex、Antigravity、Pi、Gemini …，按设备上报的 runtimes）
    │   └── 项目（工作目录 cwd，可选分组）
    │       └── 对话
    ├── 终端
    └── 文件
```

- 对话属于「设备 × Agent × 目录」。跨设备的地方只有两处：首页/侧栏的「最近对话」（按 `updated_at` 合并，规则见 `contracts/aa-v3/1.0` 的合并 fixtures），以及随身助手。
- 项目就是工作目录，不是另一种实体：同一目录下不同 Agent 的对话归在同一项目下，项目名默认取目录名。
- 设备的状态（在线 / 离线只读缓存 / 加密且未配对）在每一层都可见；离线设备的对话可以读缓存，不能发消息。

## 2. 界面模式

所有页面都用 anywhere-ui 的组件、语义色板和两级圆角，不另起一套样式。按页面职责分成四种外壳：

| 外壳 | 用在哪里 | 来源 |
| --- | --- | --- |
| 登录外壳 | 登录、OIDC 回调 | anywhere-ui `SignInShell` |
| 控制台外壳 | 账号、设置、外观、设备管理、管理员后台 | anywhere-ui `ConsoleShell`（侧栏 + 内容区） |
| 工作台外壳 | 对话、终端、文件、设备总览 | 在 `ConsoleShell` 基础上扩展：可折叠侧栏 + 主区 + 可选右侧面板 |
| 助手外壳 | 「助手为主角」模式下的主界面 | 工作台外壳的变体：主区是居中的助手对话 |

在工作台外壳内，有两种**主模式**（设置 › 外观 ›「助手为主角」开关）：

### 2.1 设备优先（默认）

- 侧栏自上而下：新对话按钮、搜索（⌘K）、置顶对话、最近对话（跨设备，显示设备和 Agent 小标）、设备列表。
- 设备列表每台设备一行：名称、在线点、锁标（加密设备，绿锁 / 灰锁）。展开后按 **Agent → 项目 → 对话** 三级显示；只有一个 Agent 或一个项目时省略那一级。
- 点设备名进入设备页（2.3），点对话进入对话页（2.4）。

### 2.2 助手为主角

- 主区默认是随身助手的对话；侧栏主列表是助手的对话历史。
- 侧栏下方是设备列表；点一台设备，侧栏**翻页**进入这台设备的子页面（返回按钮 + 该设备的 Agent → 项目 → 对话），主区仍可保持助手或切到所选对话。
- 两种模式下都可以随时用 ⌘J（移动端为底部 Sheet）呼出助手抽屉。

### 2.3 设备页

分区（Tab 或分段控件）：

- **概览**：状态、平台与版本、模式与锁、Agent 列表（每个 Agent 的可用状态、默认模型，未登录或未配置时显示原因和处理办法）、最近对话。
- **对话**：按 Agent / 项目分组的全部对话，支持筛选和归档。
- **终端**：终端列表与终端视图（控制者 / 旁观者，见终端方案）。
- **文件**：目录浏览、文件查看（文本高亮、图片、Markdown 渲染）、git 状态与 diff。
- **安全**（加密设备）：已配对客户端、配对二维码说明、撤销；普通设备显示「允许外部 Agent 控制（MCP）」开关。

### 2.4 对话页

- 主区：消息流（思考、工具、计划、子 Agent、审批、附件），底部输入框（附件、Agent 配置：模型 / 推理强度 / 权限模式，运行中可以插话或排队）。
- 审批：固定在输入框上方的审批区，不混在消息流里滚走。
- 右侧面板（宽屏，可关闭）：文件、diff、终端、计划。窄屏上改为从底部弹出的 Sheet。
- 顶栏：对话标题、设备 › Agent › 项目 面包屑、锁标、更多菜单（重命名、分叉、压缩上下文、删除）。

### 2.5 尺寸适配

| 宽度 | 布局 |
| --- | --- |
| ≥ 1280 | 侧栏 + 主区 + 右侧面板 |
| 768–1279 | 侧栏（可收起）+ 主区；右侧面板改为覆盖层 |
| < 768（手机） | 单栏导航：设备 / 对话列表 → 对话；侧栏改为抽屉（只从屏幕边缘滑出）；面板改为 Sheet |

移动端原生 App 的界面结构与上表的手机布局一致；消息流和终端在 WebView 里由同一份 web-v3 渲染包绘制，侧栏、顶栏、输入框、审批区、扩展键栏是原生控件。

### 2.6 全局

- ⌘K 搜索：设备、Agent、项目、对话、助手对话、设置项。
- 新对话：先选设备 → Agent → 目录（记住上次的选择），然后直接进入输入框。
- 空状态：没有设备时引导安装 Connector 或 Desktop；设备没有可用 Agent 时说明缺什么。

## 3. 附件

### 3.1 附件存在哪

**结论：附件保存在工作设备上、对话所在项目目录的 `.agents-anywhere/attachments/<对话 id>/` 里**；对话没有目录、或目录不可写时，退回 Connector 数据目录 `~/.agents-anywhere/connector-v3/attachments/<对话 id>/`。

理由：

- Agent 默认只在工作目录里有读写权限（Claude Code 读工作目录外的文件会弹审批，Codex 的沙箱同理）。放进项目目录后，Agent 用相对路径就能直接读，不产生额外审批。
- 附件和对话、项目放在一起，清理和排查都直观。

配套规则：

- Connector 第一次创建 `.agents-anywhere/` 时，写入 `.agents-anywhere/.gitignore`（内容为 `*`），附件不会被提交进仓库。
- 删除对话时一并删除它的附件目录；数据目录里的兜底附件 30 天未访问自动清理。
- 文件名做安全化处理（已有 `sanitizeFileName`），加短 id 前缀避免重名。

### 3.2 怎么传到设备

| 情况 | 路径 |
| --- | --- |
| ≤ 8 MiB（`AA_CONTROL_DRIVE_RPC_MAX_BYTES`，设备可调） | 客户端经隧道调 `aa.v3.Device/save_attachment`，字节随 RPC 走 |
| > 8 MiB | 客户端先传到**云盘**（预签名直传，流量不经控制面），再经隧道调 `aa.v3.Device/fetch_drive_file`，由设备自己从云盘下载到同一个附件目录 |
| 加密设备的大文件 | 客户端生成一次性文件密钥，加密后再上传云盘（`encryption_mode: "ephemeral_key"`）；密钥只经加密隧道交给设备，云盘和控制面都看不到内容 |

加密格式（`ephemeral_key`）：AES-256-GCM，密钥为 32 字节随机数（`file_key`，base64url），nonce 为 12 字节随机数（上传时作为 `encryption_nonce` 交给云盘记录），上传的对象 = 密文后接 16 字节认证标签，无附加数据；`sha256` 与 `size_bytes` 针对上传的对象（密文）。

- 云盘只是**中转**：设备下载完成后，附件以设备上的那份为准；云盘上的副本按云盘规则（默认 7 天）过期。
- 上限由云盘配额决定（默认单文件 100 MiB）；超过时在选择文件那一刻就提示，不等上传失败。
- 发消息时，附件以设备上的路径引用（`attachments: [{ path, name, mime, size }]`）。Connector 转给 Agent 时：图片在 Agent 支持图片输入（`promptCapabilities.image`）且 ≤ 5 MiB 时作为图片内容块内联；其他文件作为 `resource_link`（`file://` 绝对路径），并在提示里附上相对路径。

### 3.3 对话里怎么预览

- **用户消息里的附件**：图片显示缩略图网格（点开看大图）；其他文件显示胶囊卡片（图标、文件名、大小），点开在右侧面板预览。
- **Agent 产出的文件**：工具改动显示 diff；Agent 写出或提到的文件路径可点击，在右侧面板打开；Agent 输出的图片（`image` part）直接内联显示。
- **预览方式**：
  - 文本 / 代码 / Markdown：面板内高亮或渲染；
  - 图片：内联缩略图 + 大图查看；
  - PDF：Web / Desktop 用浏览器内置查看器，移动端交给系统预览；
  - Office 等其他格式：显示文件卡片，提供「下载」和「在设备上打开」（后者经 Desktop / Connector 调起本机默认程序）。
- **取字节**：≤ 8 MiB 经隧道 `read_file`；更大的文件由设备上传到云盘后给出临时下载链接（加密设备同样加密中转）。客户端按「设备 + 路径 + 修改时间」缓存。
- **移动端**：WebView 不联网，需要文件内容时经 bridge 请求原生层（`file.read`），原生层经隧道取回后交给 WebView。

### 3.4 随身助手的附件

助手的附件进助手自己的云端工作区（本地 OPFS / IndexedDB 热缓存 + 云盘 `assistant_vfs`，开启助手加密时用账号 DEK 加密），和设备上的附件互不相通；需要交给设备时，走 3.2 的路径重新发送。

## 4. 需要的接口改动

- `aa.v3.Device/save_attachment` 增加 `session_id`，由设备按 3.1 决定保存目录。
- 新增 `aa.v3.Device/fetch_drive_file({ session_id, file_id, name, mime?, sha256?, file_key? })`：设备用设备凭据向控制面换云盘下载链接，下载、校验 `sha256`、（有 `file_key` 时）解密后保存，返回 `{ path, name, mime, size }`。
- 删除对话时清理附件目录。
