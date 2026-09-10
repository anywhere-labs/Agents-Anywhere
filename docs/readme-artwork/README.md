# README 图片

README 使用 AA 官网的纯色黑白视觉和真实产品截图，参考 DSH Desktop 的图文阅读顺序。文案面向开源仓库，优先说明项目定位、能力、使用和开发入口。图像针对 GitHub 正文宽度重新排版；没有生成、翻译或改写截图内的产品 UI。

## 品牌规则

- **Wordmark 表示 Agents Anywhere 品牌与项目。** 使用 Caveat、500 字重、原始字距，保持完整名称，不做拉伸或重新描绘。
- **Icon 只在明确指代 App 时使用。** 不作为项目名称前的装饰，不与 wordmark 组合或并排出现。
- README 主视觉只有 wordmark，没有额外 App icon。截图里原本存在的 App 图标属于真实界面，保持原样。
- 正文使用普通文本书写产品名称；不要把每次品牌提及都替换成图片，也不在下载表的每一行重复放 icon。
- 历史 `docs/brand/agents-anywhere-wordmark-*.png` 实际包含 icon 与文字组合，不用于本次 README 或新的品牌展示。

## 文件与来源

| 输出 | 内容 |
| --- | --- |
| `../images/readme-hero-zh.webp` / `readme-hero-en.webp` | 小尺寸独立 wordmark、双语标题、Agent 图标与名称、后续支持提示，以及 MacBook 与 iPhone 的真实产品界面。 |
| `../images/readme-workbench.webp` | Windows 的项目、会话和任务结果界面。 |
| `../images/readme-mobile.webp` | iPhone、iPad 与 Android 的跨端组合。iPad 内容是用户输入请求，不是工具权限审批。 |

输入来自相邻工作区的 [AA-landingpage](https://github.com/Bensonwang-owl/AA-landingpage)，原始来源和 SHA-256 记录在 `provenance.json`。`sources/` 保留本次使用的完整输入，复现不依赖相邻仓库或开发机的目录结构。截图文字和状态属于拍摄时刻，不代表每个 Runtime 支持相同的功能。

MacBook、iPhone、iPad 图片沿用官网已合成的 Apple 设备展示图。设备边框来源与适用条款见官网仓库的 `assets/README.md`（Apple Design Resources）；这些成品不作为可复用设备边框库分发，不应将第三方设备素材理解为本项目 MIT 授权的范围。没有复制独立 Apple 边框源文件。Windows 和 Android 保留原始截图比例。Caveat 字体及其 SIL Open Font License 一并保留在 `sources/`。

Agent 标识沿用官网 `public/agents/` 的 Codex、Claude Code 与 DeepSeek Harness SVG，用于说明相应工具的兼容支持；名称与图形归各自权利人。来源细节见官网仓库 `assets/README.md`。后续支持使用“更多 Agent，即将支持 / More agents coming soon”表达，不将尚未支持的工具列为已支持。

## 离线渲染

需要 Node.js 22+、Corepack/Yarn 和 Chromium。首次准备依赖：

```bash
cd docs/readme-artwork
corepack yarn install
corepack yarn exec playwright install chromium
```

之后渲染：

```bash
corepack yarn render
```

有本地 Chrome 时可用 `CHROME_PATH=/path/to/chrome corepack yarn render`，macOS 上也会自动识别标准 Google Chrome 路径。安装阶段需要网络；渲染阶段只使用内嵌的本地图片、字体，不启动服务，也不连接产品或第三方网站。

输出直接写入 `docs/images/`。单张图为 1800 像素宽，正文以 `width="100%"` 显示，GitHub 在浅色和深色主题下使用同一块深色画布。可检查被 Git 忽略的 `preview/` HTML，并在提交前检查截图显示、留白、裁切以及图像体积。
