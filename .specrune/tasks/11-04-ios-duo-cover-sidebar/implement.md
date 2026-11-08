# 执行计划

## 预检

- 读 `.specrune/spec/ios/duo-layout.md`（竖排 toolbar 契约、机型门控保留理由）。
- 读 `.specrune/spec/ios/index.md`（AppSymbol 图标、body 类型检查约束）。
- 确认工作区干净：本次只动 `ios/` 下 4 个文件（1 改 3 删）。
- 构建产物用独立 `-derivedDataPath`（Xcode 开着会锁 build.db）。

## 步骤

1. **改形态分派**：`Views/ChatShell/ChatShellView.swift:47-53`
   - 去掉 `Group` 与两 Tab 分支，恢复上游单一路径 `sidebarLayout(layout)`。
   - 保留注释里"分派依据是系统 trait"的说明；删掉"两 Tab 专属外屏"的
     设备型号注释（理由已不成立）。
2. **收窄侧栏底栏条件**：同文件 `:193`
   - `showsBottomControls: !isDuoFoldableIPhone`
     → `!(isDuoFoldableIPhone && layout == .regularSplit)`。
   - 注释同步：内屏清空、外屏抽屉保留。
3. **rail 注入保持不变**（`:223`），确认合盖外屏命中。
4. **删除两 Tab 外壳**：
   - `Views/ChatShell/CompactChatShellView.swift`
   - `Views/ChatShell/CompactSessionListView.swift`
   - `Views/ChatShell/CompactMoreView.swift`
   - 工程用文件系统同步组，无需改 pbxproj。
5. **全仓查残留**：`grep -rn "CompactChatShellView\|CompactSessionListView\|CompactMoreView" ios/`
   必须零命中（含 Preview、测试、文档）。
6. **构建**：
   ```bash
   cd ios && xcodebuild -project "Agents Anywhere/Agents Anywhere.xcodeproj" \
     -scheme "Agents Anywhere" -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
     -derivedDataPath /tmp/duo_cover_dd build 2>&1 | tail -5
   ```
   以 `BUILD SUCCEEDED` 判定（grep 到 error 行返回 0 会让链继续）。
7. **模拟器验收**（Duo 模拟器 `iPhone19,4`，必要时 DeviceHub 切合盖）：
   - 启动无底部 Tab 栏；欢迎页顶栏右侧有新会话 + 头像。
   - 菜单/右滑开抽屉：设备区、置顶/最近会话、底栏（新会话 + 账号）。
   - 进会话发消息；回抽屉切会话。
   - 横屏：rail 进右缘竖排，抽屉仍可滑出。
8. **回归对照**：普通 iPhone 模拟器抽屉行为不变；Duo 内屏双栏与右缘
   竖排不变。
9. **消掉开抽屉时的 toolbar 闪现**：`ChatPageToolbar.body`
   - 读 `\.sidebarDrawerObscuresDetail`，抽屉打开（含动画）时
     `.toolbar(.hidden, for: .navigationBar)`，收起恢复。
   - 内屏 nativeSidebar 下该环境值恒 false，不受影响。
10. **不要碰 toolbar 竖排开关**：`toolbarVerticalBehavior` 是稳定选择，
   禁止按方向/视图状态切换（Apple Duo 规则；2026-11-05 试过并撤回）。
11. **更新文档**：`CHANGELOG.md` 未发布节 iOS 分类写一条用户可见变化；
   `.specrune/spec/ios/duo-layout.md` 的机型门控条目补一句"外屏外壳已回归
   原版，`isDuoFoldableIPhone` 剩余门控 = rail 注入 + 底栏 + 宽度上限"。

## 验证命令

```bash
cd ios
xcodebuild -project "Agents Anywhere/Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/duo_cover_dd build | tail -5
# 真机（如模拟器不支持合盖姿态）
xcodebuild -project "Agents Anywhere/Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" \
  -destination 'id=<UDID>' -allowProvisioningUpdates -derivedDataPath /tmp/duo_cover_dd_dev build
xcrun devicectl device install app --device <UDID> \
  "/tmp/duo_cover_dd_dev/Build/Products/Debug-iphoneos/Agents Anywhere.app"
xcrun devicectl device process launch --device <UDID> com.dae.sr1023
```

## 风险文件 / 回滚点

| 文件 | 风险 |
|---|---|
| `ChatShellView.swift` | 唯一的形态分派点，改错会让所有 compact 形态走错外壳 |
| 三个 Compact* 文件 | 删除；git 可恢复，单提交可 revert |
| `duo-layout.md` | 契约文档，改动仅补一句门控说明 |

回滚：单次提交，`git revert <sha>`；无数据迁移、无 UserDefaults 键变化。

## 完成后

- `specrune task finish` → `specrune task archive`。
- 记录未验证项（例如合盖姿态只在真机验证过、外屏横屏 rail 的键盘期表现）。
