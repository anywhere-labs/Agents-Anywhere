# Agents Anywhere iOS 客户端实现计划

## 目标

实现一个原生 iOS 客户端，用来在移动设备上快速控制 Agents Anywhere：
查看 agent 状态、处理审批、继续出错的 session、发送简短指令，以及管理已连接设备。

整体视觉以黑白为主题。颜色只用于语义状态，例如在线、等待审批、错误、危险操作，以及必要的 runtime 标识。

## 平台方向

- 优先使用 SwiftUI。
- 如果产品方向允许，最低系统目标可以直接定为 iOS 26，以便充分使用新的系统视觉和 Liquid Glass。
- 如果后续需要支持更老系统，代码结构需要保留可扩展空间，用 `@available` 做兼容分支。
- 尽量使用会自动获得 Liquid Glass 外观的系统组件：
  `NavigationStack`、`NavigationSplitView`、`TabView`、`List`、`Form`、
  `ToolbarItem`、`Sheet`、`Alert`、`confirmationDialog`、`Menu`、`Picker`、
  `Toggle`、`Button`、`.searchable`。
- 避免大量自定义卡片、背景和面板。优先让内容自然滚动到系统导航栏、工具栏和 tab bar 下方。
- 只在少数高频控制区域使用自定义玻璃效果，例如 session 底部输入栏，或者审批操作区。

## 功能范围

### MVP / Phase 1 目标

第一阶段不是只读客户端，而是尽可能覆盖 Web 端已有功能，只有 Terminal
能力暂时不做。iOS 客户端应该可以作为一个完整移动控制端使用：登录、查看、
管理设备、浏览 session、处理审批、接管并继续任务、调整 runtime 配置、查看
workspace 文件，以及完成常见账号和设置操作。

1. 服务器连接与登录
   - 第一个界面是服务配置入口，不直接进入 Sessions。
   - 首屏提供两个主操作：Enter Server、QR Code Login。
   - Enter Server：进入服务器地址输入页，检查服务器可用性，再输入账号密码登录。
   - QR Code Login：扫描 Web 端个人设置里生成的一次性登录二维码。
   - QR payload 包含服务器地址、登录 id 和一次性凭据；手机解析后展示用户名，
     让用户确认是否登录。
   - 用户确认后，用一次性凭据向对应 server 换取长期 token。
   - token 存储在 Keychain。
   - 支持退出登录和切换服务器。

2. Sessions
   - 按最近活动列出 active sessions。
   - 支持按标题、workspace、runtime、设备搜索。
   - 支持按状态筛选：active、等待审批、error、archived。
   - 打开 session 详情。
   - 打开后自动标记为已读。
   - 支持 pin / unpin。
   - 支持 archive / unarchive。
   - 支持 bulk read / bulk archive 的移动端等价操作。
   - 支持创建新 session，如果当前后端和 connector 能提供足够能力。

3. Session 详情
   - 展示 user、assistant、tool、system/error 等 timeline items。
   - 底部 composer 用于发送指令。
   - 支持 takeover 开关。
   - 支持 interrupt 当前运行。
   - 支持处理 approvals。
   - 对 error session 继续发送时弹确认框。
   - 支持 sync 当前 session。
   - 支持 runtime settings：model、effort、permission mode、Claude run mode 等。
   - 支持从 Photos / Files 发送附件。
   - 支持查看附件和图片预览。
   - 支持打开关联 workspace 文件浏览。
   - 暂不实现 Terminal 面板。

4. Devices
   - 列出 connectors，显示 online/offline 状态。
   - 展示每个 device 上已接入的 runtimes。
   - 展示 device 下的 workspaces 和 sessions。
   - 支持添加 device：创建 connector credential，并展示要在目标机器运行的命令。
   - 支持重命名 device。
   - 支持刷新 runtime capabilities scan。
   - 支持 runtime attach / detach 或移动端等价操作。
   - 支持 device preferences。
   - 支持 revoke/remove connector。
   - iOS 不运行 connector 本身，只作为控制端。

5. Notifications
   - 第一阶段先做应用内 Approval Center。
   - 如果后端 push token 注册来得及，可以在第一阶段加入 push notifications；
     否则放到紧随其后的补充阶段。

6. Settings
   - 账号与退出登录。
   - Server URL。
   - 外观：system / light / dark，但整体仍保持黑白视觉。
   - 可选 Face ID / 设备密码保护。
   - 账号信息、头像、密码修改。
   - Team / admin 管理能力，如果当前用户有权限。
   - Service / runtime provider 配置能力，如果 Web 端对应功能已稳定。

7. Workspace / Files
   - 浏览 connector workspace 文件。
   - 查看文本文件。
   - 预览图片。
   - 分享或复制文件内容。
   - 写入、删除、重命名等高风险文件操作需要单独确认；如果移动端风险过高，
     第一阶段可以先做只读文件浏览。

## 导航结构

### iPhone

使用底部 `TabView`：

- Sessions
- Devices
- Approvals
- Settings

Tab bar 保持极简黑白。等待审批和错误数量可以用 badge 标出来。

### iPad

使用 `NavigationSplitView`：

- Sidebar：Sessions、Devices、Approvals、Settings。
- Content：当前列表。
- Detail：选中的 session 或 device。

iPad 应该更像一个控制台，而不是把 iPhone 页面简单拉宽。

## 界面设计

### 1. 服务配置入口

用途：作为未登录状态下的第一个界面，让用户选择手动输入 server，或扫描
Web 端生成的一次性登录二维码。

布局：

- App 图标和名称。
- 两个主要按钮：
  - Enter Server
  - QR Code Login
- 如果有历史记录，展示 recent servers。

组件：

- `NavigationStack`
- `Button`
- `Alert`
- `Sheet`，用于二维码扫描入口

交互：

- 点击 Enter Server 进入服务器地址输入页。
- 点击 QR Code Login 打开二维码扫描流程。
- 如果存在已保存且仍有效的长期 token，启动时可直接进入主界面。

设计：

- 根据系统外观使用白底或黑底。
- 不使用装饰性渐变。
- 使用系统表单间距。

### 2. Enter Server 登录流程

用途：手动连接 server，并用账号密码登录。

布局：

- Server URL 输入框。
- 检查服务器按钮或自动检查状态。
- User ID 输入框。
- Password 输入框。
- Sign in 按钮。

组件：

- `Form`
- `TextField`
- `SecureField`
- `Button`
- `ProgressView`
- `Alert`

交互：

- 用户输入 server URL 后，先请求 server config / health endpoint，确认服务可用。
- 服务不可用时停留在 server 输入页，并显示错误。
- 服务可用后进入账号密码输入。
- 登录成功后 token 写入 Keychain。
- 登录失败显示表单内错误。

### 3. QR Code Login 流程

用途：从 Web 端个人设置生成的一次性登录二维码完成移动端登录。

二维码来源：

- Web 端个人设置里生成一次性登录二维码。
- 二维码只短时间有效，只能使用一次。

QR payload：

- server 地址。
- login id。
- 一次性凭据。
- 可选用户名或展示名。如果二维码本身不包含用户名，移动端应先向 server 查询
  login 状态，再展示将要登录的账号。

流程：

- 用户在首屏点击 QR Code Login。
- 手机打开二维码扫描。
- 扫描后解析 JSON，拿到 server 地址、login id 和一次性凭据。
- iOS 连接对应 server，校验这次登录请求。
- 界面展示用户名，提示用户是否登录该账号。
- 用户确认后，用一次性凭据向 server 换取长期 token。
- 长期 token 存入 Keychain。
- 登录完成后进入主界面。

组件：

- Camera scanner view。
- `Sheet`
- `confirmationDialog` 或确认页。
- `ProgressView`
- `Alert`

错误处理：

- JSON 格式错误。
- server 不可达。
- 二维码过期。
- 二维码已使用。
- 用户取消确认。

### 4. 首次设备 Onboarding

用途：和 Web 端 onboarding 行为保持一致。

触发条件：

- 登录后 connector 数量为 0。
- 当前 iOS 设备上的当前 server + user 没有完成过 onboarding。

布局：

- 原生确认弹窗：
  “You don't have a device yet. Add one?”
- 主按钮：Add device。
- 次按钮：Not now。

组件：

- `confirmationDialog`，如果文案较多则使用 `.sheet`。

行为：

- onboarded 标志按 server + user 存在本地。
- 如果登录后发现已有 connector，立即标记 onboarded。
- 点击 Add device 进入添加设备流程。
- 点击 Not now 后也标记为已处理，避免每次启动都弹。

### 5. Sessions 列表

用途：快速判断当前哪些任务需要关注。

布局：

- 顶部搜索。
- 顶部横向 filter chips：agents、devices、workspaces，必要时增加 status。
- session rows 展示：
  - 标题
  - runtime
  - device
  - workspace
  - status badge
  - unread indicator
  - 最近活动时间

组件：

- `List`
- `.searchable`
- filter chips 使用 `Button` + capsule 样式，视觉上保持系统轻量感。
- 点击 filter chip 后，从底部上滑原生 `.sheet` 选择选项。
- sheet 内使用 `NavigationStack` + `List` / `Picker` / `Toggle`，支持清除筛选。
- `Picker`
- `ToolbarItem`
- `NavigationLink`
- pull to refresh

交互：

- 点击搜索图标进入搜索态，保持列表上下文。
- 点击 agent/device/workspace chip 从底部上滑筛选选项卡。
- 选中筛选后 chip 文案更新为当前值，例如 `Claude Code`、`MBP · home`。
- 多选筛选项使用 checkmark list；单选筛选项使用 picker/list selection。
- sheet 支持 Done / Clear，向下拖拽关闭时保留当前选择。
- 左右滑动：pin、archive、mark read。
- 点击进入详情。
- 长按打开 quick actions。

设计：

- 列表要紧凑但可读。
- 尽量使用 SF Symbols 表达 runtime 和状态。
- 不做大卡片堆叠，session 就是系统列表行。
- 可以参考当前 demo 的主界面方向：居中标题、左侧搜索、右侧账号头像，筛选 chips 位于标题下方。
- section header 使用轻量大写文字，例如 Pinned、Recents，并支持折叠。

### 6. Session 详情

用途：查看并控制一个运行中的 agent session。

布局：

- 顶部区域：标题、device、runtime、workspace、状态。
- 中间为可滚动 timeline。
- 如果有 pending approval，在 composer 上方突出显示。
- 底部固定 composer。

组件：

- `ScrollView` 或 `List`，具体取决于 timeline 性能。
- `ToolbarItem`：sync、takeover、更多菜单。
- `Menu`：runtime/session 操作。
- `TextEditor` 或多行输入框。
- 附件使用 `PhotosPicker` / document picker。
- error session 继续发送使用 `confirmationDialog`。

交互：

- 发送消息。
- session 为 `error` 时，发送前弹确认。
- session 为 `running` 时，展示 interrupt。
- session 为 `waiting_approval` 时，优先展示审批操作。
- takeover 决定 composer 是否可用。
- 支持 pull to refresh 和实时更新。

设计：

- Timeline 是主内容，不要被过多面板打断。
- Composer 可以在 iOS 26 使用轻微原生玻璃背景。
- Toolbar 保持黑白，只在错误和危险操作上使用语义色。

### 7. Approval Center

用途：集中处理所有阻塞任务。

布局：

- pending approvals 列表，按 session/device 分组。
- 每一行展示 tool/command 摘要、cwd/workspace、风险提示。
- 详情 sheet 展示完整审批上下文。

组件：

- `List`
- `NavigationLink`
- `Sheet`
- `Button`
- `confirmationDialog`

交互：

- Approve。
- Deny。
- 打开关联 session。

设计：

- Pending approvals 是最高优先级信息。
- Approve / Deny 按钮使用原生 action 区域，不做复杂自定义。

### 8. Devices 列表

用途：查看当前可用机器。

布局：

- 搜索。
- device row 展示 online/offline、last seen、runtimes、workspace 数量。
- toolbar 右侧 Add device。

组件：

- `List`
- `.searchable`
- `ToolbarItem`
- `NavigationLink`
- `Menu`

交互：

- 点击 device 进入详情。
- 对 offline device 可提供 remove/revoke swipe action。
- Add device 进入配对流程。

### 9. Device 详情

用途：管理一个 connector。

布局：

- Header：device name、status、connector ID。
- Runtime capabilities section。
- Workspaces section。
- Sessions section。
- Danger area：revoke/remove。

组件：

- `Form` 或带 section 的 `List`。
- `Button`
- `Menu`
- `confirmationDialog`

交互：

- 重命名 device。
- 刷新 runtime scan。
- 打开 workspace 下的 sessions。
- revoke connector。

### 10. Add Device

用途：创建 connector credentials，并指导用户在目标机器启动 connector。

布局：

- Device name 输入框。
- 生成的 connector 命令。
- Copy 按钮。
- Share 按钮。
- 可选二维码，用于把命令转移到另一台机器。

组件：

- `Form`
- `TextField`
- `Button`
- `ShareLink`
- `Sheet`

设计：

- 命令块用等宽字体，保证可读。
- 这个流程要务实：iPhone 负责生成和传递命令，不负责运行 connector。

### 11. Settings

用途：账号和 App 设置。

Sections：

- Account。
- Server。
- Appearance。
- Security。
- Notifications。
- About。

组件：

- `Form`
- `Picker`
- `Toggle`
- `Button`

## 数据与 API 分层

建议模块：

- `APIClient`
  - 使用 `URLSession` 封装 REST 请求。
  - 使用 async/await。
  - 请求和响应 model 对齐 `web/src/lib/api.ts`。

- `AuthStore`
  - Keychain token 存储。
  - 当前 server URL。
  - 当前用户信息。

- `DashboardStore`
  - connector 列表。
  - session 列表。
  - dashboard event stream。

- `SessionStore`
  - session state。
  - timeline items。
  - approvals。
  - send / interrupt / takeover / approval actions。

- `OnboardingStore`
  - 按 server + user 存储本地 onboarded 标志。

实时更新：

- 优先复用后端已有 SSE endpoint，如果 `URLSession.bytes` 表现稳定。
- 保留 polling fallback，用于网络不稳定、后台切前台、SSE 断开等情况。

## 实现阶段

### Phase 1：Web 功能移动端等价覆盖，排除 Terminal

- 清理 Xcode 项目结构。
- 服务配置首屏：Enter Server、QR Code Login 两个入口。
- Enter Server：server URL 输入、服务可用性检查、账号密码登录。
- QR Code Login：扫描一次性 JSON payload、展示用户名确认、换取长期 token。
- Keychain token 持久化。
- 首次设备 onboarding。
- Sessions tab：列表、搜索、筛选、pin、archive、mark read、bulk 操作。
- Session detail：timeline、composer、takeover、interrupt、sync、error send confirm。
- Approvals：集中列表、approve、deny、打开关联 session。
- Attachments：从 Photos / Files 上传，timeline 中预览。
- Runtime settings：session 级和 connector agent 级配置。
- Devices：列表、详情、添加、重命名、runtime scan、attach/detach、revoke。
- Workspace / Files：移动端文件浏览和预览。
- Settings：账号、server、外观、安全、权限内的 team/admin/service 配置。
- iPad `NavigationSplitView`。
- 暂不实现 Terminal。

### Phase 2：移动端体验补强

- Push notifications：审批、错误、长任务状态。
- 更完整的文件操作：写入、删除、重命名、下载、分享。
- 更细的离线/弱网重试策略。
- App 内状态缓存和后台刷新。
- iPad 多列布局优化。
- Accessibility 和动态字体完整适配。

### Phase 3：高级移动端能力

- Widgets / Live Activities。
- Spotlight / App Shortcuts。
- 更完整的文件 diff / preview。
- Terminal view，只有确认移动端交互方案后再做。

## 待确认问题

- iOS 客户端是否直接要求 iOS 26，还是需要兼容更老版本？
- 移动端是否允许创建全新的 session，还是只操作 connector 已同步出来的 session？
- 手机上要开放多少 terminal / filesystem 控制能力，哪些能力只留给 iPad / Web？
- Push notifications 是否要进入第一个公开 iOS 版本？
- 分发路径是先 TestFlight，还是直接准备 App Store？
