# Desktop Connector 环境准备与恢复

Desktop 的本地启动分为独立的环境准备、RPC 启动、ownership 获取三个步骤。依赖安装使用 `uv sync --project …`；只有安装成功并保存环境指纹后，才使用 `uv run --no-sync --project … anywhere-cli rpc …`。RPC 就绪与 ownership 获取各使用 10 秒超时，依赖安装不计入 RPC 超时。

环境状态为 `unknown / checking / preparing / ready / stale / failed / cancelled`。准备中界面展示解析、下载、构建、同步阶段、包名、uv 实际报告的大小或依赖数量，以及最近输出。安装没有固定总时限；连续两分钟未检测到输出或文件活动时，界面提示可能卡住，任务仍可继续。uv 自身的单次网络请求超时仍然有效。

- 网络失败：在启动界面切换 PyPI 或 Python 镜像，再重试。
- 解析失败：查看原始冲突信息；重复下载不会解决版本约束冲突。
- 权限或磁盘错误：根据日志中的路径恢复读写权限或释放空间，再重试。
- 安装无活动：查看日志，或取消后切换镜像。取消会停止整个安装进程组，等待停止后再允许重新开始。
- 环境损坏：选择“清理环境并重新下载”。保留 Connector 凭据和绑定；开发模式保留共享 uv 缓存，只清理能识别为虚拟环境的目录。安装包模式同时清理 Desktop 自己的 uv 缓存和源码副本。
- ownership 冲突：界面显示现有占用方及 PID。停止占用方后重新检查，不需要清理 Python 环境。

环境指纹保存在 Connector 数据目录下的 `.connector-environment.json`，包含源码、项目声明、实际解析的 `uv.lock`、Python 真实路径与版本、uv 版本、平台架构及安装相关环境配置的摘要。配置 URL 不写入指纹。`.connector-environment-state.json` 保存最近状态和错误。重启会重新验证指纹和环境文件，不会直接信任上次的 ready；取消或失败不会产生成功指纹，半成品环境会重新准备。

同一 Desktop 内复用正在进行的准备 Promise；跨进程通过虚拟环境旁的 `.desktop-lock` 记录持有者，在准备、RPC 运行、清理期间防止另一个 Desktop 修改环境。发现持有进程或其安装/RPC 子进程仍存活时拒绝修改，并显示占用信息；已退出的持有者记录会在下次准备时恢复。窗口隐藏时任务可继续；退出 Desktop 时停止准备和 Connector，再释放锁。

Desktop 本地 API（同现有 `/desktop-api` 鉴权）提供 `GET /environment`、`POST /environment/prepare`、`POST /environment/cancel`、`POST /environment/reset`，SSE `environment` 事件发送结构化状态及重连快照。准备和 ownership 重查是独立入口；`POST /ownership/recheck` 在需要时先等待准备，然后启动 RPC 并获取 ownership。此接口不修改 Server 或 Connector Runtime 协议。
