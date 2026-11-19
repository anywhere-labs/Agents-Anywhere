# v3 PoC tokens 维护规则

`tokens.json` 是 Android 设计数值的源文件；`AATokens.kt` 由生成器生成，不要直接编辑。iOS 仍使用 Swift 中的系统样式和数值，没有读取此 JSON。

```sh
python3 -I v3poc/android/tools/tokens2kotlin.py
python3 -I v3poc/android/tools/tokens2kotlin.py --check
```

`--check` 只比较、不写文件；生成文件有差异时返回非零。Gradle 当前不自动运行此检查，提交设计变更前应手动执行。

颜色使用 `[浅色, 深色]`、`#RRGGBBAA`；尺寸为 dp，字体为 sp。`metric` 中整数生成 Dp，小数或以 `Fraction`、`Scale`、`Opacity` 结尾的值生成 Float；`motion` 保存 SwiftUI 风格参数，`spring` 保存 Compose 的阻尼和刚度。

## 来源与边界

2026-11-19 将此前只写在 `AATokens.kt` 的嵌套玻璃、Sheet、描边、提亮、按压参数回填到 JSON，保留已有值；这不是一次新的 iOS 截图取色。Sheet 卡片按交接规则改为不透明。新的开关尺寸和弹簧从现有 `Switch.kt` 提取，行为数值保持一致。

参考截图未入库，交接指定路径为 `.local-dev/v3poc/compare-ref/ios/`。未取得参考截图前，不用目测新增「已对齐 iOS」的颜色值；尤其浅色「允许」按钮的灰色立体高光仍待取样。

## 玻璃上的玻璃

| token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `liquidButtonSurface` | `#FFFFFF4D` | `#12121266` | 线程上的胶囊 / 圆形按钮着色 |
| `liquidButtonLift` | `#00000004` | `#FFFFFF1C` | 上述按钮的亮度修正 |
| `liquidNestedButtonSurface` | `#FFFFFF4D` | `#12121200` | 已绘制玻璃之上的按钮着色 |
| `liquidNestedButtonLift` | `#00000001` | `#FFFFFF20` | 嵌套按钮提亮 |
| `liquidPanelSurface` | `#FAFAFA66` | `#12121266` | 输入框卡片、审批区着色 |
| `liquidPanelLift` | `#00000001` | `#FFFFFF1C` | 面板亮度修正 |
| `liquidSheetSurface` | `#FAFAFA80` | `#30303099` | Sheet / 菜单着色 |
| `sheetCard` | `#FFFFFFFF` | `#2B2B2BFF` | Sheet 内卡片，始终不透明 |
| `glassButtonTint` | `#F8F8F8FF` | `#3E3E3EFF` | 无法模糊时的按钮实色 |

有效模糊路径中，表面 alpha 乘以 `0.2 + 0.8 × frost`；提亮不随 frost 改变。嵌套按钮采样父玻璃的绘制结果，不能直接采样父层下面的线程。无有效 backdrop 或关闭玻璃时走不透明降级，不使用这组半透明表面色。

「模糊程度」是连续滑块，默认 0.5；验收取 0、0.25、0.5、0.75、1 五个采样点。模糊半径随控件面积平方根变化，满档限制为 1.5–16 dp，乘以 frost 后最低为 0.5 个物理像素，确保清透端仍在真实模糊。原生侧栏底栏的 RenderEffect 与顶部渐变使用各自半径，不随此滑块变化。

## 开关与按压

| 参数 | 数值 |
| --- | --- |
| 轨道 | 63 × 28 dp |
| 静止滑块 | 37 × 24 dp，内缩 2 dp |
| 按住滑块 | 整体等比放大到 1.5 倍 |
| 滑块位移弹簧 | dampingRatio 0.68，stiffness 520 |
| 玻璃按压弹簧 | dampingRatio 0.55，stiffness 450 |
| 普通玻璃控件放大 | 长边增加 10 dp，比例上限 24%，X/Y 同比 |

开关可点按或水平拖动，垂直拖动让给父滚动区域。Android 13+ 且所在面板玻璃有效时，按住的滑块用轨道 backdrop、轻微模糊和透镜；否则保持不透明白色，不额外录制轨道。`pressedScale=0.96` 是保留的旧 token，当前液态按压不使用它，不应据此恢复缩小效果。

## 描边

- 模糊路径：Kyant 高光宽 1 dp、模糊 1 dp、角度 90°，浅 / 深 alpha 0.6 / 0.45；外面再绘制 0.5 dp 边缘。
- 实色 / 原生模糊路径：1 dp 竖向渐变高光，上下亮、中间透明，再叠相同外缘。
- 外缘两端用 `glassRimEnds`（浅 `#00000033` / 深 `#00000099`），中间用 `glassRimMiddle`（浅 `#00000011` / 深 `#00000014`）；深色区限于圆角，不能按整个面板宽度拉伸。
- 突出按钮走独立的不透明主色与 1 dp 渐变边缘路径。它不代表浅色灰色立体高光已完成对齐。
- iOS 对比度交给系统，不同步 Android 的自定义着色方案到 iOS。
