<!-- tm_board_write · 2026-09-26T20:01:48.245Z · role=implementer · session=20260926-213919 -->
# Git 规格安装落盘布局实测（opencode-dist / 探针报告）

日期：2026-09-27　环境：Windows (win32)　宿主：OpenCode Desktop v2.0.18（open 2.0.18）
被观察对象：`C:\Users\34296\AppData\Local\Programs\@opencode-aidesktop\resources\opencode-cli.exe`
仓库：`D:\Github\Agents-Anywhere`（**只读，未改任何文件**）
隔离方式：`XDG_CACHE_HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME` 全部重定向到自建 temp 目录；
用 `opencode-cli.exe debug paths` 验证重定向生效（home 仍是真实用户，但 cache/config/data/state 全在 temp）。
temp 根：`C:\Users\34296\AppData\Local\Temp\ocdist-probe-a7f3`（**报告后已整体删除**）。

---

## 0. 一句话结论

1. **硬实测**：本机（Windows + v2.0.18）**任何 Git 规格都装不上** —— `opencode plugin add 'git+file:///…::path:opencode-plugin'` 与
   `opencode plugin add 'github:sindresorhus/is#main'` 均直接失败（`NpmInstallFailedError: git dep preparation failed`），缓存里只留一个**空目录**。
   因此「装完后同级有没有 connector/」**无法端到端实测**。
2. **实现推断**（反编译 opencode-cli.exe 内嵌的 pacote fork）：Git 规格会把**整个仓库**拉下来解包到 pacote 的**临时**目录，只把 `o + gitSubdir`（即 `opencode-plugin/` 子目录）打包进 node_modules。
   插件运行时目录 = `<cache>/opencode/npm/<sanitized-spec>/<ts>/node_modules/<pkg>`，`dirname()` = `node_modules/@agents-anywhere` → **同级没有 connector/**。
3. **对决策的影响**：**打包 Connector 是必要的**（或至少必须由 `AGENT_CONNECTOR_SOURCE` 给出显式路径）；现存「插件包同级 `../connector`」解析在 Git 规格下不可用。
4. **附带前提问题**：`opencode-plugin/` 在当前仓库里**根本没被 git 跟踪**（`git status` = `?? opencode-plugin/`），所以任何 `github:<org>/<repo>#<ref>::path:opencode-plugin` 连「取到该路径」这一步都过不去。

---

## 1. 装置有效性对照（证明失败是 git 专属，不是隔离环境的锅）

```
$ $env:XDG_*=<temp>; opencode-cli.exe plugin add opencode-browser
Plugin "opencode-browser" installed and added to C:\Users\34296\AppData\Local\Temp\ocdist-probe-a7f3\run-CTRL2\.config\opencode\opencode.json
EXIT=0
```

落盘目录树（npm 注册表规格）：
```
run-CTRL2\.cache\opencode\npm\opencode-browser@latest\
  └─ 1790452679807\
       ├─ package.json          => {"dependencies":{"opencode-browser":"1.2.3"}}
       ├─ package-lock.json
       └─ node_modules\         (28 个真实目录，**无 LinkType / 无符号链接**)
            ├─ .bin\  @ai-sdk\  @msgpackr-extract\  @opencode-ai\  @standard-schema\ …
            └─ opencode-browser\  => bin\ src\ LICENSE package.json README.md
```
配置写入：`<temp>\run-CTRL2\.config\opencode\opencode.json` = `{"plugins":["opencode-browser"]}`（写的是**裸包名**，不是路径）。

> 注意：v2.0.18 的安装根是 `<cache>/opencode/npm/<sanitized-spec>/<时间戳>/`，
> 用户机器上遗留的 `~/.cache/opencode/packages/…` 是**旧版布局**（同样形态：`packages/opencode-browser@latest/node_modules/opencode-browser`）。

---

## 2. Git 规格：全部失败（命令原文）

```
$ opencode-cli.exe plugin add 'git+file:///C:/Users/34296/AppData/Local/Temp/ocdist-probe-a7f3/upstream#probe::path:opencode-plugin'
opencode-cli.exe : timestamp=… level=ERROR message="cli process failed"
  cause="Cause([Fail(NpmInstallFailedError (cause: Error: git dep preparation failed))])"
  at Npm.reify (B:/~BUN/root/chunk-bds0wxz0.js:3:9786)
  at Npm.add  (B:/~BUN/root/chunk-zr8ffrbj.js:2:1252)
EXIT=1

$ opencode-cli.exe plugin add 'github:sindresorhus/is#main'      # 换真实远程、无 ::path:
EXIT=1  （同一条 NpmInstallFailedError，堆栈一致）

$ opencode-cli.exe plugin add 'file:///C:/…/upstream/opencode-plugin'
Error: Plugin target must be an npm registry package or Git package specifier    # 本地路径规格不被接受
```

失败残渣（**空目录**，证明 clone/extract 目标被建了但没落地）：
```
run-A_gitfile_subdir\.cache\opencode\npm\git-upstream-c3767572e6bf   (空)
run-C_gitfile_nosub\.cache\opencode\npm\git-upstream-e935a03c1694    (空)
run-GH\.cache\opencode\npm\git-is-274284d6d529                        (空)
```

---

## 3. 根因（宿主日志 + 直接复现）

宿主日志（隔离后的 `log\opencode.log`）原文，父/子进程两条相邻记录：
```
level=INFO  run=288a214d message="cli starting" args="[\"plugin\",\"add\",\"github:sindresorhus/is#main\"]"
level=INFO  run=5bd3b47c message="cli starting" args="[\"B:\\~BUN\\bin\\npm-cli.js\",\"install\",\"--force\",
            \"--cache=C:\\Users\\34296\\AppData\\Local\\npm-cache\",\"--no-save\",\"--no-audit\", …]"
level=ERROR run=5bd3b47c cause="Cause([Fail(~effect/cli/CliError/ShowHelp: Help requested)])"
level=ERROR run=288a214d cause="Cause([Fail(NpmInstallFailedError (cause: Error: git dep preparation failed))])"
```

即：pkacote fork 的「git 依赖准备」步骤用 `process.execPath` 重新执行自己 + 内嵌 npm-cli 路径
`B:\~BUN\bin\npm-cli.js`，而这个子进程**根本没进 npm-cli**，只打印了 OpenCode 自己的 CLI 帮助。

直接复现该子进程形态：
```
$ opencode-cli.exe "B:\~BUN\bin\npm-cli.js" --version              → opencode v2.0.18
$ opencode-cli.exe "B:/~BUN/bin/npm-cli.js"   --version              → opencode v2.0.18
$ $env:BUN_BE_BUN=1; opencode-cli.exe --version                      → 1.4.2   （内嵌 bun 版本）
$ $env:BUN_BE_BUN=1; opencode-cli.exe "/~BUN/bin/npm-cli.js" --version → error: Module not found "/~BUN/bin/npm-cli.js"
```
结论：编译后的 bun 单文件**不会**把 `~BUN` 虚拟路径分派到内嵌 npm-cli（正/反斜杠都一样），
于是「git 依赖准备」必然失败 → 整个 Git 规格安装在本平台走不通。（同一个 bug 与 `::path:` 无关：`github:…#main` 无子目录选择器也失败。）

---

## 4. 实现层证据（反编译 opencode-cli.exe）

```
$ rg -a -b -o "::path:" opencode-cli.exe            → 96042108 / 147802232 / 192445664
$ rg -a -b -o "gitSubdir" opencode-cli.exe          → 96042124 / 146673527 / 146673539 / …
$ rg -a -b -o "git dep preparation failed" …        → 96063692 / 147805082
```

**(a) 规格串行化**（`::path:` 是 OpenCode/pacote fork 自己的扩展，npm-package-arg 里解析成 `gitSubdir`）：
```js
var X5=(e,t)=>{ let r=e.gitSubdir?`::path:${e.gitSubdir.slice(1)}`:""; if(e.hosted){…`${shortcut}#${t}${r}`} … }
…
if(r==="path"){ if(e.gitSubdir) throw Error("cannot override existing path with a second path");
                e.gitSubdir=`/${i}`; continue }
```

**(b) Git fetcher（pacote GitFetcher fork）**——整仓下载 → 解包到临时目录 → 包路径 = 临时目录 + 子目录：
```js
#n(e,t=!0){
  let r={tmpPrefix:"git-clone"}, … s=this.spec.hosted …;
  return t=t&&s&&n===La(s,{noCommittish:!1})&&s.tarball,
  e6.tmp.withTmp(this.cache,r,async(o)=>{
    if(t){ … new o6(s.tarball({committish:this.resolvedSha}),{…,allowGitIgnore:!0,integrity:null})
             .extract(o).then(()=>e(`${o}${this.spec.gitSubdir||""}`), …) }
    let a=await(s?this.#a(i,o):this.#c(this.spec.fetchSpec,i,o));
    …
    return e(`${o}${this.spec.gitSubdir||""}`)   // ← 交给上层的“包目录”= 临时目录 + /opencode-plugin
  })}
```

**(c) 打包成 tarball 时只取该子目录**（`t` = 上面的 `o + gitSubdir`）：
```js
[Va.tarballFromResolved](){ … this.#n((t)=>this.#r(t).then(()=>new Promise((r,i)=>{
   let n=new s6(`file:${t}`,{…,Arborist:this.Arborist,resolved:null,integrity:null})[Va.tarballFromResolved](); …}))) }
```

**(d) 准备步骤的 spawn 辅助**（子进程为何跑成 OpenCode CLI）：
```js
var qb=… Vb.exports=(e,t,r,i,s)=>{ let n=e.endsWith(".js"), o=n?process.execPath:e, a=(n?[e]:[]).concat(t);
                                   return Q5(o,a,{cwd:r,env:i},s) }
… c6(this.npmBin,[].concat(this.npmInstallCmd).concat(this.npmCliConfig), e, {…process.env,_PACOTE_NO_PREPARE_:…},
     {message:"git dep preparation failed"})
```
其中 `npmBin` = `B:\~BUN\bin\npm-cli.js`，`process.execPath` = `opencode-cli.exe` → 见 §3。

**(e) 运行时插件自定位**（被测插件侧，仓库只读引用）：
```ts
// opencode-plugin/src/server/connector-supervisor.ts:185-190
resolveSourceDir(): string { … const sibling = join(dirname(this.#packageDir), 'connector') … }
// :632 defaultPackageDir(): 从 import.meta.url 上溯最多 4 层找最近 package.json
```

**判定链**：Git 规格下「仓库根」只存在于 pacote 的**临时**解包目录（`tmpPrefix:"git-clone"`，`withTmp` 语义=用完即删），
进入 node_modules 的是 `file:<临时目录>/opencode-plugin` 打包出来的 tarball，即**只有子目录**。
故插件进程看到的 `packageDir` = `…/node_modules/@agents-anywhere/opencode-plugin`，
其父目录是 `…/node_modules/@agents-anywhere`，**不存在 `connector/`**。（npm 对照实测：node_modules 下全是真实目录、无 link，佐证「复制而非链接」。）

---

## 5. 「无法判定」的边界（诚实声明）

- 端到端**没做成**：本平台 Git 规格安装 100% 失败，所以「装完后磁盘上同级有没有 connector/」**没有直接观测值**。
- 上述第 4 节是**静态实现推断**（反编译 + 官方 pacote 语义），强度高但非实测。
- 未验证项：pacote `withTmp` 是否 100% 清理临时目录（即便不清理，结论也不变 —— 运行时目录是 node_modules 内的副本，不是临时目录里的子目录）。

## 6. 附带发现（与主线无关但影响该决策）

```
$ git status --porcelain -- opencode-plugin     → ?? opencode-plugin/
$ git cat-file -e HEAD:opencode-plugin          → fatal: path 'opencode-plugin' exists on disk, but not in 'HEAD'
$ git ls-files -- opencode-plugin | Measure    → 0
$ git check-ignore -v opencode-plugin          → （空，未被 ignore）
```
→ `opencode-plugin/` 是**未跟踪的工作区目录**，main(3b71979f) 里没有它。任何指向它的 Git 规格都会在取路径时失败。

## 7. 复现步骤（原封不动）

```powershell
$tmp="<你的temp>\ocdist-probe"; New-Item -ItemType Directory -Force $tmp | Out-Null
robocopy "D:\Github\Agents-Anywhere\opencode-plugin" "$tmp\upstream\opencode-plugin" /E /XD node_modules dist .turbo
robocopy "D:\Github\Agents-Anywhere\connector"       "$tmp\upstream\connector"       /E /XD node_modules .venv __pycache__
cd $tmp\upstream; git init -b probe; git add -A; git commit -m probe

$cli="C:\Users\34296\AppData\Local\Programs\@opencode-aidesktop\resources\opencode-cli.exe"
$h="$tmp\h"; $env:XDG_CACHE_HOME="$h\.cache"; $env:XDG_CONFIG_HOME="$h\.config"
$env:XDG_DATA_HOME="$h\.local\share"; $env:XDG_STATE_HOME="$h\.local\state"
& $cli debug paths                                        # 确认重定向
& $cli plugin add "opencode-browser"                      # 对照：成功
& $cli plugin add "git+file:///…/upstream#probe::path:opencode-plugin"   # 失败
Get-ChildItem "$h\.cache\opencode" -Recurse -Depth 3 -Force
```

## 8. 卫生

- 未写 `D:\Github\Agents-Anywhere\**` 任何文件；未改用户 OpenCode 配置；未杀/未干扰 PID 9016；未占用 49374。
- 未开浏览器窗口；未起常驻进程（探针结束复查：无自建 opencode-cli/bun 残留进程）。
- 自建 temp 目录 `C:\Users\34296\AppData\Local\Temp\ocdist-probe-a7f3` 及其中所有副本**已删除**（`deleted=True`）。
- 唯一副作用：失败的「git 依赖准备」子进程按自身默认写到真实 `%LOCALAPPDATA%\npm-cache\_logs`（日志缓存，非配置），仅此一处。
