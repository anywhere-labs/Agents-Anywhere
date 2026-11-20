# 上游同步（merge origin/main）操作契约

来源：2026-10-29 首次全量同步（29 提交）实战。冲突面通常只有 2-3 个
文件，但每个都有"想当然就坏"的坑。

## 合并前

```bash
git fetch origin && git rev-list --count main..origin/main
BASE=$(git merge-base main origin/main)
comm -12 <(git diff --name-only $BASE main | sort) \
         <(git diff --name-only $BASE origin/main | sort)
```

双方都改过的文件就是冲突面（实测仅 3 个）；`commands.ts` 等自留分叉
上游没动则零风险。

## 冲突处置矩阵

| 文件 | 处置 | 原因 |
|---|---|---|
| `project.pbxproj` | **取我们侧** | `DEVELOPMENT_TEAM=85V4S34K64` 是真机签名，取上游的直接坏；build 号差异无碍 |
| `Localizable.xcstrings` | **程序化 union**：`git checkout --theirs` 后用 Python 取上游 JSON 为底、把仅我们有的键 merge 回去、按键排序、`json.load` 验证 | 手工去 `<<<<<<<` 标记必坏 JSON（两侧条目在冲突块内交错截断，实测）；不要字符串拼接 |
| `.specrune/spec/**` 等 add/add | 逐个看：通常一侧是旧中间态，取最新线 | — |

### 版本字段（2026-11-13 补）

pbxproj「取我们侧」只适用于签名与部署目标；`MARKETING_VERSION` /
`CURRENT_PROJECT_VERSION` 必须跟上游。2.2.0 同步时上游把两者从
2.1.0/10 升到 2.2.0/12，整文件取我们侧会让 iOS 版本号落后于其他端。
合并后跑一遍版本表：iOS、`dsh-bridge-next`、`web-next`、
`desktop-workbench`、Android、`connector`、`server` 应同为 MINOR 版本。

### xcstrings 排序（2026-11-13 补）

本地 `Localizable.xcstrings` 在 union 后按码点全量排序，与 Xcode 写入
顺序不同，因此与上游的 diff 会有上万行「纯重排」。这是契约行为，不要
当成坏合并去回退；判断正确性看键集合（上游键全在 + 仅本地键）和
`json.load`，不要看行数。

## 自动合并 ≠ 正确（必做校验）

git 对 `commands.ts` "自动合并成功"却**追加了第二个旧版 `executeSkill`**
（重复方法定义，TS 编不过）。合并提交后必须：

```bash
git diff <source-branch> main --stat   # 预期 0 行或可解释的差异
```

树级比对抓重复定义/坏合并，再跑全套检查（dsh `yarn check`、connector
pytest、iOS 双 destination 构建）。探针集成测试首跑偶发 1-2 个时序
抖动，复跑定性。

## 已知环境干扰

- **开着 Xcode 会反复删 `Package.resolved`**（工作树出现 ` D` 删除）：
  `git checkout --` 恢复即可；命令行构建期间尽量不开 Xcode，或接受
  每次收尾时恢复一次。

## 同步后真机验收

上游 iOS 改动（如 #449 模型分组）装真机过一眼对应界面；两台设备
UDID 见 duo-layout.md 真机部署节。

**构建通过 ≠ UI 正确，静态页面 ≠ 交互验证**：上游 iOS 代码经常没有编译
验证（#490 提交信息三处写明"iOS 未在 Xcode 中编译验证"）。除静态页面外，
必须**点开交互式浮层**：指令面板（⌘）、模型/权限菜单、附件面板、计划确认
面板。2026-11-20 就是 #490 的常驻 `.clipped()` 让指令面板整块消失而构建
全绿（issue #795）。模拟器上的截图/读树/点击方法见 duo-layout.md
"模拟器 UI 验证"节。
