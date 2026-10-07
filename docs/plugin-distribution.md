# DSH 插件分发与升级规范（dsh-bridge-next）

本文档规定 `@agents-anywhere/dsh-bridge-next`（下称"插件"）通过自托管 npm tarball 分发时的地址规范、发版流程，并完整记录 2026-10 线上 `ERR_PNPM_MISSING_TARBALL_INTEGRITY` 故障的根因调研、本机复现命令序列与用户侧修复。

插件随 DSH Desktop 内置时的分发不走本规范；本规范只覆盖"独立 DSH 环境从 `https://dsh.chyu.top/downloads/plugin/` 安装 tarball"的场景。

适用读者：

- **最终用户 / 运维**：看[安装与升级](#安装与升级用户侧)与[故障修复](#err_pnpm_missing_tarball_integrity-故障修复用户侧)。
- **发版负责人**：看[发版流程](#发版流程)与[红线](#红线)。
- **排障 / 贡献者**：看[故障机理](#故障机理调研结论)与[本机复现记录](#本机复现记录)。

## TL;DR

1. **版本化 URL 是唯一推荐的安装/升级地址**：`https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz`。文件内容一经发布永久不可变。
2. 稳定名 `agents-anywhere-dsh-bridge-next.tgz` 只是"最新版指针"，发新版时被原地覆盖，且带 pnpm lockfile 陷阱（见[故障机理](#故障机理调研结论)）。**不要**把它写进任何安装/升级指引作为目标地址。
3. 发版只追加：新增版本化文件 → 覆盖稳定名指针 → `yarn release:manifest` 重写 `manifest.json`。**绝不覆盖或删除已发布的版本化文件**。
4. 命中 `ERR_PNPM_MISSING_TARBALL_INTEGRITY` 的用户按[修复命令](#err_pnpm_missing_tarball_integrity-故障修复用户侧)处理：核心是 `pnpm remove` → `pnpm add <版本化 URL>`，并**确认这次 add 真实下载了 tarball**（不是命中缓存）。

## 分发地址

托管目录 `https://dsh.chyu.top/downloads/plugin/`（源码位于仓库工作副本 `web-next/public/downloads/plugin/`；该目录被 `web-next/.gitignore` 的 `public/downloads/` 忽略，属部署产物，不进 git，由 nginx 直接映射）。

| 文件 | 角色 | 可变性 |
| --- | --- | --- |
| `agents-anywhere-dsh-bridge-next-<版本>.tgz` | 版本化安装包，**唯一推荐的安装/升级地址** | 发布后**不可变**（内容永不改动、永不删除） |
| `agents-anywhere-dsh-bridge-next.tgz` | "最新版指针"，等于最新版本化文件的逐字节拷贝 | 每次发版**原地覆盖** |
| `manifest.json` | 发布清单：`latest` 指针 + 全部历史版本的 `version / url / integrity` | 每次发版由脚本重写 |

`manifest.json` 由 [`dsh-bridge-next/scripts/write-release-manifest.mjs`](../dsh-bridge-next/scripts/write-release-manifest.mjs) 生成，结构：

```json
{
  "latest": {
    "version": "2.1.0",
    "url": "https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-2.1.0.tgz",
    "integrity": "sha512-…"
  },
  "versions": [
    { "version": "2.1.0", "url": "https://…/agents-anywhere-dsh-bridge-next-2.1.0.tgz", "integrity": "sha512-…" }
  ]
}
```

- `integrity` 与 npm/pnpm 同算法：文件字节的 sha512 → base64，前缀 `sha512-`（Subresource Integrity 格式，与 pnpm 写进 `pnpm-lock.yaml` 的 `resolution.integrity` 完全一致，可互相印证）。
- `url` 用**绝对地址**。原因：`manifest.json` 本身就是通过 `https://dsh.chyu.top/downloads/plugin/manifest.json` 被消费的，`pnpm add`、客户端更新检查器等都需要可直接使用的绝对 URL；相对路径会把"manifest 所在目录"这一隐含约定带进每个消费方。
- `latest` 取版本化文件名里语义化版本最大者（prerelease 排在同号正式版之后），**不**直接采信 `package.json` 的 version；若二者不一致脚本会打印警告（清单永远只索引**已发布**的文件）。
- 稳定名文件永不入册（内容可变，无法保证 integrity 恒真）；脚本输出字节稳定，目录内容不变时重复运行无 diff（幂等）。

## 安装与升级（用户侧）

DSH 官方入口（内部就是在 Profile 目录执行 `pnpm add <URL>`，实质等价）：

```bash
# 升级/安装到指定版本 —— 永远使用版本化 URL
dsh --profile <名> plugin add https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz
```

或直接在 Profile 目录（Windows 桌面版为 `C:\Users\<用户>\.dsh\profiles\<profile>\`）执行等价命令：

```bash
pnpm add https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz
```

查询最新版本：

```bash
curl -s https://dsh.chyu.top/downloads/plugin/manifest.json
```

> ⚠️ **不要**把稳定名 URL（`…/agents-anywhere-dsh-bridge-next.tgz`）作为安装/升级目标。它在已有 lockfile/store 的 Profile 里会触发 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`；即使侥幸装上，覆盖旧内容后也会在冷机器上制造 integrity mismatch。

## ERR_PNPM_MISSING_TARBALL_INTEGRITY 故障修复（用户侧）

**症状**（Windows DSH Desktop，Profile 原有 npm registry 安装的 `^2.0.2`）：

```text
✓ Lockfile passes supply-chain policies (verified 2d ago)
Progress: resolved 40, reused 1, downloaded 0, added 0
[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package
"@agents-anywhere/dsh-bridge-next@https://…/agents-anywhere-dsh-bridge-next.tgz(…)":
its lockfile entry has no "integrity" field, so pnpm cannot verify the downloaded tarball.
The lockfile may be corrupted or have been tampered with. Restore it from a trusted source…
```

**触发条件**（详见[故障机理](#故障机理调研结论)）：pnpm 11.4.0–11.8.x 的缺陷——当 tarball 内容**已在本机 pnpm store 缓存里**（日志特征 `downloaded 0`）时，写出的 lockfile 条目缺 `integrity`；同版本区间的 pnpm 又对"缺 integrity 的条目"fail-closed。于是**第一次** `pnpm add <稳定名>` 悄悄写坏 lockfile，**之后任意** install/add 全部报错。

### 主修复命令（本机实测有效，覆盖 pnpm 11.4.0–11.8.x 与 ≥11.9）

在**受影响的 Profile 目录**内执行。核心判据不是"稳定名还是版本化 URL"，而是**这次 add 是否真实下载了 tarball**（`downloaded ≥ 1` 而非 `downloaded 0`）。对一个此前只从 registry 或稳定名装过插件的用户，**新版本化 URL 在本机一定是冷的**，因此会真实下载 → integrity 被写回：

```bat
cd C:\Users\<用户>\.dsh\profiles\<profile>

:: 1) 移除坏依赖（pnpm ≥11.9 上此步可能因校验旧坏条目而报错退出，属预期，继续下一步）
pnpm remove @agents-anywhere/dsh-bridge-next

:: 2) 用【新版本化 URL】重装（把 <版本> 换成 manifest.json 里 latest.version）
pnpm add https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz

:: 3) 自检：lockfile 条目应带 integrity；重跑同一命令应幂等成功
findstr /C:"integrity: sha512-" pnpm-lock.yaml
pnpm add https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz
```

Linux/macOS 把 `cd`/`findstr` 换成 `cd … && …`/`grep -A1 'dsh-bridge-next@https' pnpm-lock.yaml | head -2` 即可，pnpm 命令一致。

修好后，以后所有升级都走 `dsh --profile <名> plugin add <新版本化 URL>`。

### 若第 2 步仍写出无 integrity（downloaded 0）——说明该 URL 命中了缓存

这通常发生在"之前尝试修复时已经把同一个版本化 URL 装过、内容留在 store 里"。此时先驱逐缓存再装：

```bat
pnpm remove @agents-anywhere/dsh-bridge-next
pnpm store prune
pnpm add https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz
:: 再按上面第 3 步自检
```

> ⚠️ `pnpm store prune` **不是万灵药**：store 是本机全局共享的，如果**另一个 Profile 或项目**仍引用同一插件包，prune 不会驱逐它，随后的 add 依旧 `downloaded 0` → 仍无 integrity（本机隔离 store 实测复现过这个失败）。因此：升到**全新版本**（store 里没有的版本化 URL）永远是最稳的路径；prune 只是针对"同一个已缓存 URL"的补救。

### 终极兜底：手工注入 integrity（store 无法清空时）

实测注入后 `install` / `add` 任意包 / 重复 `add` 全部恢复绿色，且后续 warm add 不再剥掉它。在 Profile 目录执行（把 `<版本>` 换成实际版本）：

```bash
node -e "const{execSync}=require('child_process');const{createHash}=require('crypto');const fs=require('fs');const url='https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<版本>.tgz';const buf=execSync('curl -fsSL '+url,{maxBuffer:1<<30});const ig='sha512-'+createHash('sha512').update(buf).digest('base64');const p='pnpm-lock.yaml';let s=fs.readFileSync(p,'utf8');const b=s;s=s.replace(/resolution: \{tarball: (https:\/\/dsh\.chyu\.top[^}]*)\}/g,'resolution: {integrity: '+ig+', tarball: $1}');if(s===b){console.error('entry not found or already has integrity');process.exit(1)}fs.writeFileSync(p,s);console.log('injected',ig)"
pnpm install
```

注入值必须与服务器文件字节一致；不确定时以 `manifest.json` 中对应版本的 `integrity` 为准（同算法，可互相印证）。

### 按 pnpm 版本的行为分支

| pnpm 版本 | 行为 | 修复 |
| --- | --- | --- |
| ≤ 10.34.x | warm store 下同样写出无 integrity 条目，但**不校验、不报错**（静默潜伏） | 无需处理；建议升级到 ≥11.9 以获得完整性保护 |
| 11.4.0–11.8.x | 本次故障根因区间：warm store add 写坏条目，且对坏条目 fail-closed | 主修复命令（第 2 步用**全新版本化 URL** 最稳）；命中缓存则加 `store prune`；仍不行则手工注入 |
| ≥ 11.9.0（11.9 / 11.20 / 12.5.1 实测） | 写入端已修复，warm store 也会计算 integrity；但**不自愈已中毒的旧 lockfile** | 在中毒条目上第一次 `add` 仍报错（exit 1）但会把条目重写成带 integrity，**第二次即成功**（"重试一次自愈"仅 ≥11.9 成立）；或直接走主修复命令 |

### 无效手段（均实测，别浪费时间）

- `pnpm install --fix-lockfile`、`pnpm install --force`、`pnpm update`：都不会补 integrity。
- `pnpm install --update-checksums`：只刷新 **registry** 来源的 integrity mismatch，非 registry tarball 仍失败（11.8.0 与 11.20.0 实测均失败）。
- 只删 `pnpm-lock.yaml` 保留 `node_modules`：pnpm 会从 `node_modules/.pnpm/lock.yaml` 恢复出同样的坏条目，照样报错。
- `pnpm remove` 后不换 URL、也不清 store，用**已缓存的**同一 URL 重 add：在 11.4–11.8 上会**再次**写出无 integrity 条目（复发，实测）。

## 故障机理（调研结论）

### 错误码语义

`ERR_PNPM_MISSING_TARBALL_INTEGRITY` 是 pnpm 的 **lockfile 校验 fail-closed**：读取 `pnpm-lock.yaml` 时，凡 `resolution: {tarball: …}`（非 registry）形态的条目缺 `integrity:` 字段即拒绝安装。这是 [GHSA-7vhp-vf5g-r2fw](https://github.com/pnpm/pnpm/security/advisories/GHSA-7vhp-vf5g-r2fw)（HTTP tarball 依赖不记 integrity → 远端可对同一 lockfile 服务不同内容）系列加固的一环。[pnpm 11.4 release notes](https://pnpm.io/blog/releases/11.4) 明确："缺少 `integrity` 字段的锁文件条目将被拒绝……`file:` 协议与 git 托管 URL（commit SHA 已锁定内容）豁免"。

### lockfile 条目缺 integrity 的产生路径（本次命中的是 ①）

1. **pnpm 11.4.0–11.8.x 的写入端缺陷（本次根因）**：https tarball 的 resolver 本身不返回 integrity——只有**实际下载**了 tarball 才能计算 sha512。当内容已在 store 缓存（`downloaded 0`）且没有可继承的旧 integrity（例如原条目是 registry 形态 `@pkg@2.0.2`，被 `pnpm add <URL>` 改写成全新 tarball 条目）时，写出的条目就只有 `{tarball: …}` 没有 integrity。下一轮校验必然 fail-closed。上游 issue：[pnpm/pnpm#12001](https://github.com/pnpm/pnpm/issues/12001)（后续 add 剥掉已有 integrity，10.34.x/11.4 复现）、[pnpm/pnpm#12185](https://github.com/pnpm/pnpm/issues/12185)、[pnpm/pnpm#14351](https://github.com/pnpm/pnpm/issues/14351)（`pnpm update` 重写 lockfile 丢 integrity）。**pnpm 11.9.0 修复**写入端（[CHANGELOG bae694f](https://cdn.jsdelivr.net/npm/pnpm@11.20.0/CHANGELOG.md#8)）：无法从 metadata 拿到 integrity 时会下载 tarball 计算并写入，`--lockfile-only` 也不例外；仍缺 integrity 的条目按 `ERR_PNPM_MISSING_TARBALL_INTEGRITY` 拒绝。实测 11.9.0 / 11.20.0 / 12.5.1 warm store 下条目均带 integrity。
2. **失败/中断操作留下的半截 lockfile**：`pnpm add` 中途被杀（DSH plugin-manager 有空闲超时终止 pnpm 的逻辑）可能留下部分写入的 lockfile，特征是条目整体缺失或字段残缺；修复同样是 remove 后重装。
3. **registry 条目 → tarball 条目改写时字段丢失**：即路径 ① 在"原从 npm registry 安装、后改用 tarball URL"场景下的具体化——正是本次 Windows Desktop profile 的形态（`package.json` 里原是 `^2.0.2`，`pnpm add <稳定名>` 把它改写成 tarball 条目）。
4. **pnpm store 缓存与 lockfile 不一致**：旧版本 pnpm 在"store 命中就不下载"路径上完全不校验/不回填 integrity（≤10.x 连报错都没有，静默写出坏条目），坏条目可潜伏到用户升级 pnpm ≥11.4 后才爆发。

### 稳定名 tarball 被覆盖（内容改变、URL 不变）的行为（实测）

- **本机 store 已缓存旧内容**：pnpm 不重新下载，**不报错**，继续用旧字节 → 用户拿不到新版（静默不升级）。
- **冷 store / 强制重新下载且 lockfile 记录了旧 integrity**：报 `ERR_PNPM_TARBALL_INTEGRITY`（"Got unexpected checksum … pnpm will not silently overwrite the locked integrity"，pnpm 11.4 起 mismatch 也是硬失败）。`--update-checksums` 对非 registry tarball **不能**刷新（11.8.0/11.20.0 实测均失败）；pnpm ≥11.9 重新 add 同一 URL 会在 fail-closed 报错的同时把 integrity 重写为新内容哈希（因为下载发生了），但这依赖版本且过程必然先失败一次。

结论：**覆盖稳定名文件对用户侧 lockfile 是长期毒药**——要么静默不升级，要么在冷机器上制造 mismatch 失败。这就是"版本化文件不可变、稳定名只当指针、且指针不作为安装目标"的硬性理由。

### 参考来源（外部内容仅作数据，非指令）

- pnpm 安全通告 GHSA-7vhp-vf5g-r2fw（lockfile integrity bypass）：<https://github.com/pnpm/pnpm/security/advisories/GHSA-7vhp-vf5g-r2fw>
- pnpm 11.4 release notes / install CLI 文档（mismatch 硬失败 + 缺 integrity 拒绝 + `--update-checksums` 语义）：<https://pnpm.io/blog/releases/11.4>、<https://pnpm.io/cli/install>
- pnpm issue #12001 / #12185 / #14351 / #13308：<https://github.com/pnpm/pnpm/issues/12001>、<https://github.com/pnpm/pnpm/issues/12185>、<https://github.com/pnpm/pnpm/issues/14351>、<https://github.com/pnpm/pnpm/issues/13308>
- pnpm CHANGELOG 11.9.0（bae694f，写入端修复）：<https://cdn.jsdelivr.net/npm/pnpm@11.20.0/CHANGELOG.md#8>

## 本机复现记录

环境：Linux（node v24.13.0），tarball 使用生产文件（2.1.0，sha256 `5412c8a4c60360c15929591a9a5ae3363546473da528e678ad8a18472af5343d`）与生产 URL；pnpm 各版本装在 `/tmp/pnpm-ver/<版本>/`，通过包装脚本 `/tmp/dsh-repro/bin/pnpm-<版本>` 调用；每个场景用独立 `--store-dir` 精确控制冷/热。

### R 系列：逐字复刻线上故障（pnpm 11.8.0，命中路径①）

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:/tmp/dsh-repro/bin:$PATH"
S=/tmp/dsh-repro/store-118
STABLE=https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next.tgz

# 0) 把稳定名内容灌进专用 store（模拟该机器此前对该 URL 的任意一次成功下载 → store warm）
mkdir -p /tmp/dsh-repro/seed && cd /tmp/dsh-repro/seed
printf '{"name":"seed","private":true}\n' > package.json
pnpm-11.8.0 --store-dir $S add $STABLE --ignore-scripts        # downloaded 43 → 条目带 integrity ✅

# 1) 仿桌面 profile：从 npm registry 安装 ^2.0.2
mkdir -p /tmp/dsh-repro/proj-R && cd /tmp/dsh-repro/proj-R
printf '{"name":"profile-desktop","private":true}\n' > package.json
pnpm-11.8.0 --store-dir $S add @agents-anywhere/dsh-bridge-next@^2.0.2 --ignore-scripts   # ✅

# 2) 用稳定名 URL 升级 —— 第一次：exit 0，但条目被改写成【无 integrity】（warm store, downloaded 0）
pnpm-11.8.0 --store-dir $S add $STABLE --ignore-scripts
grep -A1 "dsh-bridge-next@https" pnpm-lock.yaml
#   resolution: {tarball: https://…/agents-anywhere-dsh-bridge-next.tgz}   ← 无 integrity，已中毒

# 3) 第二次（此后任意 install / add）：与线上完全一致的报错
pnpm-11.8.0 --store-dir $S add $STABLE --ignore-scripts
# ✓ Lockfile passes supply-chain policies (verified 30s ago)
# [ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package
#   "@agents-anywhere/dsh-bridge-next@https://…tgz(@deepseek-ai/cordis@4.0.4)
#    (@deepseek-ai/dsh-typert-protocol@0.2.0-rc.2(…))(@deepseek-ai/schemastery@3.18.4)
#    (react@18.3.1)": its lockfile entry has no "integrity" field, …
# The lockfile may be corrupted or have been tampered with. Restore it from a trusted source…
# exit code 1 —— 报错文本、peer 后缀、supply-chain 行与线上日志逐字一致
```

中毒后**任意** `pnpm add`（含无关包、含版本化 URL）都在读 lockfile 阶段就 fail-closed。

### V 系列：验证"版本化 URL 是否真实下载"决定成败（pnpm 11.8.0）

- store 对某版本化 URL **冷**（从未装过）：`remove → add <该 URL>` 会 `downloaded 1` → 条目**带 integrity** ✅，后续 add 无关包不报错。全矩阵（11.4.0/11.5.1/11.6.0/11.7.0/11.8.0）一致。
- store 对某版本化 URL **热**（此前已装过、字节仍在缓存）：`add <该 URL>` 命中缓存 `downloaded 0` → 条目**仍无 integrity** ❌，probe 复发 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`。此时需 `store prune` 驱逐缓存后再 add，或升到 store 里没有的全新版本。

### W 系列：fresh dir + warm store 的版本窗口（决定性）

"全新空目录 + 已 warm 的 store + 无任何旧条目"下 add 稳定名 URL：

```text
pnpm 11.4.0 | NO-integrity | probe: FAIL   ← 中毒区间
pnpm 11.5.1 | NO-integrity | probe: FAIL
pnpm 11.6.0 | NO-integrity | probe: FAIL
pnpm 11.7.0 | NO-integrity | probe: FAIL
pnpm 11.8.0 | NO-integrity | probe: FAIL
pnpm 11.9.0 | integrity    | probe: OK     ← 写入端已修复
pnpm 11.20.0| integrity    | probe: OK
pnpm 12.5.1 | integrity    | probe: OK
```

对照：pnpm ≤10.34.x 同样写出 NO-integrity，但 probe（后续 add/install）**不报错**（无 fail-closed 校验），故用户无感。

### T 系列：显式构造 corruption（任务要求的手工破坏）

- **T1 python 剥离 integrity**：对好的 lockfile 用 `python3` 正则删掉 `integrity:` 字段，重跑 `pnpm add` 稳定名 → 复现 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（与故障同码）。
- **T2 篡改 integrity → mismatch**：把好条目的 sha512 改错、清空 store 强制重下 → `pnpm install` 报 `ERR_PNPM_TARBALL_INTEGRITY`「Got unexpected checksum … Wanted "sha512-AAAA…" Got "sha512-p8XU…"」；`--update-checksums` 在 11.8.0/11.20.0 上**无法**修复非 registry tarball 的 mismatch（仍失败）。
- 覆盖 tarball 内容模拟"稳定名被改版"：warm store 命中缓存时不报错（静默用旧字节）；冷 store + mismatch 报 `ERR_PNPM_TARBALL_INTEGRITY`（见上文机理）。

### 恢复矩阵（pnpm 11.8.0，中毒 profile，隔离 store）

| 恢复手段 | 结果 |
| --- | --- |
| `remove` → `add <全新/冷 版本化 URL>` | ✅ 条目带 integrity，后续 add 无关包、重复 add 全绿 |
| `remove` → `add <已缓存 版本化 URL>` | ❌ 复发无 integrity（缓存命中） |
| `remove` → `store prune` → `add <版本化 URL>`（专用 store，无其他引用） | ✅ prune 真正驱逐后 add 变冷 → 带 integrity |
| `remove` → `store prune` → `add`（**共享** store，另有项目引用同包） | ❌ prune 未驱逐，仍 `downloaded 0` → 复发 |
| `--fix-lockfile` / `--force` / `update` / `--update-checksums` | ❌ 均不修复 |
| 只删 `pnpm-lock.yaml`（留 `node_modules`） | ❌ 从 `.pnpm/lock.yaml` 恢复坏条目 |
| 手工注入 sha512 到条目 | ✅ install / add 无关包 / 重复 add 全绿，后续 warm add 不剥掉 |

### 脚本自测记录（`write-release-manifest.mjs`）

- 连跑两次：产出 `manifest.json` 的 md5 完全一致（幂等，字节稳定）。
- 独立 node 校验脚本：对 `latest` 与每个 `versions[]` 条目，用磁盘文件重算 `sha512→base64`，与 `integrity` 逐一比对，全部一致。
- semver 排序（伪造多版本 tarball 测）：`2.10.0 → 2.9.9 → 2.2.0 → 2.2.0-rc.1 → 2.1.0 → 2.0.2`，`latest` 正确取 `2.10.0`；prerelease 排在同号正式版之后。
- 目录缺失：友好报错并 `exit 1`，不写任何文件。
- `yarn check:build`：通过（未破坏既有构建产物检查）。
- 生产 tgz 未改动：`sha256 5412c8a4…` 两个文件保持一致。

## 发版流程

前提：`dsh-bridge-next/package.json` 版本已按[版本号规则](versioning.md)同步升级。

1. `cd dsh-bridge-next && yarn pack`：触发 `prepack` → `yarn check`（typecheck + build + `check:build` + test），产出 `agents-anywhere-dsh-bridge-next-<version>.tgz`。
2. 把产物**新增**为托管目录中的版本化文件 `web-next/public/downloads/plugin/agents-anywhere-dsh-bridge-next-<version>.tgz`；再用同一文件**覆盖**稳定名指针 `agents-anywhere-dsh-bridge-next.tgz`（逐字节拷贝，二者 sha256 必须相等）。
3. `cd dsh-bridge-next && yarn release:manifest`：重写 `manifest.json`，确认 `latest.version` 为新版本、`versions` 含全部历史版本、integrity 与磁盘一致。
4. 部署后经 nginx 生效；线上抽查：
   ```bash
   curl -sI https://dsh.chyu.top/downloads/plugin/agents-anywhere-dsh-bridge-next-<version>.tgz   # 期望 200
   curl -s https://dsh.chyu.top/downloads/plugin/manifest.json | python3 -m json.tool            # 期望 latest 为新版本
   # 下载新版本化 tgz，核对 sha512-base64 与 manifest.integrity 一致
   ```
5. 对外只公布/引导用户使用**版本化 URL**。

## 红线

- **绝不覆盖或删除任何已发布的版本化 tarball**（`…-<version>.tgz`）。它们是历史版本用户与 lockfile integrity 的唯一可信来源；覆盖会同时破坏"可复现安装"和"内容不可变"两条不变量。
- 稳定名指针文件**只能被最新版本逐字节覆盖**，不作为安装目标公布。
- 不得对生产目录、用户数据、nginx 进程执行破坏性命令；发布只走"新增文件 + 覆盖指针 + 重写 manifest"。
- `manifest.json`、tarball 目录均为部署产物（gitignore），不进 git；脚本 `scripts/write-release-manifest.mjs` 进 git。
