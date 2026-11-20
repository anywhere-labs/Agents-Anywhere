# 移动端 PoC 的加密连接

在仓库根目录运行 `sh vendor/meshcall/prepare-mobile-sdk.sh` 安装锁定版本的 SDK。Swift 和 Kotlin 客户端由 `sh v3poc/generate-content-clients.sh` 从 [跨端契约](../contracts/device-meshcall/1.0/README.md) 生成。

## 使用

1. 在自托管 Server 启用 `AGENT_SERVER_E2EE=required`，为 Server 和 MeshCall Router 配置可信 TLS。
2. 打开 Android 或 iOS PoC，填入 Server 的 HTTPS 地址，用账号邮箱和密码登录。
3. 在设备列表选择 Connector。粘贴电脑端生成的 `aa-pair://…` 链接，然后点「打开工作区」。Android 也可点「扫描配对二维码」，用摄像头读取 Desktop「设置 → 安全连接」中显示的二维码。已配对的设备可以直接打开工作区。
4. 从侧栏打开或新建会话。在输入框的选项中可以添加附件、查看设备文本文件或运行终端。

账号令牌、最近打开的设备和配对记录由 Android Keystore 或 iOS Keychain 保护。应用重启后会自动恢复登录并尝试打开最近使用的设备。设备换钥时，先在电脑上核对新公钥，再在手机上忘记本机配对并使用新链接。打开会话后遇到断线，客户端保留当前已加载的内容，重连后刷新；重新启动应用后需要连到设备才能加载历史。关闭工作区可回到设备列表，退出登录会清除本机登录并撤销该登录的 Router 票据。

Desktop「设置 → 安全连接 → 已授权客户端」可以按指纹选择并撤销一部手机。Android PoC 也可以在设备页点「解除配对」，电脑确认后清除本机凭据。电脑离线时可点「仅忘记本机配对」，之后仍可在电脑上撤销对应授权。手机正在使用工作区时，收到电脑的撤销通知会回到配对页；手机离线时会在恢复连接、确认原凭据失效后提示重新扫码。两种情况都保留账号登录。

## 传输

HTTPS 负责账号登录和引导领票。原生客户端通过加密的 `MobileControl/read_directory` 读取设备、项目、会话和 Agent 目录，并通过加密的 `MobileControl/issue_content_tunnel` 为选中的设备申请短期票据，并以在配对链接中核验的 Connector 公钥建立独立的内容隧道。Connector 在解封请求后检查本机授权。Server 和 Router 只接触路由和管理数据，附件经过独立密封后暂存，密钥随加密消息直达 Connector。WebView 只使用原生桥接接收渲染数据。

## 调试

Debug 包允许本机回环 HTTP 和 WebSocket。Android 启动时传入 `--ez demo true`，iOS 设置 `AA_POC_DEMO=1`，可以启动内置演示。压测启动参数也会启用演示。Debug 包可使用应用私有容器中的 `content-profile.json` 自动化回归，iOS 路径为 `Library/Application Support/`，Android 为 `files/`。联调文件包含 `serverUrl`、测试账号的 `accessToken`、首次使用的 `pairingUri` 和采用 [演示工作区](fixtures/workspace.json) 结构的 `workspace`，使用后应移除。
