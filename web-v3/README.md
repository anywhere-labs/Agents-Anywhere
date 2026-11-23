# Agents Anywhere v3 Web Workbench (`web-v3`)

Agents Anywhere v3 的新一代 Web 工作台，基于 **Next.js 16 (App Router) + Anywhere UI + MeshCall v0.4 (`meshcall/web`) + Pi Lite (`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`)** 构建。

## 快速运行

```bash
cd web-v3
corepack yarn install
# 指定 server-v3 控制面地址（通过 Next.js /api/control 代理转发，避免本地 CORS 问题）
AA_CONTROL_SERVER_URL=http://127.0.0.1:8787 corepack yarn dev
```

默认监听 `http://127.0.0.1:3001`。也可直接通过 `NEXT_PUBLIC_AA_CONTROL_URL` 指定浏览器直连的控制面 URL，或在 `/sign-in` 页面手动切换控制面地址。

## 已实现功能

- **认证边界（AA v3 本体）**：
  - `local` 模式：简洁的邮箱 / 密码登录与首次管理员引导注册（`/sign-in`）。
  - `oidc` 模式：作为标准 OAuth 2.0 / OIDC PKCE S256 客户端接入统一认证中心（如 `anywhere-auth`），回调路径 `/auth/oidc/callback`。
  - 严格不在 AA 本体中提供 IdP 或通用 OAuth 服务端管理页面；仅保留成员 / 管理员角色权限展示与受限 `/mcp/grants` 撤销。
  - 支持侧边栏底部多账号切换（`AccountSwitcher`），会话凭据存于浏览器 IndexedDB。
- **跨设备工作台与双模式 MeshCall 隧道**：
  - 接入 `server-v3` 控制面 `aa.v3.Control/*`（自动签发与刷新 `mt_` Router Token）。
  - 普通设备与加密设备统一走 `meshcall/web` 隧道（`aa.v3.Sessions`、`aa.v3.Device`、`aa.v3.Terminals`）。
  - 加密设备严格执行 **带外一次性 `aa-pair://v1/...` 配对**（`Noise_IKpsk2` 首配 + `Noise_IK` 后续连接）、IndexedDB 公钥钉扎（`require_e2ee: true` 不可明文降级）与 **Web 灰锁分级**（`E2eeLockBadge`）。
  - 多设备会话合并器严格对齐跨端契约 `contracts/aa-v3/1.0/fixtures/session-merge.json` 全部 6 组用例。
  - 信息架构按 `docs/v3/client-experience-proposal.md`：侧栏为新对话、⌘K 搜索、随身助手、置顶、跨设备最近对话和设备列表，设备展开为 Agent → 项目（工作目录）→ 对话；「助手为主角」模式下点设备侧栏翻页进入设备子页。
  - 新对话（`/new`，设备优先模式下也是首页）：选设备 → Agent → 目录（记住上次选择），第一条消息发出时才创建对话。
  - 对话页（`/sessions/[deviceId]/[sessionId]`）：实时流式时间线（视口虚拟化、滚到顶部自动加载更早消息；工具调用与思考折叠成一行摘要）、设备 › Agent › 项目面包屑与更多菜单（重命名、置顶、分叉、压缩上下文、详情、导出、删除）、审批直接出现在对应工具调用下方（滚出视野时输入框上方有「查看」提示）、最后一条回复可「重新生成」、用户消息可撤回、空对话时输入框居中、拖到页面任意位置即可添加附件、排队消息（立即发送 / 编辑 / 移除，编辑时附件一并带回），右侧面板（文件、改动、终端、计划）在 ≥1280 并排、768–1279 覆盖、手机为底部 Sheet。
  - 输入框（参考 Effi）：多行增高、附件粘贴 / 拖入 / 选择并显示进度，≤ 设备直传上限走 `save_attachment`，更大的经云盘中转后由设备 `fetch_drive_file` 拉取（加密设备用一次性密钥加密）；模型 / 推理强度 / 权限选择；运行中 Enter 排队、⌘/Ctrl+Enter 插话、Esc 停止；`/` 命令；按对话保存草稿。
  - 快捷键：⌘K 搜索、⌘⇧O 新对话、⌘B 侧栏、⌘J 助手、⌘/ 快捷键一览（也在 ⌘K 里）。
  - 设备页（`/devices/[deviceId]`）：概览（Agent 列表、状态、最近对话、重命名 / 删除）、对话（按 Agent / 项目分组与筛选）、终端、文件（浏览与预览）、安全（配对、已配对客户端、MCP 开关）。
  - 终端（`aa.v3.Terminals`，设计见 `docs/v3/terminal-proposal.md`）：屏幕快照首帧 + `seq` 断线续传、单控制者多旁观者（无人控制时输入即接管，他人控制时提示「接管」，可「接管并保持尺寸」）、旁观者按控制者行列数渲染、非 PTY 设备提示不支持全屏程序；触屏设备支持单指滚动（含惯性）、长按选择复制、双指缩放字号与扩展键栏（Esc、Ctrl、Tab、方向键、PgUp/PgDn、Home/End）。协议状态机 `lib/terminal/` 不依赖 React，传输层可替换为移动端原生 bridge。
  - 移动端渲染包（[`embed/`](embed/README.md)）：iOS / Android WebView 加载的单文件 HTML（`corepack yarn embed:build` → `embed/dist/aa-render.html`），复用上面的对话组件与 xterm.js 终端，经 `aa.render/2` bridge（[`docs/v3/mobile-bridge.md`](../docs/v3/mobile-bridge.md)）收发消息，自己不联网；附夹具回放页与无头冒烟测试。
- **随身助手 Pi Lite + 云端工作区 VFS（T518）**：
  - 按需动态加载 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`（不污染首屏体积）。
  - Tokens Anywhere PKCE S256 一键接入 + 账号级单 Key 跨浏览器复用与自动续期（`/assistant/tokens`、`/oauth/tokens/callback`），以及本地 BYOK API Key 回退。
  - 浏览器端 OPFS 热缓存 + IndexedDB 兜底的 `/workspace` 云端工作区（支持 6 个 Pi 文件工具与加密云盘同步）。
  - 多服务 Streamable HTTP MCP 客户端，支持 **一键挂载 AA 自己的 `/mcp`**（默认不勾选 `approvals:answer`）与高风险写操作 `beforeToolCall` 弹窗确认。
  - 任意密码 PBKDF2-SHA256 + AES-256-GCM KEK/DEK 多设备加密同步（允许任意长度密码、短密码仅温和提示、AAD 绑定防替换、修改密码不重加密旧会话、忘记密码显式重置）、双指纹三路冲突检测与 SSE 跨端实时同步。
  - 全局右侧抽屉（`⌘J`）+ 独立全页（`/assistant`）+ **「助手为主角」** 侧边栏视图切换（主列表优先显示随身助手历史对话，点击工作设备翻页钻入设备子视图）。
- **设置页（`/settings`）**：主题与语言（仅位于外观设置，不在侧边栏重复展示）、「助手为主角」布局开关、友好本地化的账号额度说明（不暴露内部字段名）、限额云盘清理、管理员单账号云盘配额策略、MCP 授权撤销、浏览器本地 E2EE 凭据库。

## Desktop 静态导出

[`desktop-v3`](../desktop-v3/README.md) 把本应用构建成静态导出打进安装包，用 `app://aa/` 加载（绿锁）：

```bash
AA_DESKTOP_EXPORT=1 corepack yarn build   # 产物在 .next-desktop/，不影响同时运行的 next dev
```

- 动态路由在导出时只为占位参数 `_` 生成页面（见各路由的 `layout.tsx`），Desktop 把任意 id 映射到占位页，页面用 `useRouteParams` 从地址栏读取真实 id。
- `lib/platform/desktop.ts` 只在 Desktop 里生效：客户端私钥与 refresh token 存入系统钥匙串、加密设备显示绿锁、控制面请求经 Desktop 主进程转发。在浏览器里这些都不起作用。

## 注意事项

- 遵循仓库规范：**不提交 `yarn.lock`**（已被根目录 `.gitignore` 忽略）。
- IndexedDB 凭据库仅存于当前浏览器站点存储；清理站点数据后加密设备需重新配对。
- Web 端属于「灰锁」信任等级（防范传输与服务端被动泄露）；若需防范恶意服务端替换前端脚本，请使用独立分发的原生客户端（绿锁）。

## 开发与验证命令

```bash
cd web-v3
corepack yarn typecheck
corepack yarn lint
corepack yarn test
corepack yarn build
```

移动端渲染包另有 `corepack yarn embed:build && corepack yarn embed:smoke`（见 [embed/README.md](embed/README.md)）。

## 相关文档索引

- 跨端契约与测试夹具：[contracts/aa-v3/1.0/README.md](../contracts/aa-v3/1.0/README.md)
- E2EE 接入与灰锁分级设计：[docs/v3/e2ee-admission-proposal.md](../docs/v3/e2ee-admission-proposal.md)
- 随身助手 Pi Lite 与云端工作区设计：[docs/v3/assistant-and-files-proposal.md](../docs/v3/assistant-and-files-proposal.md)
- Agent 协作与设计系统护栏：[AGENTS.md](./AGENTS.md)
