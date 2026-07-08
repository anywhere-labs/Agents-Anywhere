# macOS 签名、公证和 DMG 构建说明

这个文档说明如何在本地或 CI 上构建可分发的 macOS DMG。

目标产物是已经完成以下步骤的 DMG：

- 使用 Developer ID Application 证书签名 `.app`
- 提交 `.app` 到 Apple Notary Service 公证
- staple `.app` 的公证票据
- 生成 DMG
- 提交 DMG 到 Apple Notary Service 公证
- staple DMG 的公证票据

## 前置条件

构建机器需要满足这些条件：

- macOS
- Xcode Command Line Tools
- Node.js 22
- Yarn 4
- 可用的 Apple Developer 账号
- Developer ID Application 证书对应的 `.p12`
- Apple ID app-specific password

进入桌面端目录后建议先切 Node 版本：

```bash
cd desktop-next
nvm use
```

## 必需环境变量

构建脚本会检查这些环境变量：

```text
MAC_CERT_P12_BASE64
CSC_KEY_PASSWORD
MACOS_SIGN_IDENTITY
APPLE_TEAM_ID
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
```

含义：

```text
MAC_CERT_P12_BASE64        Developer ID Application .p12 文件的 base64 内容
CSC_KEY_PASSWORD           .p12 文件密码
MACOS_SIGN_IDENTITY        Developer ID Application 身份名称
APPLE_TEAM_ID              Apple Developer Team ID
APPLE_ID                   Apple ID 邮箱
APPLE_APP_SPECIFIC_PASSWORD Apple ID 的 app-specific password
```

`MAC_CERT_P12_BASE64` 可以从 `.p12` 生成：

```bash
base64 -i developer-id-application.p12 | tr -d '\n'
```

不要把这些值写进 Git。可以放在本机 shell 环境、CI secret，或本地未追踪的 `.env` 文件里。如果放在仓库目录内，必须确保它被本机 `.git/info/exclude` 或 `.gitignore` 忽略。

本地开发时可以这样加载：

```bash
set -a
source /path/to/macos-signing-secrets.env
set +a
```

## 一条龙构建命令

在 `desktop-next` 目录执行：

```bash
yarn dist:mac:signed
```

默认输出目录：

```text
desktop-next/release/
```

最终 DMG 形如：

```text
desktop-next/release/Agents Anywhere Connector Next-0.1.7-2-arm64.dmg
```

如果想输出到单独目录，避免覆盖已有 `release/`，可以使用：

```bash
MACOS_RELEASE_OUTPUT_DIR=release-slim yarn dist:mac:signed
```

此时最终 DMG 形如：

```text
desktop-next/release-slim/Agents Anywhere Connector Next-0.1.7-2-arm64.dmg
```

## 脚本实际做了什么

脚本位置：

```text
desktop-next/scripts/dist-mac-signed.mjs
```

执行流程：

1. 检查必需环境变量。
2. 从 `MAC_CERT_P12_BASE64` 解码 `.p12` 到临时目录。
3. 创建临时 keychain。
4. 把 Developer ID Application 证书导入临时 keychain。
5. 在临时 keychain 中创建 Apple notary profile。
6. 执行 `yarn bundle:uv`，把当前平台的 `uv` 放进 `build/uv`。
7. 执行 `yarn build`，生成 Next.js 静态产物 `out/`。
8. 执行 `electron-builder`，生成并签名 `.app`。
9. electron-builder 提交 `.app` 公证并 staple。
10. 生成 DMG。
11. 脚本再提交本次生成的 DMG 公证。
12. staple 并 validate DMG。
13. 清理临时 keychain 和临时证书文件。

脚本不会把 `APPLE_APP_SPECIFIC_PASSWORD` 直接传给 electron-builder 子进程，而是先创建 notary keychain profile，再通过 `APPLE_KEYCHAIN` 和 `APPLE_KEYCHAIN_PROFILE` 传递给 electron-builder。这样可以避免密码出现在本机 `ps` 命令行参数里。

## 为什么 dependencies 是空的

`desktop-next/package.json` 里 `dependencies` 应该保持为空。

原因是桌面端运行时加载的是 Next.js 构建后的静态文件 `out/`，React、Next、Tailwind、Radix 等依赖只在构建阶段使用，不应该作为 production `node_modules` 打进 `.app`。

如果把这些依赖放在 `dependencies`，electron-builder 会把 production `node_modules` 自动打进 app，导致：

- `.app` 体积变大
- DMG 体积变大
- codesign 文件更多
- 提交 Apple 公证的 zip 更大
- 公证耗时更不稳定

如果以后 Electron 主进程真的需要某个 npm 包运行，例如 `require("xxx")`，才应该把那个包放进 `dependencies`。

## 验证命令

构建完成后可以验证 `.app`：

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Agents Anywhere Connector Next.app"
spctl -a -vv --type execute "release/mac-arm64/Agents Anywhere Connector Next.app"
xcrun stapler validate "release/mac-arm64/Agents Anywhere Connector Next.app"
```

验证 DMG：

```bash
spctl -a -vv --type open --context context:primary-signature "release/Agents Anywhere Connector Next-0.1.7-2-arm64.dmg"
xcrun stapler validate "release/Agents Anywhere Connector Next-0.1.7-2-arm64.dmg"
```

验证内置 `uv` 是否被 Developer ID 签名：

```bash
codesign -dv --verbose=4 "release/mac-arm64/Agents Anywhere Connector Next.app/Contents/Resources/uv/darwin-arm64/uv"
```

如果使用自定义输出目录，把上面的 `release` 替换为对应目录，例如 `release-slim`。

## 常见问题

### 公证卡在 In Progress

Apple 官方常见情况是几分钟内完成，但实际可能受 Apple 队列、账号状态、包大小和网络影响。先用 `notarytool history` 或 `notarytool info` 确认 submission 是否已经在 Apple 侧创建。

如果 Apple 返回 `In Progress`，并且 submission 已经创建，通常不是本地 codesign 卡住，而是 Apple 侧还没有处理完。

### 提示 app 已损坏

优先检查：

- `.app` 是否用 Developer ID Application 签名
- `.app` 是否已经 notarized
- `.app` 是否已经 stapled
- DMG 是否也已经 notarized 和 stapled
- 嵌套可执行文件是否被签名，例如 `Resources/uv/darwin-arm64/uv`

### 不要把运行时复制到 UserData 解决签名问题

Gatekeeper 的“已损坏/无法打开”发生在 app 启动前，不能靠启动后把文件复制到 `userData` 根治。正确方向是把 `.app`、嵌套可执行文件和最终 DMG 都签名、公证、staple 完整。

### 版本号格式

electron-builder 要求 `package.json` 的 `version` 是合法 semver。不要使用类似 `0.1.7.2` 的四段版本；可以使用 `0.1.7-2`。
