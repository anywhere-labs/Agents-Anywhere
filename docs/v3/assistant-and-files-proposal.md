# AA v3 扩展设计：Orches（编排）与限额大文件云盘

状态：方向已确认。2026-11-24 起 Orches 定位为编排子产品，是工作台的一级模块（第 1、2 节），界面按 2.5 分步实现；运行底座、同步、加密、云盘和实验性能力（第 3–7 节）不变。代码里仍沿用 `assistant` 这个名字（`lib/assistant/`、`assistant-context`、偏好字段 `assistantPrimary`），界面上一律叫 Orches。

相关主干设计：
- 总体架构（控制面、隧道、聚合 RPC 与 MCP）：[architecture-proposal.md](architecture-proposal.md)
- 加密设备准入与端到端加密：[e2ee-admission-proposal.md](e2ee-admission-proposal.md)
- 客户端信息架构与界面模式：[client-experience-proposal.md](client-experience-proposal.md)

---

## 1. 产品定位与核心原则

Orches 是 AA v3 的编排子产品，和设备工作台并列。你在 Orches 里说要做什么，它把工作派给各台设备上的 Agent：新建设备对话，或者接着已有的对话。之后它替你查看进度、汇总结果，并把需要你审批的事集中提示。另外，AA v3 还提供一个**限额文件云盘**（第 6 节）。

- **编排是主角**：Orches 的核心是通过 AA 自己的 `/mcp`（第 3 节）调度各台设备上的 Agent。随手问答、外部 MCP、轻文件处理仍然可用，但不是重点：通用助手哪家都有，管多台设备才是 AA 独有的。
- **用对话之间的连接来呈现**：不另建任务、子任务一类的模型。一个 Orches 对话「连接」若干设备对话，派出去的工作就是设备上的普通对话，在设备上照常查看、接着聊（2.3）。
- **数据各归其位**：设备对话仍然只存在设备本机，服务端不存正文；Orches 对话加密后存云端，按第 4、5 节同步。Orches 只记录连接了哪些设备对话，不复制它们的内容。
- **只在你使用时运行（产品取舍）**：Orches 跑在浏览器里（Desktop 加载的是同一套页面），页面打开时工作，关掉就停。没有常驻服务，不做后台编排或定时检查，服务端也不跑 Agent。派出去的设备对话在设备上自己往下跑（2.4）。
- **被控能力与本地 JS 执行作为实验性开关**：浏览器标签页关闭、移动端 WebView 切到后台时会被系统挂起，所以这两项默认关闭，并在界面上标注 `Experimental`（第 7 节）。

---

## 2. 交互形态

### 2.1 一级模块

- **路由**：
  - `/orches` 是 Orches 首页：居中的输入框用来新建 Orches 对话，下面是最近的 Orches 对话。
  - `/orches/<id>` 是一个 Orches 对话，整页显示，右侧栏是它连接的设备对话（2.3）。
  - 旧地址 `/assistant` 跳转到 `/orches`。
- **左侧栏**：「Orches」一行进入 Orches 首页，不再只是开关右侧栏。
- **随手入口**：在任何页面按 ⌘J 都能打开右侧的 Orches 栏（移动端是底部 Sheet），显示当前的 Orches 对话，可以「在页面中打开」。
- **现在 `/assistant` 页的三个标签拆开**：
  - 聊天移到 `/orches`；
  - 云端工作区移到云盘里已有的「Orches」文件夹；
  - 模型、加密、MCP、Tokens 移到设置里新增的「Orches」分组。

### 2.2 Orches 模式

开关在「设置 › 通用 › Orches 模式」，原名「侧栏先显示 Orches」：

- **关闭（默认，设备模式）**：首页用来新建设备对话；侧栏显示设备和最近对话，Orches 是顶部的一行。
- **打开（Orches 模式）**：
  - 首页是 Orches 首页；
  - 侧栏主列表是 Orches 对话，当前 Orches 对话下面列出它连接的设备对话；
  - 设备列表在下方，点一台设备，侧栏翻页进入这台设备的对话。

### 2.3 连接

一条连接把一个 Orches 对话和一个设备对话（`device_id` + `session_id`）连在一起。

- **自动建立**：下面两种情况会把设备对话连接到当前的 Orches 对话：
  - Orches 用 AA 工具 `create_session` 新建对话；
  - Orches 对已有对话调用 `send_message`、`answer_approval` 或 `stop_session`。

  只读的 `list_sessions`、`read_session` 不建立连接。
- **手动**：在 Orches 对话的右侧栏可以断开连接；在设备对话的「更多」菜单里可以「连接到 Orches」。
- **存储**：连接存在 Orches 对话的 `settings.connections` 里，随对话一起加密同步。每条只记 `device_id`、`session_id`、建立方式、建立时间，以及最近一次看到的标题（设备离线时用来显示）。标题、Agent 和运行状态以设备上的实时数据为准。
- **显示**：
  - **Orches 对话页的右侧栏**：每个连接一行，依次是 Agent 图标、标题、设备名和状态（运行中、等你审批、空闲、设备离线），点击进入设备对话。
  - **右侧 Orches 栏（⌘J）**：输入框上方一行，显示连接数和需要你处理的状态。
  - **设备对话页头部**：小标「Orches · <Orches 对话标题>」，点击回到那个 Orches 对话。这个对应关系由本机已同步的 Orches 对话反查，服务端不参与。
- **审批**：连接的对话里有待审批时，Orches 里显示「等你审批」，点击后到设备对话里处理。Orches 默认不替你回答审批，`answer_approval` 要先过第 3 节的确认弹窗。

### 2.4 运行边界

- Orches 只在页面打开时工作。关掉页面后，正在进行的一轮会停下，已经派出去的设备对话不受影响。
- 不做「派完就走、它自己盯着」：Orches 不会在后台轮询、提醒或继续下一步。回到 Orches 时，你看到的是连接对话的实时状态；要它汇总或继续时，再告诉它。
- 界面上要说明这一点：Orches 首页和右侧栏的空状态写明「Orches 只在这个页面打开时工作」。

### 2.5 实现顺序

1. 设置里改名为「Orches 模式」，本节定稿。
2. 一级模块：做 `/orches` 和 `/orches/<id>`，侧栏「Orches」一行改为进入首页，`/assistant` 跳转，配置并入设置。
3. 连接：自动建立和存储，Orches 对话页的右侧栏，设备对话页头部的回链。
4. Orches 模式的侧栏：当前 Orches 对话下面列出连接；设备对话里手动「连接到 Orches」。
5. Desktop 加载同一套页面，不需要单独做。iOS、Android 的重写目前暂停，恢复后按同一结构做。

---

## 3. 运行底座、Tokens Anywhere 与 MCP

- **前端运行时**：采用 `pi-agent-core` / `pi-ai`（参考 Effi 实战验证的 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`），按需懒加载运行在浏览器 **Web Worker**（桌面 Web / Desktop）或内置 **WebView**（iOS / Android，与 `v3poc/web` 单文件对话渲染包共用同一套对话 UI 组件）。
- **Tokens Anywhere 集成**：
  - 借鉴 Effi 的单账号复用策略：每个账号只在服务端保存一份加密后的 Tokens Anywhere 托管 Key（与 refresh token），跨所有浏览器与手机复用并由服务端定期自动续期，避免每个客户端重复签发一堆 Key；该 Key 仅发给本人登录会话，不发给第三方 OAuth/MCP 应用。
  - 兜底支持用户手动填写兼容 CORS 的 BYOK API Key（仅存本机）。
  - 沿用 Effi 已踩过的浏览器兼容约定：移除脚本层 `User-Agent` 头避免 Safari/Firefox CORS preflight 被拒；Anthropic Messages 固定使用显式 thinking budget，关闭 `adaptive` / `block_binding`。
- **MCP 工具接入**：
  - 支持标准 Streamable HTTP MCP；
  - 默认可一键挂载当前账号的 **AA `/mcp`**（遵守设备本机 `allow_mcp` 开关与普通模式限制，加密设备不可见），同时支持添加任意外部 HTTP MCP 服务；
  - 写操作 / 高风险工具调用前走统一确认弹窗（沿用 `beforeToolCall` 钩子）。

---

## 4. 对话级整包同步（借鉴 Effi）

助手同步不按单条消息细粒度同步，而是采用**对话级整包同步**，保持服务端极简：

- **4 个核心接口**：
  - `GET /assistant/conversations`：仅返回列表元数据（`id`、`updated_at`、`hash`、`device`、`size`、明文 `title` 或密文元数据），按更新时间倒序；
  - `GET /assistant/conversations/{id}`：获取单条完整对话（含 `messages` 与 `settings`，或整包密文）；
  - `PUT /assistant/conversations/{id}`：每完成一轮对话后整包覆盖上传；设单条体积上限（如 20 MB）与单账号保留条数上限（如 100 条），超限自动淘汰最旧对话；
  - `DELETE /assistant/conversations/{id}`：删除云端对话。
- **跨端通知与客户端冲突裁决**：
  - 服务端不做新旧裁决，只原样保存并通过 `server-v3` 现有的 Redis Pub/Sub 实时流向该用户的其他在线端广播变更事件 `{id, hash, title/meta, device, deleted}`；
  - 客户端本地为每条对话记录两份内容指纹：本地当前 `hash` 与上次和云端达成一致的 `synced`（当前打开的标签页另记 `agreed`）：
    - 仅云端变化 → 静默拉取覆盖（若正打开且未在运行，直接更新视图）；
    - 本机与云端同时变化且当前正打开 → 弹出冲突确认（保留本机另存新 id 或采用云端）；
    - 本机与云端同时变化但未打开 → 自动保留两份（本机另存为 `（本机）` 新 id 上传，云端保留原 id）。

---

## 5. 任意密码多设备端侧加密（对话级 + 云端文件）

为实现「用户自定密码、好记、**多设备都可解密**、服务端无法解密以防范恶意服务端」，助手加密采用**账号级云端密钥信封（KEK + DEK）+ 对话级整包对称加密**：

1. **允许任意密码**：不强制最小长度或复杂度限制，允许用户自由设置 PIN 或任意口令，密码强度由用户自行把握；界面仅做温和的强度说明（提示过短密码存在离线穷举风险）。
2. **多设备共享同一把 DEK**：
   - 首次开启加密时，客户端本地生成随机 256-bit **DEK** 与随机 `salt`；
   - 用用户输入的密码 + `salt` 经版本化 KDF（如 `Argon2id` 或四端原生零依赖的 `PBKDF2-SHA256`，算法与参数随信封存储）派生 **KEK**；
   - 用 **KEK** 以 `AES-256-GCM` 包裹 **DEK** 得到 `wrapped_dek`，向云端保存 `{kdf, kdf_params, salt, wrapped_dek, key_version}`（服务端永远接触不到密码和明文 `DEK`）；
   - 任意新设备登录同一账号后，拉取该信封，输入同一个密码即可派生出相同 **KEK** 并解出同一把 **DEK**（输错密码会因 GCM 认证标签直接失败），解出后缓存在本机安全存储（iOS Keychain / Android Keystore / Desktop 钥匙串 / Web IndexedDB），之后所有端均可互相加解密。
3. **整包加密与元数据隐藏**：
   - 开启加密后，**整条对话（`title`、`settings`、`messages`）整体序列化后用 `DEK` 做一次 `AES-256-GCM` 加密**上传（每次覆盖使用独立随机 96-bit Nonce，AAD 绑定 `user_id + conversation_id` 防服务端调包）；
   - 列表视图所需的标题、摘要等同样放入密文元数据字段，服务端只能看到 `conversation_id`、`updated_at`、`hash`、`size` 和不透明密文。
4. **改密码与忘密码**：
   - **改密码**：任意已解锁端用新密码 + 新 `salt` 重新包裹**同一把 DEK** 并递增 `key_version`（乐观锁防并发覆盖），无需重加密任何历史对话与云端文件；
   - **忘密码**：服务端无后门无法找回，只能由用户确认清空旧密文并重置新 `DEK`。
5. **Web 信任分级**：与主干一致，独立分发客户端（iOS / Android / Desktop）为绿锁，Web 浏览器为灰锁（受限于页面 JS 由服务端下发）。

---

## 6. 限额云盘与大文件中转

针对 MeshCall RPC 隧道不适合传输大文件（以及助手需要跨端持久化虚拟文件系统）的场景，引入一套**轻量限额云盘**（PG 文件元数据 + S3 兼容对象存储）：

1. **RPC 直传阈值收紧与大文件分流**：
   - 设定严格的 RPC 直传文件大小上限（建议默认 **5 MB～8 MB**，远小于 20 MB）；
   - 小于阈值的文件/图片可直接随 RPC 或会话传输；**超过阈值的文件禁止走 RPC**，强制先上传至限额云盘（客户端/Connector 通过控制面申请 S3 预签名上传 URL 直传，流量不经控制面），再通过 RPC 只传递文件引用与下载凭证，由对端直连对象存储下载。
2. **默认 7 天过期 + 账号级可调配额**：
   - 云盘文件默认过期时间为 **7 天**（`expires_at = created_at + ttl`），到期后由后台定期任务与对象存储生命周期规则双重清理；
   - **账号级配置**：支持按账号调整**默认过期时间（TTL）**、**单文件大小上限**与**账号总存储配额**，按需控制存储成本与使用范围。
3. **助手云端虚拟文件系统（Cloud VFS）**：
   - 客户端本地使用 **OPFS / IndexedDB** 作为助手工作区的热缓存，供 Pi 文件工具（`read` / `write` / `edit` / `ls` / `grep`）低延迟读写；
   - 工作区文件按内容哈希与云盘异步同步，使跨设备续聊时助手看到一致的轻量工作区文件（受账号云盘配额与过期策略约束）。
4. **云盘端侧加密**：
   - **助手工作区文件**：开启助手加密时，客户端在上传 S3 前用账号 `DEK` 做 `AES-256-GCM` 加密（含原始文件名元数据），下载后本机解密，多设备通用；
   - **加密设备大文件中转**：上传方生成单次随机 256-bit 文件密钥先加密再上传 S3，只把 `{file_id, file_key, sha256}` 经 **E2EE 加密隧道**发给接收端，对象存储与控制面均无法读取内容。

### 6.1 云盘是一个文件系统：路径与文件夹

状态：已实现（`server-v3` 迁移 `v3_3`，Web 云盘页 `/drive`）。助手已定名为 **Orches**，它的云端工作区在云盘里是 `/Orches` 文件夹（接口里的用途仍叫 `assistant_vfs`）。

- **路径**：每个云盘文件都有规范化的绝对路径，例如 `/报告/2026/q3.pdf`；同一账号下，未删除的文件路径唯一，路径区分大小写。规范化：`\` 视为 `/`，连续和末尾的 `/` 合并，缺少开头的 `/` 时补上，每一级名称做 Unicode NFC 规范化并去掉首尾空白；不允许 `.`、`..` 和控制字符，每级名称最长 255 个字符，整条路径最长 1024 个字符、最多 32 级。
- **文件夹**：文件夹是显式记录（`drive_folders`），空文件夹也存在；根目录 `/` 是隐含的，没有记录。文件放进不存在的文件夹时，服务端自动建好所有上级文件夹（`mkdir -p`）。同一个路径不能既是文件又是文件夹，文件下面也不能再放东西。
- **两个由服务端创建的文件夹**，存储名固定用英文，客户端按 `system` 字段显示名称：

  | 存储路径 | `system` | Web 显示 | 内容 |
  | --- | --- | --- | --- |
  | `/Transfers` | `transfers` | 临时中转 / Transfers | 发给工作设备的大附件（`purpose: transfer`）。没有指定位置的上传都放这里，重名时在扩展名前加 ` (1)`、` (2)`…（`q3.pdf` → `q3 (1).pdf`，`a.tar.gz` → `a (1).tar.gz`） |
  | `/Orches` | `orches` | Orches | Orches 的云端工作区（`purpose: assistant_vfs`），文件路径是 `/Orches/<vfs_path>` |

  这两个文件夹不能重命名或移动，可以删除（连同里面的文件；下次有文件进来时自动重建）。`/Transfers` 里的文件可以像普通文件一样改名、移走。
- **`/Orches` 只由 Orches 自己的同步写入**：云盘接口在这里只能列出、下载、复制引用和删除（文件和文件夹都可以删），不能新建文件夹、上传、重命名或移动，也不能把文件移进来或移出去（409 `drive_managed_path`）。原因是 Orches 的读写以 `vfs_path` 为准：加密文件把 `vfs_path` 绑进了 AES-GCM 的附加数据，改名后就解不开；同步也按 `vfs_path` 覆盖旧版本。所以 `vfs_path` 原样保留，云盘路径只是它的镜像。`vfs_path` 不是合法的云盘路径（例如含控制字符、超过 32 级），或镜像路径被占（例如 `workspace` 既是文件又是另一个文件的上级目录）时，这个文件放在 `/Orches/<文件 id>`，Orches 照常按 `vfs_path` 读写。
- **加密文件不因路径泄露名称**：`ephemeral_key`（加密设备的大附件）和不带 `vfs_path` 的 `account_dek` 文件，服务端本来就不知道名称，它们的云盘名称就是文件 id（例如 `/Transfers/drv_3f…`）。加密上传不能用 `path` 指定文件名，只能用 `folder` 指定文件夹（422 `drive_encrypted_name`）；加密文件可以移到别的文件夹，但不能改名。带 `vfs_path` 的 `account_dek` 文件，路径本来就以明文存在服务端，镜像成云盘路径不会多泄露信息。
- **保留时间不变**：每个文件仍有自己的到期时间（默认 7 天，管理员可按账号调整），重命名、移动不改变到期时间，列表里每个文件都带 `expires_at`；到期后文件从列表和路径里消失，由清理任务删除对象。文件夹不会过期，文件到期后留下的空文件夹继续存在。过期但还没清理的文件不占路径，新文件可以直接放到同一个路径。网页上传的文件同样记为 `transfer`，保留规则相同。
- **删除**：删除文件或文件夹（递归）后，文件立刻从列表、路径和配额里消失（状态变为 `deleted`）；对象存储里的对象当场尽量删除，存储暂时不可用或一次删得太多时，剩下的由已有的后台清理任务接着删。删除文件夹时，正在上传到其中的文件也一并取消。
- **数据库迁移 `v3_3`** 给已有文件回填路径：`transfer` 文件放进 `/Transfers/<filename>`，重名的按完成时间排序，最早的保留原名、后面的加后缀（已过期但还没被清理的文件排在最后，不会让仍有效的文件被加上后缀）；没有明文名称的（`ephemeral_key`、上传时没给 `filename`）用文件 id。`assistant_vfs` 文件放进 `/Orches/<vfs_path>`，没有 `vfs_path` 或路径不合法、被占的放进 `/Orches/<文件 id>`；同一个 `vfs_path` 还留着多个就绪版本时（旧版本的对象删除失败过），最新的保留路径，旧的标记为删除，交给清理任务。明文 `transfer` 文件的 `filename` 同步改成它在云盘里的名字。回退到 `v3_2` 时删掉路径列和文件夹表，已标记删除的文件改为过期的上传占位，由 `v3_2` 的清理任务删除。

### 6.2 云盘接口

用户 Bearer Token 和 Connector 设备凭据都可以调用，账号之间互相隔离。

| 接口 | 说明 |
| --- | --- |
| `GET /drive/entries?path=/报告&limit=200&offset=0` | 列出一个文件夹的直接子项：全部子文件夹，以及未过期的文件（分页，`limit` 最大 1000），每个文件带 `expires_at`。返回 `{ path, ref, folder, folders, files, total_files, quota }`，根目录的 `folder` 为 `null`。文件夹不存在时 404 `drive_path_not_found`，路径是文件时 422 `drive_not_a_folder` |
| `POST /drive/folders` `{ path, exist_ok? }` | 新建文件夹（自动建上级），201；已存在时 409 `drive_path_conflict`，带 `exist_ok: true` 时返回已有的文件夹（200） |
| `PATCH /drive/files/{file_id}` `{ path }` | 重命名或移动一个文件，`path` 是新的完整路径；到期时间、内容和 id 不变。目标被占时 409 `drive_path_conflict` |
| `PATCH /drive/folders/{folder_id}` `{ path }` | 重命名或移动文件夹，整棵子树（子文件夹、文件、正在上传进来的文件）一起改路径；返回 `{ folder, moved_folders, moved_files }`。移到自己里面 422 `drive_move_into_self` |
| `DELETE /drive/folders/{folder_id}` | 递归删除，返回 `{ ok, deleted_folders, deleted_files }` |
| `GET /drive/resolve?path=…` 或 `?ref=drive:/…` | 把路径或引用解析成文件夹或文件，返回 `{ kind: "file" \| "folder", path, ref, folder, file }`；什么都没有时 404 `drive_path_not_found` |
| `POST /drive/uploads` 新增字段 | `path`：完整目标路径，只限明文上传；`folder`：只指定文件夹，文件名取 `filename`，没有时取文件 id；`on_conflict`：目标被占时 `rename`（默认，加 ` (n)` 后缀）、`fail`（409）或 `replace`（替换原文件，但不会替换文件夹）。都不给时放进 `/Transfers/`。`assistant_vfs` 上传不接受这三个字段，路径总是 `/Orches/<vfs_path>`，并替换同一 `vfs_path` 的旧版本 |
| `POST /drive/files/{file_id}/complete` 新增字段 | `on_conflict`：路径在上传开始时检查一次、完成时最终确定。完成时目标被占返回 409，上传占位在上传链接有效期内保留，可以换一种策略再次完成 |

- 文件视图新增 `path`、`name`、`parent_path`、`ref`（规范引用）和 `managed`（是否在 `/Orches` 下）；文件夹视图是 `{ id, path, name, parent_path, ref, system, managed, created_at, updated_at }`。
- 原有接口和字段不变：`GET /drive/files`（含 `purpose`、`vfs_prefix` 过滤）、按 id 查询 / 下载 / 删除、`vfs_path`。附件中转、Orches 同步和 Connector 的 `fetch_drive_file` 不改也能继续工作。明文 `transfer` 文件的 `filename` 跟随它在云盘里的名字（包括重名后缀和改名），下载时的文件名和列表一致。
- 错误统一是 `{ code, detail }`：`drive_invalid_path` / `drive_invalid_ref`（422，路径或引用不合法），`drive_path_conflict`（409，目标已有文件或文件夹），`drive_parent_is_file`（409，某一级上级是文件），`drive_managed_path`（409，`/Orches` 只由 Orches 写入），`drive_system_folder`（409，`/Transfers`、`/Orches` 不能改名或移动），`drive_move_into_self`、`drive_encrypted_name`、`drive_not_a_folder`（422），`drive_path_not_found`、`drive_folder_not_found`（404）。

### 6.3 文本引用 `drive:/…`

云盘里的文件和文件夹用 `drive:` 加绝对路径引用，例如 `drive:/报告/2026/q3.pdf`；文件夹是 `drive:/报告/2026`，根目录是 `drive:/`。

- **规范形式**由服务端生成，就是文件和文件夹视图里的 `ref`，客户端「复制引用」直接用它。名称保持可读，中文等非 ASCII 字母原样保留；只有下面这些字符按 UTF-8 百分号编码：空白（含全角空格）、控制和格式字符（含双向文本控制符），`%`，保留给以后用的 `?` 和 `#`，以及在文字、Markdown 链接和表格里容易截断引用的 `(`、`)`、`[`、`]`、`<`、`>`、`"`、`'`、`|`、反引号和全角的 `。`、`，`、`、`、`；`、`：`、`！`、`？`（中文句读后面直接接着正文，读到这里就该结束引用）。全角括号和引号不编码，`报告（终版）.pdf` 的引用就是 `drive:/报告（终版）.pdf`。例如 `/Transfers/q3 (1).pdf` 的引用是 `drive:/Transfers/q3%20%281%29.pdf`。
- **解析**（`aa_control/core/drive.py` 的 `parse_drive_ref`，`GET /drive/resolve?ref=…`）：`drive:` 不区分大小写；百分号编码会被解码，所以手写的 `drive:/报告/q3 final.pdf` 也能解析，不构成转义的单个 `%` 按字面处理；解码后的路径按 6.1 的规则规范化。`drive://…` 留给以后（例如跨账号引用），未编码的 `?`、`#` 留给以后的参数和片段，现在都返回 422 `drive_invalid_ref`。
- **引用的是路径，不是文件 id**：文件改名或移动后，旧引用解析不到（404）；同一路径换成新文件后，引用指向新文件。
- **从文字里提取**：引用在空白或上面那些需要编码的字符处结束（`%` 除外，它开始一个转义）；紧跟在末尾的 `.`、`,`、`;`、`:`、`!` 当作标点；全角右括号或右引号（`）`、`】`、`」`、`』`、`》`、`”`）在引用里没有对应的左半边时结束引用，所以 `（见 drive:/报告/q3.pdf）`、`“drive:/a.md”和……` 都能取出引用，`drive:/报告（终版）.pdf` 保持完整（`’` 不算，文件名里常把它当撇号）。名称以这些字符结尾的文件，可以用尖括号括起来写：`<drive:/报告/终版.>`（`<`、`>` 在引用内部总是编码的，所以不会混淆）。紧跟在字母、数字或 `/`、`:` 等路径字符后面的 `drive:/` 不算引用（例如 `https://host/drive:/x`），汉字后面的算。
- **在回复里显示**（Web 已实现）：回复正文里的引用、以引用为目标的链接（`[季报](drive:/…)`、`<drive:/…>`）和整段就是一个引用的行内代码，都显示成链接，Orches 的回复也一样。点开后进入云盘页 `/drive?ref=…`：引用指向文件夹时打开这个文件夹，指向文件时打开它所在的文件夹并选中这个文件；解析不到时提示，回到根目录。原生 App 经桥接收到 `open_link`，`url` 就是这个引用，见 [mobile-bridge.md](mobile-bridge.md)。
- **以后的用法**：消息正文和附件里可以直接写 `drive:/…`，客户端或 Connector 用 `GET /drive/resolve?ref=…` 换成文件，再走已有的下载链接或 `fetch_drive_file` 流程把文件交给 Agent。

---

## 7. 实验性能力（默认关闭）

- **实验性被控模式**：允许用户在浏览器或客户端设置中手动开启，将本机助手临时向 MeshCall Router 注册为一个在线实例（复用 `aa.v3.Sessions` 契约），供其他端查看或远程交互；关闭页面或手机切后台即离线。
- **实验性本地 JS 执行**：结合虚拟文件系统提供脚本工具以扩展助手能力（数据处理、格式转换、计算等）。**安全隔离红线**：绝不在与主应用同源的上下文（包括同源 Worker）中直接执行生成代码，必须隔离在 **QuickJS-WASM（Worker 内，零 DOM / 零 IndexedDB / 零直连网络，带内存与超时上限）** 或 **无 `allow-same-origin` 的 `<iframe sandbox="allow-scripts">`** 中，仅通过受控桥访问当前助手工作区 VFS，彻底隔绝存放在主域 IndexedDB 中的登录凭据与设备 E2EE 私钥。

实现现状（T519）：

- 本地 JS 执行已在 `web-v3/lib/assistant/js-sandbox/` 实现，采用 QuickJS-WASM 方案：每次运行新建一个专用 Worker，Worker 只承载解释器，生成代码以字符串交给 QuickJS 解释执行；加载完成后 Worker 还会移除自身的 `fetch`、`indexedDB`、`WebSocket`、`importScripts` 等入口作为纵深防御。路径与大小校验全部在页面侧的工作区桥完成。
- 被控模式的控制面部分用现有接口即可完成（`POST /devices/register` → `POST /devices/router-token` 拿到可注册 `aa.v3.Sessions` 且绑定 `instance_id = device_id` 的 Router Token → `aa.v3.Control/presence`），但 `meshcall/web` 0.4 只有客户端角色（WebSocket `hello` 固定 `role: "client"`，没有 `mount` / `startServing`、隧道宿主和 Noise 应答方），浏览器无法在 Router 上提供服务。客户端实现放在 `BrowserServiceHost` 接口之后，开关暂时禁用。另外两个缺口：`DevicePlatform` 没有 `web`（暂以 `linux` 注册），也没有随在线状态自动回收的临时设备（每个浏览器会长期占用一个 `max_devices` 名额，直到在其他端删除）。
