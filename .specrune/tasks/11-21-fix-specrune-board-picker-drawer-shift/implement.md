# 实施：SpecRune 看板项目选择空态与抽屉位移

## 启动前检查

- [x] `specrune task current` 确认绑定本任务
- [x] `git status` 干净（除本任务目录）
- [x] 读 `.specrune/spec/ios/duo-layout.md`「合盖外屏外壳 = 原版抽屉」与「模拟器 UI 验证」两节
- [x] 读 `.specrune/spec/ios/index.md` 的 iOS Quick Rules
- [x] 确认 Duo 模拟器（138A5F69-4F9D-4FE2-A215-E1DAB226A92F）合盖外屏、app 已登录且 Mac Studio 在线

## 阶段 1 · 修复 1：项目列表即空态

- [x] `Views/SpecRune/SpecRuneTasksView.swift`：删 `selectFirstProjectIfNeeded` 及 `.task`/`.onChange(of: projects)` 两处调用
- [x] 同文件：`taskColumn` 的 `selectedRepo == nil` 分支改为项目列表
  - 列表项三态：可点 / 探测中（ProgressView）/ 置灰（`probeFailures` 原因或「未启用 SpecRune」）
  - `deviceProjects` 为空 → 明确空态；dashboard 未加载完 → 加载态
  - 点击走 `model.select(repo:)`
- [x] 确认 rail「项目」sheet 选择器仍工作且与列表选中态同步

**验证**：Duo 外屏进入 SpecRune 首屏项目列表；点项目进任务列表；AX 树核对。

## 阶段 2 · 修复 2：抽屉开合位移

- [x] 实验 A：`Views/Chat/ChatPageToolbar.swift` 去掉抽屉打开时的导航栏隐藏，构建实跑
  - 抽屉打开/关闭：SpecRune 面板内容 y 坐标不变
  - 逐帧截图确认导航栏无「闪现又消失」
  - 会话页同样抽查
- [ ]（未触发） 若 A 有闪现回归 → 实验 B：保留隐藏，在 `ChatDetailNavigation` / 页面侧补偿顶部占位（按实测标定）
- [x] 选定方案后清理实验代码，保留最小改动

**验证**：`idb ui describe-all` 抽屉前后对比「工作流 · 1」/首条任务 y；`simctl io screenshot` 逐帧抽查。

## 阶段 3 · 收尾

- [x] `CHANGELOG.md`「未发布」iOS 分类补一条（用户可感知：进入看板先选项目；抽屉开合内容不再跳动）
- [x] `specrune specs --check`
- [ ] `specrune session record`
- [ ] `specrune task finish` → `specrune task archive`

## 验证命令

```bash
# 构建（模拟器）
cd "ios/Agents Anywhere"
xcodebuild -project "Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" \
  -destination 'id=138A5F69-4F9D-4FE2-A215-E1DAB226A92F' \
  -derivedDataPath /tmp/aa_dd build

# 安装 + 启动
xcrun simctl install 138A5F69-4F9D-4FE2-A215-E1DAB226A92F \
  "/tmp/aa_dd/Build/Products/Debug-iphonesimulator/Agents Anywhere.app"
xcrun simctl launch 138A5F69-4F9D-4FE2-A215-E1DAB226A92F com.agentsanywhere.app

# AX 树与点击
idb ui describe-all --udid 138A5F69-4F9D-4FE2-A215-E1DAB226A92F
idb ui tap <x> <y> --udid 138A5F69-4F9D-4FE2-A215-E1DAB226A92F

# 截图：外屏 / 内屏
xcrun simctl io 138A5F69-4F9D-4FE2-A215-E1DAB226A92F screenshot --display=1 --type=png /tmp/outer.png
xcrun simctl io 138A5F69-4F9D-4FE2-A215-E1DAB226A92F screenshot --display=3 --type=png /tmp/inner.png
```

## 风险文件 / 回滚点

- `Views/Chat/ChatPageToolbar.swift`：抽屉导航栏策略的共用分支，改动影响会话页/新会话页/设备页；改动前先备份到 `/tmp`，实验失败立即还原。
- `Views/SpecRune/SpecRuneTasksView.swift`：去掉自动选择后首屏是列表，注意 `projects` 异步到达的时序（先空态后列表），避免闪「这个设备还没有项目」。
- 抽屉位移若走补偿方案：补偿量与导航栏高度、内层 NavigationStack 相关，标定错误会引入反向跳动；优先方案 A。
- 模拟器合盖/展开切换需要 Device Hub（`/Applications/Xcode.app/Contents/Applications/DeviceHub.app`）；当前合盖外屏已验证可用。
