# SpecRune「任务」屏 · iOS 实现

手机端只读任务看板。数据来自工作设备上的 `.specrune/` 与本地 `specrune` CLI，经官方 Server **既有**端点取得——Connector 与 Server 都无需改动。字段结构见 [contracts/specrune/1.0](../../contracts/specrune/1.0/README.md)。

## 文件

| 文件 | 内容 |
| --- | --- |
| [ios/Packages/SpecRuneKit/](../../ios/Packages/SpecRuneKit/) | 独立 SPM 包：`DTO.swift` / `Errors.swift` / `Transport.swift` / `SpecRuneClient.swift` |
| [SpecRuneConnectorTransport.swift](../../ios/Agents%20Anywhere/Agents%20Anywhere/Views/SpecRune/SpecRuneConnectorTransport.swift) | 把 `shell/exec` 与 `fs/readText` 桥成 `SpecRuneTransport` |
| [SpecRuneBoardModel.swift](../../ios/Agents%20Anywhere/Agents%20Anywhere/Views/SpecRune/SpecRuneBoardModel.swift) | 逐项加载态（项目探测 / 任务列表 / 详情 / 规范正文） |
| [SpecRuneTasksView.swift](../../ios/Agents%20Anywhere/Agents%20Anywhere/Views/SpecRune/SpecRuneTasksView.swift) | 三栏自适应看板 + 任务行 + 任务详情 |
| [render-specrune-mock.swift](../../ios/scripts/render-specrune-mock.swift) | CLI 静态设计稿渲染脚手架（评审用，不参与 App） |

## 设计稿

- iPhone（单栏）：`tasks-iphone.png`
- Duo 内屏（三栏）：`tasks-duo-inner.png`

## 取数路径

| 需要的数据 | 端点 |
| --- | --- |
| 任务列表 / 摘要 | `POST /connectors/{id}/shell/exec?root=` 跑 `specrune task list --json --all`、`task show <ref> --json` |
| 文档正文（prd/design/implement/record/research） | `POST /connectors/{id}/fs/readText?root=` |
| 项目是否 SpecRune、`.version`、会话↔任务关联 | 同上 `fs/readText` |

要点：

- 文档按 CLI 的 `hasPrd`/`hasDesign`/`hasImplement` 门控读取，不存在的文档不发请求；record/research 无标志，试读并容错。
- 缺文件的真实状态码是 **502**（Connector 抛 `FileNotFoundError` → Server 包成 `ConnectorUpstreamError`），不是 404，所以 `isMissingFile` 两种都认。
- 任务列表必须带 `--all`（默认限流 20 条）；`shell.exec` 的 stdout 上限 64 000 字符，超限按错误提示。
- CLI 定位顺序：`PATH` 上的 `specrune` → 回退 `$HOME/.dsh/specrune/bin/specrune`。

## 布局（swiftui-iphone-duo · Tier 1，全部为通用自适应）

- **`NavigationSplitView` 三栏**：项目侧栏 / 任务列表 / 详情。compact 自动合成单栈，regular（Duo 内屏 regular×regular）显示三栏。
- **绝不按设备判定**：无 `UIDevice` / `UIScreen.main` / idiom / orientation / `isDuo`。宽度只来自容器行为。
- **不拉伸正文**：详情正文 `maxWidth 700`；多出的宽度给三栏结构，而非更长的行。
- **fold-safe**：重要内容按列分布，不居中跨中缝。

## 动效（apple-design）

- 详情切换与规范展开用 `.spring(response: 0.35, dampingFraction: 1.0)`（critically damped，无过冲），从当前值起、可中断重定向。
- `accessibilityReduceMotion` 时全部退化为 `nil`（直接显隐）。
- 列表 selection 高亮由系统提供（按压即时反馈）。

## 验证状态

- `cd ios/Packages/SpecRuneKit && swift build` → exit=0。
- `xcodebuild build -scheme "Agents Anywhere" -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO` → exit=0。
- `git status --short connector/ server/` → 空（零改上游）。
- **未做**：真机 / iPhone Duo 模拟器实跑。折叠态、竖向 toolbar 摆放、实际渲染需在 Device Hub 复核。
