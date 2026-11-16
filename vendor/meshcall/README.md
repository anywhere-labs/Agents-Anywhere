# meshcall（vendored）

v3 的设备连接与本机 Router 依赖 MeshCall `main` 的提交 [`93344059ada65735c6cc08fdf3247ea9fb808d6b`](https://github.com/t4wefan/meshcall/tree/93344059ada65735c6cc08fdf3247ea9fb808d6b)（简称 9334405）：Router token 带 `instance_ids`，续期与吊销有对应的关闭码。0.4.0 还没有发版，所以 TS 包放在这里，由仓库里的各个 TS 子项目共用同一份（`docs/v3/10-development-plan.md` M1：「meshcall 0.4.0 已发版或 vendored 方案已定」）。

**0.4.0 发版后换回 npm 依赖，并删除本目录。**

## 文件

| 文件 | 说明 | sha256 |
| --- | --- | --- |
| `meshcall-0.4.0-dev.9334405.tgz` | 9334405 的 `meshcall-ts/` 构建出的 npm 包，版本号 `0.4.0-dev.9334405` | `54da9d301b21d920e285f313635e0225efe1c511cfb83629459d7eccd567ecca` |
| `LICENSE` | MeshCall 的 MIT 许可证（与包内 `package/LICENSE` 相同） | — |

Python 端（Server）不使用本目录：`server/pyproject.toml` 用 uv 的 git 依赖钉在同一个提交，`subdirectory = "meshcall-py"`，两边版本一致。

## 使用

在子项目的 `package.json` 里写相对路径，例如 `connector-ts/`：

```json
"dependencies": {
  "meshcall": "file:../vendor/meshcall/meshcall-0.4.0-dev.9334405.tgz"
}
```

不要提交 lockfile（仓库规则）。

## 重新构建

下面的步骤能得到与本目录**逐字节相同**的 tgz（2026-11-16 用该提交的 `meshcall-ts/` 源码验证过，sha256 同上）：

```bash
git clone https://github.com/t4wefan/meshcall.git && cd meshcall
git checkout 93344059ada65735c6cc08fdf3247ea9fb808d6b
cd meshcall-ts
npm pkg set version=0.4.0-dev.9334405
corepack yarn@1.22.22 install --frozen-lockfile
./node_modules/.bin/tsc -p tsconfig.json
npm pack --ignore-scripts
shasum -a 256 meshcall-0.4.0-dev.9334405.tgz
```

`npm pack --ignore-scripts` 跳过包里的 `prepack`（它调用全局 `yarn build`），构建由上一行的 `tsc` 完成，产物相同。
