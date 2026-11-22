# AA v3 扩展设计：随身助手（Pi Lite）与限额大文件云盘

状态：方向已确认（独立扩展模块，不阻塞 G43 主干落地；`web-v3/` 导航与存储骨架提前预留兼容）。

相关主干设计：
- 总体架构（控制面、隧道、聚合 RPC 与 MCP）：[architecture-proposal.md](architecture-proposal.md)
- 加密设备准入与端到端加密：[e2ee-admission-proposal.md](e2ee-admission-proposal.md)

---

## 1. 产品定位与核心原则

AA v3 在工作设备工作台之外，提供一个**类 Effi 形态的轻量化随身助手（暂名 Pi Lite / AA 助手）**，以及一个**限额文件云盘**，两者作为独立扩展能力存在：

- **与工作设备严格解耦**：工作设备（Connector）会话仍然坚持「设备本机为唯一数据源、服务端不存对话正文」；随身助手定位为跨端随手可用的快速助手，由云端持久化保存对话快照、必要元数据与轻量文件工作区。
- **以轻助手 + MCP 为主角**：不是拿浏览器替代远程重型 Coding Agent，而是主打随手问答、快速调用 MCP 工具（包括一键接入 **AA 自己的 `/mcp`**，变身跨设备总控助手，以及接入外部 Streamable HTTP MCP）和轻文件处理。
- **被控能力与本地 JS 执行作为实验性开关**：受限于浏览器标签页关闭或移动端 WebView 切后台会被系统挂起，此类能力默认关闭并在界面标注 `Experimental`。

---

## 2. 交互形态与「助手为主角」开关

随身助手作为一等公民融入客户端导航壳（Web / Desktop / iOS / Android），并提供一个**视图切换开关**：

1. **随手交互入口**：在任意页面都能打开**侧边抽屉（Web / Desktop）**或 **Sheet（iOS / Android）**和助手快速对话。
2. **助手二级页面**：从左侧侧边栏进入助手独立页面，管理助手的历史对话列表、继续历史会话、查看云端工作区文件与 MCP/Tokens 配置。
3. **「助手为主角」视图开关**：
   - **关闭（默认 · 设备优先）**：左侧栏直接展示设备与设备下的会话列表，助手作为固定入口与随手抽屉/Sheet。
   - **开启（助手优先 · 类 Effi 模式）**：主界面默认以助手对话为主角，左侧栏主列表直接是助手的对话历史；在左侧栏选中某台工作设备后，**侧栏翻页进入该设备的子页面**才看到该设备下的会话。

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

---

## 7. 实验性能力（默认关闭）

- **实验性被控模式**：允许用户在浏览器或客户端设置中手动开启，将本机助手临时向 MeshCall Router 注册为一个在线实例（复用 `aa.v3.Sessions` 契约），供其他端查看或远程交互；关闭页面或手机切后台即离线。
- **实验性本地 JS 执行**：结合虚拟文件系统提供脚本工具以扩展助手能力（数据处理、格式转换、计算等）。**安全隔离红线**：绝不在与主应用同源的上下文（包括同源 Worker）中直接执行生成代码，必须隔离在 **QuickJS-WASM（Worker 内，零 DOM / 零 IndexedDB / 零直连网络，带内存与超时上限）** 或 **无 `allow-same-origin` 的 `<iframe sandbox="allow-scripts">`** 中，仅通过受控桥访问当前助手工作区 VFS，彻底隔绝存放在主域 IndexedDB 中的登录凭据与设备 E2EE 私钥。

实现现状（T519）：

- 本地 JS 执行已在 `web-v3/lib/assistant/js-sandbox/` 实现，采用 QuickJS-WASM 方案：每次运行新建一个专用 Worker，Worker 只承载解释器，生成代码以字符串交给 QuickJS 解释执行；加载完成后 Worker 还会移除自身的 `fetch`、`indexedDB`、`WebSocket`、`importScripts` 等入口作为纵深防御。路径与大小校验全部在页面侧的工作区桥完成。
- 被控模式的控制面部分用现有接口即可完成（`POST /devices/register` → `POST /devices/router-token` 拿到可注册 `aa.v3.Sessions` 且绑定 `instance_id = device_id` 的 Router Token → `aa.v3.Control/presence`），但 `meshcall/web` 0.4 只有客户端角色（WebSocket `hello` 固定 `role: "client"`，没有 `mount` / `startServing`、隧道宿主和 Noise 应答方），浏览器无法在 Router 上提供服务。客户端实现放在 `BrowserServiceHost` 接口之后，开关暂时禁用。另外两个缺口：`DevicePlatform` 没有 `web`（暂以 `linux` 注册），也没有随在线状态自动回收的临时设备（每个浏览器会长期占用一个 `max_devices` 名额，直到在其他端删除）。
