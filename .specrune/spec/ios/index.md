# iOS Layer Spec

> 该层记录 iOS 客户端（`ios/`）的代码契约。无单测设施（scheme 无 test
> action），验证 = 双 destination 构建 + 模拟器/真机人工验收。

## Files

| File | Topic |
|------|-------|
| [duo-layout.md](./duo-layout.md) | 折叠屏（iPhone Duo）机型判断与宽屏布局契约 |
| [textual-vendor.md](./textual-vendor.md) | Textual 库 vendor 状态与上游对照 |
| [upstream-sync.md](./upstream-sync.md) | 同步上游 main 的冲突处置与合并校验 |

## Quick Rules

- 机型判断统一用 `isDuoFoldableIPhone`（ChatControlMetrics.swift），
  不要再写第二份 utsname/SIMULATOR_MODEL_IDENTIFIER 判断。
- 改宽度前先读 duo-layout.md 的"三层宽度约束"清单。
- 动 Textual 前先读 textual-vendor.md——本地是 vendor 定制版，
  升级须手动合并并保留性能定制。
- `ios/Packages/` 下除 Textual 外还有本地扩展包 `SpecRuneKit`（SpecRune 任务
  看板的数据层，零依赖，经 `SpecRuneTransport` 由主 app 注入传输）。新增此类
  包要在 `Agents Anywhere.xcodeproj` 加 `XCLocalSwiftPackageReference`，包的
  `platforms` 必须与 target 的 `IPHONEOS_DEPLOYMENT_TARGET` 一致（否则报
  "module has a minimum deployment target of …"）。
- 改 `SessionChatView` 这类大体量 SwiftUI body 前注意：body 表达式再加
  任何内容就可能触发 "unable to type-check in reasonable time"。对策是把
  子树/修饰链提取为私有方法或 ViewModifier（现有 timelinePane/bottomDock/
  applyBehaviors 即为此拆分），不要往 body 里内联新表达式。
- Duo/折叠屏相关改动先读 duo-layout.md（机型判断、双屏契约、
  arrangement Swift 化名、真机部署命令）。
- 图标一律用 `AppSymbol`（资产映射）：本项目环境 `Image(systemName:)`
  完全不渲染（2026-10-26 两轮实测空白，全仓无先例）。
- 改输入行（加/挪按钮）先读 duo-layout.md 的"ComposerLayout 多按钮
  排布契约"——声明顺序即视觉顺序，宽度公式自动适配。
- 给 struct 加属性后调用点报 "argument 'X' must precede argument 'Y'"：
  memberwise init 的参数顺序 = 属性声明顺序（2026-10-26 ChatComposerDock
  连环两轮）。新属性插到声明列表哪个位置，调用点的实参就得跟着挪到哪。
- 同步上游 main 前先读 upstream-sync.md——pbxproj 取我们侧（签名）、
  xcstrings 程序化 union、合并后必须树级比对（自动合并会追加重复方法）。
