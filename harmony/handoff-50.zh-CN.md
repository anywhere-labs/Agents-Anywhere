# 鸿蒙客户端 · 交接备忘（第 50 轮结束时）

> 用途：在新会话里直接接着干。读完本文件即可开工，不需要回溯旧对话。

## 0. 一句话现状

用户这一轮要求的三件事都做完了：**剩余屏幕冒烟**（会话详情 / 设备详情 / 文件 / 终端 / 归档会话，全部通过，其中终端真的连上了 Mac 的 zsh）、**页面背景改成纯白**（像素实测 `#FFFFFF`）、**适配深色模式**（切换即时生效，canvas `#09090B` / 卡片 `#1F1F1F`）。冒烟过程中发现并修掉两个真 bug：**从抽屉点会话不关抽屉**（内容被抽屉挡住）、**设置页在切主题时不重绘**（顺带修掉了审计 H10：设置页昵称/邮箱的值从来不显示）。

**下一轮最值得做的一件事**：把 `colors` 系统性改成响应式（见第 4 节第 1 条），它会一次性消灭"同类状态不同步"里最大的一族。

## 1. 环境与固定命令

- 工作目录：`D:\code\Agents-Anywhere`（仓库根）。鸿蒙工程：`D:\code\Agents-Anywhere\harmony`。
- 构建（在 `harmony/` 下执行）：
  ```powershell
  $env:DEVECO_SDK_HOME="C:\Program Files\Huawei\DevEco Studio\sdk"
  node "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" assembleHap --mode module -p product=default --no-daemon
  ```
  成功标志：`BUILD SUCCESSFUL`，且 0 error / 0 ArkTS warning。要**留下警告证据**就先 `clean`，再把全量输出 tee 到文件后 grep（UP-TO-DATE 的那次不会重印警告）。
- 三个门禁（在 `harmony/` 下）：`node tools/verify-resource-usage.mjs`（627 refs / 154 ETS）、`node tools/verify-encoding.mjs`（175 文本文件）、`node tools/verify-reachability.mjs`（154 ETS，0 orphans）。
- 逻辑用例（仓库外，`%TEMP%\aa-tok`）：先跑该目录全部 `prepare*.mjs`（`.ets`→`.ts` 转写），再跑 15 个 `check-*.mjs`；全过。已知仅两处允许差异：`app_name` 字符串、颜色字面量（Android 52 vs harmony 56）。
- hdc：`C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`
- **真机**：`62T0225B18043858`（VYG-AL00，1280×2832，density 3 ≈ 427vp 宽，已登录，API 26 / HarmonyOS 7.0.0.105）。命令都要 `-t 62T0225B18043858`。
- 模拟器（可选）：实例 `Customize_01`，启动命令（`-imageRoot` 必须是 `D:\sdk\HUAWEI`）：
  ```powershell
  & "C:\Program Files\Huawei\DevEco Studio\tools\emulator\Emulator.exe" -hvd "Customize_01" `
    -path "$env:LOCALAPPDATA\Huawei\Emulator\deployed" -t "trace_${PID}_commandPipe" -imageRoot "D:\sdk\HUAWEI"
  ```

## 2. 真机操作配方

```powershell
$hdc="C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe"; $d="62T0225B18043858"
# ① 测任何"随时间发生的事"之前，先顶掉息屏超时（不设它，息屏会冻结应用、测出伪影）
& $hdc -t $d shell "power-shell timeout -o 1800000"     # 收尾用 power-shell timeout -r 还原
& $hdc -t $d shell "power-shell wakeup"
# ② 装包（同签名可覆盖，登录态保留）
& $hdc -t $d install -r "D:\code\Agents-Anywhere\harmony\entry\build\default\outputs\default\entry-default-signed.hap"
# ③ 启动 / 截图
& $hdc -t $d shell aa force-stop com.agentsanywhere.app
& $hdc -t $d shell aa start -a EntryAbility -b com.agentsanywhere.app
& $hdc -t $d shell snapshot_display -f /data/local/tmp/x.jpeg ; & $hdc -t $d file recv /data/local/tmp/x.jpeg "$env:TEMP\x.jpeg"
# ④ 点击 / 长按；坐标必须来自 dumpLayout 的节点 bounds 中点
& $hdc -t $d shell uitest uiInput click <x> <y>
& $hdc -t $d shell uitest uiInput longClick <x> <y>
& $hdc -t $d shell uitest dumpLayout -p /data/local/tmp/p.json ; & $hdc -t $d file recv /data/local/tmp/p.json "$env:TEMP\p.json"
# ⑤ 应用自己的日志（域 A00000），设备侧按 tag 过滤
& $hdc -t $d shell "hilog -x -T AgentsAnywhere"
```

**看颜色要取像素，别靠眼睛**（`snapshot_display` 只出 JPEG，预览会骗人；`#FDFCFB` 和 `#FFFFFF` 只差 2~4 级）：

```powershell
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile("$env:TEMP\x.jpeg")
$c = $b.GetPixel(640, 900); "{0:X2}{1:X2}{2:X2}" -f $c.R,$c.G,$c.B
```

**踩过的坑**
1. **`uitest dumpLayout` 不可靠地包含 `bindMenu` 弹出的内容**（菜单在独立浮层窗口里，时有时无）。所以"dump 里找不到菜单项"**不等于**菜单没开——判断浮层是否出现要看截图。本轮因此误判过两次。
2. **息屏 = 应用冻结 = 伪影**（第 48 轮把"26 秒掉一次 + 日志消失"当成疯狂重连就是这么来的）。先做 ①。
3. **不要用 `uitest uiInput keyEvent Back`**：根页面上返回交给平台，会把应用直接退出到系统。
4. **`dumpLayout` 里中文是乱码** → 用 Latin 锚点找节点（`Agents-Anywhere`、`jerry`、`Documents`、`DESKTOP-P13E1GV`、`M`、`Agent`）。
5. **不要用估算坐标**：布局会随数据到达而变（运行清单回来时整页重排）。本轮有一次多点了一下，结果从设置页跳到了「已归档会话」。
6. `hilog -x` 不能与 `-z` 等选项组合（报 `Mutlti commands can't be used in combination [CODE: -31]`）。
7. 抽屉打开时点侧栏里的行，**内容卡片是右移的**，dump 出来的坐标会带偏移——先确认抽屉状态再判断坐标。

**现成的辅助脚本**（仓库外，本轮产物）：`%TEMP%\aasmoke.ps1`，dot-source 后有 `Get-Ui` / `Find-Ui`（按文本找节点并回溯最近可点祖先）/ `Row-Info`（打印该行 bounds、children 数与每个子节点）/ `Click-Row` / `LongClick-Row` / `Shot`。

```powershell
. "$env:TEMP\aasmoke.ps1"
$t = Get-Ui 'a1'
(Find-Ui $t '^jerry$') | ForEach-Object { Row-Info $_ }
Click-Row (Find-Ui $t '^jerry$')[0]
```

## 3. 第 50 轮改了什么（都已构建、装机、门禁通过）

| 文件 | 改动 | 验证 |
|---|---|---|
| `entry/src/main/ets/ui/designsystem/AAColors.ets` | `AA_LIGHT_COLORS.canvas`：`#FDFCFB` → `#FFFFFF`（对齐 iOS 的 `Color(.systemBackground)`）；深色调色板不动 | ✓ 像素实测 `#FFFFFF` |
| `entry/src/main/ets/ui/screens/profile/ProfileSettingsSupport.ets` | `profilePageBackground()` 不再硬编码 `#F4F3EF`，改为跟随 `colors.canvas` | ✓ |
| `entry/src/main/ets/ui/screens/terminal/TerminalContent.ets` | 终端画布 `#FEFDFB` → `#FFFFFF` | ✓ 终端白底 |
| `entry/src/main/ets/ui/screens/sessiondetail/AttachmentViews.ets` | 图片查看器背景 `#FDFCFB` → `#FFFFFF` | 构建通过 |
| `entry/src/main/ets/ui/screens/profile/ProfileSettingsDrawer.ets` | `colors`/`appearanceMode`/`languageMode`/`sidebarViewMode` → `@Prop` | ✓ 切主题时这一页即时重绘、行的值跟着变 |
| `entry/src/main/ets/ui/screens/profile/ProfileSettingsComponents.ets` | 5 个 struct 的 `colors` → `@Prop`；`ProfileRow.trailing`/`trailingIcon`/`trailingAttention`/`showChevron` → `@Prop`（后者即审计 H10） | ✓ 昵称/邮箱终于显示值；卡片在深色下变 `#1F1F1F` |
| `entry/src/main/ets/ui/designsystem/AAIcon.ets` | `color` → `@Prop`（几乎每个调用点都由调色板算出，一行改动杠杆最高） | ✓ 深色下图标不再是深色 |
| `entry/src/main/ets/app/AgentsAnywhereApp.ets` | `openSession()` 改走 `navigate(AppDestination.SessionDetail)`，不再直接写 `destination` | ✓ 从抽屉点会话后抽屉自动关闭、详情全宽 |

### 本轮最关键的两条认识

1. **普通成员 = 不会更新，已由编译产物证明**：普通成员的 `updateStateVars(params) {}` 是空的，只有 `@Prop`/`@Link`/`@ObjectLink` 才在父组件重渲染时被推值。**值每跨一层组件边界都要检查一次。**
2. **主题切换只重绘"被重建的子树"**：`colors` 目前几乎处处是普通成员，所以切深浅色时，只有**重建过**的子树会拿到新调色板。现在"切换时仍挂载"的页面只有设置页（已修好）；别的页面在导航时重建，所以看着正常。

## 4. 待办

1. **（建议优先）把 `colors` 做成响应式的共享主题**：现在每个组件都把 `colors` 当普通成员接收（约百处）。逐处改 `@Prop` 可行但对对象是深拷贝；更合适的是 `AppStorage.setOrCreate('aaColors', palette)` + 组件用 `@StorageProp('aaColors')`。做完之后"切换主题/换肤"全局即时生效，也顺手覆盖掉一大批同类隐患。改完跑 `assembleHap` + 三个门禁，并在设置页与首页各切一次深浅色验证。
2. **第 49 轮审计的同类 HIGH 清单**（见 `harmony-client-plan.zh-CN.md` 第 49 轮第 6 节，共 15 组；H10 本轮已修）。最硬的还剩：`NewSessionPathSection.entries/loading/errorMessage/hasRetry`（目录浏览器可能永远停在"正在加载目录…"）、`NewSessionHeader.headerEditing`（点铅笔无法编辑标题）、`FilesScreen.FileListRow.menuOpen`（长按文件弹不出菜单）、`SessionStatusIndicator.indicator`（会话状态点不变化）、`DeviceRow.preview`（Agent 预览一直停在"检查中"）。
3. **还没冒烟的屏**：配对向导 / 添加设备、QR 登录三页、未归档的设备设置页。会话详情、设备详情、文件、终端、归档会话本轮已过。
4. **那台 Mac 的连接器应答不稳定**（AGENT 区常见"正在加载运行时…"几十秒）。若持续如此，值得查连接器侧 RPC 超时与退避阶梯的收尾。

## 5. 工程约定（必须遵守）

- 文本文件（`.ets/.json/.md`）**不要**用 PowerShell `Get-Content`/`Set-Content` 往返，用文件工具或显式 UTF-8 的 Node 脚本；仓库文本一律 LF、无 BOM。注意 `verify-encoding.mjs` 只扫 `entry/src/main/ets`、`entry/src/main/resources`、`AppScope`、`tools`，**根目录的 `*.md` 不在它的范围内**，那些文件要自己确认（BOM/CR/U+FFFD 都为 0）。
- 不留死代码；每一批改动结束必须：干净 `assembleHap`（0 error / 0 ArkTS warning）+ 三个门禁 + 15 个逻辑用例 + 在 `harmony-client-plan.zh-CN.md` 追加一轮记录。
- 字符串：`app_strings.json` 由 Android 转写生成（`tools/convert-android-strings.mjs`），不要手改；iOS 独有文案放 `ios_strings.json`。
- 视角：**iOS 是布局/观感基准**，Android 是逻辑/文案/配色基准。这一轮的"页面纯白"就是按 iOS 的 `Color(.systemBackground)` 定的，不是自创。
- 新 API 要按 `build-profile.json5` 里那条注释的约定**手工核对 API 12 可用性**（工具链是 API 23 的 SDK，编译器不会替你拦）。

## 6. 已知的 iOS/Android 差异与设计取舍（别当成 bug）

- 页面底色是纯白（原 Android 的 `Canvas` 是暖白 `#FDFCFB`），理由见上一节；深色仍是 Android 的 `#09090B`。
- 下拉菜单是纯白卡片（iOS 是毛玻璃）；卡片/侧栏用纯色（未上模糊材质）。
- `pickDevice()` 会"keep the page on a usable device"：手动选了没有可用 Agent 的设备后，页面会自动回到有 Agent 的那台（继承 Android 行为）。
- 未实现 iOS 的 ConcentricRectangle 圆角细节与额外的卡片高亮。

## 7. 新会话开场提示词（可整段复制）

> 读 `D:\code\Agents-Anywhere\harmony\handoff-50.zh-CN.md`（工作目录 `D:\code\Agents-Anywhere`），按第 4 节顺序继续：优先做第 1 条——把 `colors` 从普通成员改成响应式的共享主题（建议 `AppStorage` + `@StorageProp('aaColors')`），让切换深浅色全局即时生效，顺便消灭一大批"同类状态不同步"隐患；再做第 2 条里剩下的 HIGH 项（目录浏览器永久"正在加载"、点铅笔无法编辑标题、长按文件弹不出菜单）。每批结束跑干净 `assembleHap`（0 error / 0 ArkTS warning）+ 三个门禁 + 15 个逻辑用例，并在真机 `62T0225B18043858` 上验证（先 `power-shell timeout -o 1800000` 顶掉息屏；坐标一律来自 `uitest dumpLayout`；中文乱码所以用 Latin 锚点；菜单是否弹出要看截图而不是 dump；改动前先读对应 `.ets`）。
