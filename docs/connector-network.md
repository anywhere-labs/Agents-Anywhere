# Connector 网络

Connector 连接服务器时有三类连接：接口请求（认证、上传会话）、后端实时连接、终端中继。它们走同一条路径，由这里的规则决定。Agent Runtime 自己的网络（例如 Claude Code、Codex 访问模型服务）不受这些设置影响。

## 如何选择路径

优先级从高到低：

1. 服务器在本机（`localhost`、`127.0.0.1`、`::1`）：始终直连。
2. `AA_CONNECTOR_PROXY` 环境变量。Desktop 和 DSH 插件的「Connector 网络」设置就是通过它生效的。
3. `connector.json` 的 `proxy` 字段，供不经过 Desktop 或插件运行的 Connector 使用。
4. 未设置时跟随系统，顺序是：
   1. `NO_PROXY` 覆盖了服务器地址：直连。
   2. `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 环境变量。
   3. 系统代理设置（macOS 网络设置、Windows Internet 选项）。服务器在系统代理的例外列表里则直连。
   4. 都没有：直连。

第 2、3 项的取值：`system`（跟随系统）、`direct`（直连）或代理地址（`http://`、`https://`、`socks5://`、`socks5h://`）。

几条容易误解的规则：

- 连 `https` 服务器时不会使用只配置给 `http` 的代理，这和 curl 一致。
- 只设置 `NO_PROXY` 不会关闭系统代理，它只决定哪些地址不走代理。
- 系统代理指向本机端口但该端口没有监听（代理软件已退出而系统开关还开着）时，Connector 改为直连并记录警告。远程代理和超时不会触发这个回退，因为有些网络不允许直连。
- 系统代理设置会在 Connector 每次重连服务器时重新读取，修改后不需要重启。
- `NO_PROXY` 支持 `example.com`、`.example.com`、`*.example.com`、`host:端口`、IP、CIDR 和 `[::1]`。无法识别的条目会被跳过并记录警告。

## 已知限制

- **不支持 PAC 自动配置**。Python 无法执行 PAC 脚本，使用 PAC 的网络在「跟随系统」下可能走直连。请在「Connector 网络」里选择自定义代理并填写地址。
- 不支持 SOCKS4。

## 排查

Connector 启动和路径变化时会写一行日志，`source` 说明路径是由哪项设置决定的：

```text
connector egress server=https://web.agents-anywhere.com proxy=http://127.0.0.1:7890 source=system-proxy
```

| source | 含义 |
| --- | --- |
| `loopback` | 服务器在本机 |
| `env`、`env-direct` | `AA_CONNECTOR_PROXY` 指定了代理、直连 |
| `config`、`config-direct` | `connector.json` 指定了代理、直连 |
| `no-proxy` | `NO_PROXY` 覆盖了服务器 |
| `env-proxy` | 来自代理环境变量 |
| `system-proxy` | 来自系统代理设置 |
| `system-bypass` | 服务器在系统代理的例外列表里 |
| `system-proxy-down` | 本机代理端口没有监听，已改为直连 |
| `system-none` | 没有配置任何代理 |

上传很慢或同步反复失败时，可以先对比「跟随系统」和「直连」：部分本地代理转发大请求的速度只有直连的几十分之一。

## 证书

Connector 校验服务器证书的方式：

- macOS、Windows：使用系统证书库，公司网络自行安装的根证书也会被信任。
- Linux：使用系统证书目录，并附加随 Connector 安装的证书包。
- 设置了 `SSL_CERT_FILE` 或 `SSL_CERT_DIR` 时，以它们为准。

如果日志提示 `certificate for <host> was rejected`，先用浏览器访问同一地址确认服务器证书是否正常；浏览器正常时，通常是本机证书库缺少或过期了对应的根证书。
