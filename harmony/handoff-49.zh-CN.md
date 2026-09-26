# 鸿蒙客户端 · 交接备忘（第 49 轮结束时）

> 用途：在新会话里直接接着干。读完本文件即可开工，不需要回溯旧对话。

## 0. 一句话现状

第 48 轮留下的 4 项待办已全部收口：**三项真机复测做完**（工作区勾选修好并通过复测、设置页 X 关闭通过、长按会话操作卡通过），**第 5 条实时 WebSocket 查清后结论是"不是 bug"**（日志被误读 + 息屏伪影），因此没有改代码。本轮实际改了 3 个文件、修掉两处 ArkUI 状态不同步。构建、门禁、逻辑用例、真机复测都是干净的。

**下一轮最值得做的一件事**：第 49 轮的只读审计列出了 **15 组同类 HIGH 隐患**（见 `harmony-client-plan.zh-CN.md` 第 49 轮第 6 节），其中几条是硬伤——目录浏览器可能永远停在「正在加载目录…」、点铅笔无法编辑标题、长按文件弹不出菜单、设置页昵称/邮箱不显示值。建议单开一轮批量改 `@Prop`。

## 1. 环境与固定命令

- 工作目录：`D:\code\Agents-Anywhere`（仓库根）。鸿蒙工程：`D:\code\Agents-Anywhere\harmony`。
- 构建（在 `harmony/` 下执行）：
  ```powershell
  $env:DEVECO_SDK_HOME="C:\Program Files\Huawei\DevEco Studio\sdk"
  node "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" assembleHap --mode module -p product=default --no-daemon
  ```
  成功标志：`BUILD SUCCESSFUL`，且 0 error / 0 ArkTS warning。想留下警告证据就先 `clean` 再把全量日志 tee 到文件后 grep（UP-TO-DATE 的那次不会重印警告）。
- 三个门禁（在 `harmony/` 下）：`node tools/verify-resource-usage.mjs`（当前 627 refs / 154 ETS）、`node tools/verify-encoding.mjs`（175 文本文件）、`node tools/verify-reachability.mjs`（154 ETS，0 orphans）。
- 逻辑用例（仓库外，`%TEMP%\aa-tok`）：先跑该目录下全部 `prepare*.mjs`（把 `.ets` 转写成 `.ts`），再跑 15 个 `check-*.mjs`；全过。已知仅两处允许差异：`app_name` 字符串、颜色字面量（Android 52 vs harmony 56）。
- hdc：`C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`
- **真机**：`62T0225B18043858`（VYG-AL00，1280×2832，density 3 ≈ 427vp 宽，已登录，**API 26 / HarmonyOS 7.0.0.105**）。命令都要 `-t 62T0225B18043858`。
- 模拟器（可选）：实例 `Customize_01`，启动命令（`-imageRoot` 必须是 `D:\sdk\HUAWEI`，否则卡在"清除镜像数据并启动"对话框）：
  ```powershell
  & "C:\Program Files\Huawei\DevEco Studio\tools\emulator\Emulator.exe" -hvd "Customize_01" `
    -path "$env:LOCALAPPDATA\Huawei\Emulator\deployed" -t "trace_${PID}_commandPipe" -imageRoot "D:\sdk\HUAWEI"
  ```
  模拟器没有账号 → 只能测未登录面。

## 2. 真机操作配方（第 49 轮补充过，务必先看这段）

```powershell
$hdc="C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe"; $d="62T0225B18043858"
# ① 测任何"随时间发生的事"（长连、轮询、异步到达）之前，先把息屏超时顶掉：
& $hdc -t $d shell "power-shell timeout -o 1800000"     # 30 分钟；收尾用 power-shell timeout -r 还原
& $hdc -t $d shell "power-shell wakeup"
# ② 装包（同签名可直接覆盖，登录态保留）
& $hdc -t $d install -r "D:\code\Agents-Anywhere\harmony\entry\build\default\outputs\default\entry-default-signed.hap"
# ③ 启动 / 截图
& $hdc -t $d shell aa force-stop com.agentsanywhere.app
& $hdc -t $d shell aa start -a EntryAbility -b com.agentsanywhere.app
& $hdc -t $d shell snapshot_display -f /data/local/tmp/x.jpeg
& $hdc -t $d file recv /data/local/tmp/x.jpeg "$env:TEMP\x.jpeg"
# ④ 点击 / 长按：坐标必须来自 dumpLayout（行 bounds 的中点）
& $hdc -t $d shell uitest uiInput click <x> <y>
& $hdc -t $d shell uitest uiInput longClick <x> <y>
& $hdc -t $d shell uitest dumpLayout -p /data/local/tmp/p.json
& $hdc -t $d file recv /data/local/tmp/p.json "$env:TEMP\p.json"
# ⑤ 应用自己的日志（域 A00000）：在设备侧按 tag 过滤，比拉全量再 grep 可靠
& $hdc -t $d shell "hilog -x -T AgentsAnywhere"
```

**踩过的坑（按重要性）**
1. **息屏 = 应用冻结 = 测出伪影**。第 48 轮就是没顶掉息屏超时，才把"26 秒掉一次 + 日志消失 150 秒"当成"疯狂重连"。测长连前一定先做 ①，并且中途不要锁屏。
2. **`uitest uiInput keyEvent Back` 会把应用退出到系统**（根页面上返回是交给平台的）。本轮因此落到系统设置里一次 —— 不要用它。
3. **`dumpLayout` 里的中文是乱码**（如「新建项目」→ `鏂板缓椤圭洰`）→ 只能拿 Latin 锚点找节点（`Agents-Anywhere`、`jerry`、`Documents`、`DESKTOP-P13E1GV`、`M`、`Agent`）。
4. **不要用估算坐标连点**：布局会随数据到达而变（运行清单回来时整页重排）。本轮第一次点工作区行就吃了这个亏，改用"当次 dump 取 bounds 中点"后一次命中。
5. 手机息屏后 `aa start` 报 `10106102 The device screen is locked`，此时任何点击都不可信。
6. `hilog -x` 不能和 `-z` 之类的选项组合（会报 `Mutlti commands can't be used in combination [CODE: -31]`）。

**一个现成的辅助脚本**（本轮的产物，在仓库外）：`%TEMP%\aasmoke.ps1`，dot-source 之后有 `Get-Ui` / `Find-Ui`（按 Latin 文本找节点并回溯最近的可点祖先）/ `Row-Info`（打印该行的 bounds、children 数与每个子节点）/ `Click-Row` / `LongClick-Row` / `Shot`。用法：

```powershell
. "$env:TEMP\aasmoke.ps1"
$t = Get-Ui 'a1'                       # dump + recv + 解析
(Find-Ui $t '^jerry$') | ForEach-Object { Row-Info $_ }
Click-Row (Find-Ui $t '^jerry$')[0]
```

## 3. 第 49 轮改了什么（都已构建、装机、门禁通过）

| 文件 | 改动 | 状态 |
|---|---|---|
| `entry/src/main/ets/ui/screens/home/NewSessionComponents.ets` | `WorkspaceOptionRow.selected` → `@Prop`；`WorkspaceMarqueeText.selected` → `@Prop` | ✓ 真机验证：点 `Documents` 后勾选从 `jerry` **移动**过去（children 3→2 / 2→3） |
| `entry/src/main/ets/feature/sessions/NewSessionRuntimeSelectionState.ets` | 新增 `beginRuntimeCatalogs()`：只重问目录、保留已拿到的能力集 | ✓ 逻辑用例全过 |
| `entry/src/main/ets/ui/screens/home/NewSessionScreen.ets` | 抽出共用的 `loadRuntimeCatalogs()`；新增 `retryRuntimeResolution()`（按"清单未落定 / 只差能力目录"分派）；两个状态行共用它；补 `NewSessionRuntimeRequestKey` 导入 | ✓ 构建 0 error / 0 warning |
| `harmony-client-plan.zh-CN.md` | 第 49 轮记录（含证据与 15 组 HIGH 清单） | ✓ |

### 本轮最关键的一条认识（下一轮改相似问题时直接用）

**ArkUI 里"普通成员"就是不会更新，而且这条规则已经从编译产物得到证明**：普通成员生成的 `updateStateVars(params) {}` 是**空的**，只有 `@Prop`/`@Link`/`@ObjectLink` 才会在父组件重渲染时被推值。所以：

> **父组件传给子组件、并且会变的值，必须声明成 `@Prop`（或 `@Link`）。** 值每跨一层组件边界就要检查一次。

第 48 轮把 `NewSessionWorkspaceSection.path` 改成了 `@Prop` 是对的，但值还要再跨一层到 `WorkspaceOptionRow.selected`，那一层漏了，所以勾选标记死活不出现。

### 已确认正常、不必重复怀疑的点

- 设置页 X 关闭（左上角 `Column [63,137][217,290]`）✓、长按会话行的操作卡（重命名/归档/置顶）✓。
- 运行时清单本身是健康的；那台 Mac 连接器有时不应答（环境问题，不是 UI）——表现为 Agent/模型/推理强度/权限模式四行停在灰条、底部显示「正在检查可用 Agent」。
- **实时 WebSocket 正常**：保持常亮后 440 秒零掉线，只有 1 条 `Dashboard connection up`。`lws callback reason is 8` 是 `LWS_CALLBACK_CLIENT_RECEIVE`（收到帧），不是错误。`@ohos.net.webSocket` 默认 `pingInterval` 就是 30 秒，**不需要补 ping**。

## 4. 待办

1. **（建议优先）批量修同类 HIGH 隐患**：`harmony-client-plan.zh-CN.md` 第 49 轮第 6 节有 15 组清单（文件:行 + 症状）。修法是把这些声明行改成 `@Prop`（调用点都始终传值，所以安全），改完跑 `assembleHap` + 三个门禁，再按症状逐条真机抽查。最硬的四条：`NewSessionPathSection` 的 `entries/loading/errorMessage/hasRetry`、`NewSessionHeader.headerEditing`、`FilesScreen.FileListRow.menuOpen`、`ProfileRow.trailing`。
2. **会话详情 / 终端 / 文件三屏的真机冒烟**一直没做过（第 48/49 轮都只覆盖了首页、新建会话、抽屉、设置页）。
3. **左缘拖拽开抽屉的实机手感**（跟手度、44vp 边缘触发宽度）仍未确认。
4. 那台真机的连接器应答不稳定（有时几十秒不出清单），如果持续如此，值得查一下连接器侧的 RPC 超时与退避阶梯的收尾。

## 5. 工程约定（必须遵守）

- 文本文件（`.ets/.json/.md` 等）**不要**用 PowerShell `Get-Content`/`Set-Content` 往返，用文件工具或显式 UTF-8 的 Node 脚本，改完跑 `verify-encoding.mjs`（BOM=0/replacement=0/mojibake=0）。仓库文本一律 LF。
- 不留死代码；每一批改动结束必须：干净 `assembleHap`（0 error / 0 ArkTS warning）+ 三个门禁 + 逻辑用例 + 在 `harmony-client-plan.zh-CN.md` 追加一轮记录。
- 字符串：`app_strings.json` 由 Android 转写生成（`tools/convert-android-strings.mjs`），不要手改；iOS 独有文案放 `ios_strings.json`。
- 视角：**iOS 是布局/观感基准**，Android 是逻辑/文案/配色基准。
- 新 API 要按 `build-profile.json5` 里那条注释的约定**手工核对 API 12 可用性**（工具链是 API 23 的 SDK，编译器不会替你拦）。

## 6. 已知的 iOS/Android 差异与设计取舍（别当成 bug）

- 下拉菜单是纯白卡片（iOS 是毛玻璃）；卡片/侧栏用纯色（未上模糊材质）。
- `pickDevice()` 会"keep the page on a usable device"：手动选了没有可用 Agent 的设备后，页面会自动回到有 Agent 的那台（继承 Android 行为）。
- 未实现 iOS 的 ConcentricRectangle 圆角细节与额外的卡片高亮。

## 7. 新会话开场提示词（可整段复制）

> 读 `D:\code\Agents-Anywhere\harmony\handoff-49.zh-CN.md`（工作目录 `D:\code\Agents-Anywhere`），按第 4 节顺序继续：优先做第 1 条——按 `harmony/harmony-client-plan.zh-CN.md` 第 49 轮第 6 节的 15 组 HIGH 清单，把那些"父组件传值又会变"的普通成员批量改成 `@Prop`，每批结束跑干净 `assembleHap`（0 error / 0 ArkTS warning）+ 三个门禁 + 15 个逻辑用例，并按症状逐条真机抽查（真机 `62T0225B18043858`，先 `power-shell timeout -o 1800000` 顶掉息屏超时，坐标一律来自 `uitest dumpLayout`，中文是乱码所以用 Latin 锚点）。改动前先读对应 `.ets`；不要用估算坐标点击；不要用 `uitest uiInput keyEvent Back`。
