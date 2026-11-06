# 鸿蒙客户端 · 交接备忘（第 48 轮结束时）

> 用途：在新会话里直接接着干。读完本文件即可开工，不需要回溯旧对话。

## 0. 一句话现状

鸿蒙客户端 `harmony/` 与 iOS 布局对齐的工作已完成到"能力对等"，**第 48 轮在真机上做冒烟，修掉了一类 ArkUI 状态不同步的 bug**（配置卡五个下拉菜单点不开、配置行不随数据刷新、工作区勾选不移动、Agent 行灰条时界面沉默）。当前构建、门禁、真机安装都是干净的；**只剩 1 项 UI 复测 + 3 项界面冒烟 + 2 项待查**。

## 1. 环境与固定命令

- 工作目录：`D:\code\Agents-Anywhere`（仓库根）。鸿蒙工程：`D:\code\Agents-Anywhere\harmony`。
- 构建（在 `harmony/` 下执行）：
  ```powershell
  $env:DEVECO_SDK_HOME="C:\Program Files\Huawei\DevEco Studio\sdk"
  node "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" assembleHap --mode module -p product=default --no-daemon
  ```
  成功标志：`BUILD SUCCESSFUL`，且要 0 error / 0 ArkTS warning。
- 三个门禁（在 `harmony/` 下）：`node tools/verify-resource-usage.mjs`（当前 627 refs / 154 ETS）、`node tools/verify-encoding.mjs`（175 文本文件）、`node tools/verify-reachability.mjs`（154 ETS，0 orphans）。
- 逻辑用例（仓库外，每次先用 `prepare-*.mjs` 重新转写 `.ets`→`.ts`，再跑 15 个 `check-*.mjs`）：`%TEMP%\aa-tok`。全过；已知仅两处允许差异：`app_name` 字符串、颜色字面量（Android 52 vs harmony 56）。
- hdc：`C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`
- **真机**：`62T0225B18043858`（VYG-AL00，1280×2832，density 3 ≈ 427vp 宽，已登录）。命令都要 `-t 62T0225B18043858`。
- 模拟器（可选）：实例 `Customize_01`，启动命令（`-imageRoot` 必须是 `D:\sdk\HUAWEI`，否则卡在"清除镜像数据并启动"对话框）：
  ```powershell
  & "C:\Program Files\Huawei\DevEco Studio\tools\emulator\Emulator.exe" -hvd "Customize_01" `
    -path "$env:LOCALAPPDATA\Huawei\Emulator\deployed" -t "trace_${PID}_commandPipe" -imageRoot "D:\sdk\HUAWEI"
  ```
  模拟器没有账号 → 只能测未登录面（登录方式页/选择登录服务页，均正常）。

## 2. 真机操作配方（务必按此顺序，别再猜坐标）

```powershell
$hdc="C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe"; $d="62T0225B18043858"
# 装包（同签名可直接覆盖，登录态保留）
& $hdc -t $d install -r "D:\code\Agents-Anywhere\harmony\entry\build\default\outputs\default\entry-default-signed.hap"
# 启动 / 截图
& $hdc -t $d shell aa force-stop com.agentsanywhere.app
& $hdc -t $d shell aa start -a EntryAbility -b com.agentsanywhere.app
& $hdc -t $d shell snapshot_display -f /data/local/tmp/x.jpeg
& $hdc -t $d file recv /data/local/tmp/x.jpeg "$env:TEMP\x.jpeg"
# 点击：优先用 uitest（比 uinput 稳），坐标必须来自 dumpLayout
& $hdc -t $d shell uitest uiInput click <x> <y>
& $hdc -t $d shell uitest dumpLayout -p /data/local/tmp/p.json
& $hdc -t $d file recv /data/local/tmp/p.json "$env:TEMP\p.json"
# 其它：锁屏后 hdc shell power-shell wakeup 只亮屏，解锁要用户按 PIN；日志用 hdc shell hilog -x
```

**踩过的坑**
1. **dumpLayout 里的中文是乱码**（如「新建项目」→ `鏂板缓椤圭洰`）→ 只能拿 Latin 锚点找节点（`Agents-Anywhere`、`DESKTOP-P13E1GV`、`jerry`）。
2. **不要用估算坐标连点**：布局会随数据到达而变。曾经因此点到系统设置、或把抽屉打开，导致两次复测失效。
3. 手机息屏后 `aa start` 报 `10106102 The device screen is locked`，此时任何点击都不可信 —— 先让用户解锁并保持常亮。
4. 每次操作前确认前台是 `com.agentsanywhere.app`（`aa start` + 截图/dump 校验）。

## 3. 第 48 轮改了什么（都已构建、装机、门禁通过）

真机冒烟发现四个现象，根因是**同一条 ArkUI 规则**：组件用**普通成员变量**接收父组件数据时，父组件重渲染不会让子组件重渲染，于是"点击生效了但界面不动"。修法统一为把相关成员改成 **`@Prop`**。

| 文件 | 改动 | 状态 |
|---|---|---|
| `entry/src/main/ets/ui/screens/home/NewSessionConfigurationCard.ets` | `expandedKey` → `@Prop`；`fields` → `@Prop` | ✓ 真机验证：点「设备」弹出三台设备并可切换 |
| `entry/src/main/ets/ui/screens/home/NewSessionWorkspaceSection.ets` | `path` → `@Prop` | 已装机，**未复测**（见第 4 节第 1 条） |
| `entry/src/main/ets/ui/screens/home/NewSessionScreen.ets` | 新增 `isCheckingAgents()`（合并 Android 的 CheckingDevices/CheckingAgents 两个 reason 与 inventory/selection 标志，并覆盖"目录阶段"）；`startInventory()` 按在线设备集合去重（防抖）；临时 `AALog` 诊断已删 | ✓ 真机验证：12s 时四行灰条 + 底部「正在检查可用 Agent」同时可见 |
| `harmony-client-plan.zh-CN.md` | 本轮记录（含日志证据） | ✓ |

**已确认正常、不必重复怀疑的点**
- 运行时清单**健康**：日志 `inventory start 2` → 166ms 后 `inventory done pending=0 results=2 errors=0`；选择状态也被正确采纳（`adopt … loading=false ready=1`）。此前"连接器不应答/清单卡住"的推测已撤回（用户 iOS 上确认连接器在线，是对的）。
- 左缘拖拽开抽屉 ✓、抽屉开合 ✓、头像进设置页 ✓、桌面图标 = iOS 那张 ✓、未登录三页 ✓、侧栏内容（设备在线点/项目树/嵌套会话/底部栏 + 头像 M）✓。

## 4. 待办（按顺序做，第 1 条是唯一"未验证的改动"）

1. **复测工作区勾选**（验证 `path` → `@Prop`）：回到首页 → `dumpLayout` → 取 text 含 `Agents-Anywhere` 节点的 `bounds` 中点 → `uitest uiInput click` → 再 dump，比较该行 `children` 数量（勾选会多一个子节点，2 → 3 即成功）。
2. **设置页 X 关闭 / 返回手势**：抽屉底部头像 → 设置页 → 先用 dump 取左上角可点节点 bounds 再点（预期回到列表；若异常，检查 `closeProfile()` / `publishBackGesture()`）。
3. **长按会话行 → 操作卡**：抽屉里长按某会话（`uinput -T -d/-u` 或 `uitest uiInput longClick`），确认重命名/置顶/归档卡片；同样先 dump 取 bounds。
4. **目录阶段补「重试」**：当前 `isCheckingAgents()` 为真时只在"清单已落定"分支显示重试；建议把"能力/模型/权限目录"阶段也纳入（点击重跑 `loadRuntimeDetails()`）。
5. **查实时 WebSocket 断线重连**：`hilog` 里 `NETSTACK: websocket_exec.cpp:498 lws callback reason is 8` 连续刷屏（reason 8 ≈ 连接错误）。虽然不影响 HTTP 清单，但长连循环本身不正常，需要查握手 URL/鉴权。

## 5. 工程约定（必须遵守）

- 文本文件（`.ets/.json/.md` 等）**不要**用 PowerShell `Get-Content`/`Set-Content` 往返，用文件工具或显式 UTF-8 的 Node 脚本，改完跑 `verify-encoding.mjs`（BOM=0/replacement=0/mojibake=0）。
- 不留死代码；每一批改动结束必须：干净 `assembleHap`（0 error / 0 ArkTS warning）+ 三个门禁 + 逻辑用例 + 在 `harmony-client-plan.zh-CN.md` 追加一轮记录。
- 字符串：`app_strings.json` 由 Android 转写生成（`tools/convert-android-strings.mjs`），不要手改；iOS 独有文案放 `ios_strings.json`。
- 视角：**iOS 是布局/观感基准**，Android 是逻辑/文案/配色基准。

## 6. 已知的 iOS/Android 差异与设计取舍（别当成 bug）

- 下拉菜单是纯白卡片（iOS 是毛玻璃）；卡片/侧栏用纯色（未上模糊材质）。
- `pickDevice()` 会"keep the page on a usable device"：手动选了没有可用 Agent 的设备后，页面会自动回到有 Agent 的那台（继承 Android 行为）。
- 未实现 iOS 的 ConcentricRectangle 圆角细节与额外的卡片高亮。

## 7. 新会话开场提示词（可整段复制）

> 读 `D:\code\Agents-Anywhere\harmony\handoff-48.zh-CN.md`（工作目录 `D:\code\Agents-Anywhere`），按第 4 节顺序继续：先用真机 `62T0225B18043858` + `uitest dumpLayout` 取 `Agents-Anywhere` 行 bounds 复测工作区勾选（验证 `NewSessionWorkspaceSection.path` → `@Prop`），再做设置页 X/返回、长按会话操作卡，然后补目录阶段的重试入口、查 `lws callback reason is 8` 重连。每批结束按第 5 节跑构建+三脚本+逻辑用例并更新 `harmony/harmony-client-plan.zh-CN.md`。改动前先读对应 `.ets`；不要用估算坐标点击。
