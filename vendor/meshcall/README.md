# meshcall（vendored）

v3 的设备连接与本机 Router 依赖 MeshCall `main` 的提交 [`ce14d60743c2c6d5c2d504da02748de271ed8769`](https://github.com/t4wefan/meshcall/tree/ce14d60743c2c6d5c2d504da02748de271ed8769)（简称 ce14d60）：该提交包含 Swift 和 JVM SDK，并提供端到端加密隧道。0.4.0 还没有发版，所以 TS 包放在这里，由仓库里的各个 TS 子项目共用同一份（`docs/v3/10-development-plan.md` M1：「meshcall 0.4.0 已发版或 vendored 方案已定」）。

**0.4.0 发版后换回 npm 依赖，并删除本目录。**

## 文件

| 文件 | 说明 | sha256 |
| --- | --- | --- |
| `meshcall-0.4.0-dev.ce14d60.tgz` | ce14d60 的 `meshcall-ts/` 构建出的 npm 包，版本号 `0.4.0-dev.ce14d60` | `d6b5acc412852b01744c60d70c3fe74adcb5f3340357fd1da31d96dcd6e6971b` |
| `LICENSE` | MeshCall 的 MIT 许可证（与包内 `package/LICENSE` 相同） | — |

Python 端（Server）不使用本目录：`server/pyproject.toml` 用 uv 的 git 依赖钉在同一个提交，`subdirectory = "meshcall-py"`，两边版本一致。

## 使用

在子项目的 `package.json` 里写相对路径，例如 `connector-ts/`：

```json
"dependencies": {
  "meshcall": "file:../vendor/meshcall/meshcall-0.4.0-dev.ce14d60.tgz"
}
```

不要提交 lockfile（仓库规则）。

## 重新构建

下面的步骤能得到与本目录**逐字节相同**的 tgz（2026-11-16 用该提交的 `meshcall-ts/` 源码验证过，sha256 同上）：

```bash
git clone https://github.com/t4wefan/meshcall.git && cd meshcall
git checkout ce14d60743c2c6d5c2d504da02748de271ed8769
cd meshcall-ts
npm pkg set version=0.4.0-dev.ce14d60
corepack yarn@1.22.22 install --frozen-lockfile
./node_modules/.bin/tsc -p tsconfig.json
npm pack --ignore-scripts
shasum -a 256 meshcall-0.4.0-dev.ce14d60.tgz
```

`npm pack --ignore-scripts` 跳过包里的 `prepack`（它调用全局 `yarn build`），构建由上一行的 `tsc` 完成，产物相同。

## Router 二进制

v3 Connector 安装包里带的 Router 由 `connector-ts/scripts/fetch-router.mjs` 从同一个提交的 `meshcall-router/` 构建，二进制不提交进仓库：

- 构建是可复现的：`-trimpath`、不写 VCS 信息和 build id、关闭 CGO，并通过 `GOTOOLCHAIN` 固定 Go 工具链版本。六个平台（darwin、linux、win32 各有 arm64 和 x64）的 sha256 记录在 `connector-ts/scripts/meshcall-router.json`，构建或取用时逐个校验，不一致就删掉产物并报错。
- CI（`.github/workflows/connector-ts.yml`）构建全部六个平台，作为 `meshcall-router` 构建产物上传；集成测试使用其中的 linux-x64 版本。
- 本地开发构建本机平台：`cd connector-ts && node scripts/fetch-router.mjs`。
- 使用已下载的 CI 产物：`node scripts/fetch-router.mjs --from <目录> --all`。
- 换 meshcall 提交或 Go 版本时，先改清单里的 `commit` 和 `go`，再运行 `node scripts/fetch-router.mjs --record --all`，并在 PR 里审阅 sha256 的变化。
