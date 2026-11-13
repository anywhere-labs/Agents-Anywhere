# Server worker 内存增长排查（#466）

关联 [#466](https://github.com/anywhere-labs/Agents-Anywhere/issues/466)、[通知泵旧版本积压 #613](https://github.com/anywhere-labs/Agents-Anywhere/issues/613)、[缓解开关 #586](https://github.com/anywhere-labs/Agents-Anywhere/pull/586)。本文记录本地证据和生产只读观察方法，不代表线上根因已确认。

## 已确认的本地路径

通知泵之前给同一条 `timeline.itemUpsert` 标记最新版本，在消费时才跳过旧版本。处理变慢时，队列仍保存所有旧版本的完整载荷；即使最终只处理最新版本，也会推高内存。排空后 Python 对象释放，glibc 仍可能保留已释放的堆页。

2026-11-10，在 Linux、CPython 3.12.3、glibc 环境中，用真实通知泵和阻塞的假 ingest 复现；以下为接手 #613 后，以最新 main `25ab3150` 为基线、使用相同依赖复核的结果。先阻塞首条消息，再向同一会话、同一 item 发送 2000 次各约 64 KiB 的完整替换，每条消息后让出事件循环。无数据库、Redis、网络调用，也不运行生产服务。

| 阶段 | 修改前 RSS / Python 活对象 | 修改后 RSS / Python 活对象 |
| --- | --- | --- |
| 首条处理中 | 97.86 / 0.07 MiB | 94.36 / 0.07 MiB |
| 2000 条更新排队 | 224.26 / 126.50 MiB | 94.55 / 0.15 MiB |
| 排空 | 224.26 / 0.08 MiB | 94.55 / 0.09 MiB |
| 本地 `malloc_trim(0)` 后 | 97.18 / 0.09 MiB | 94.34 / 0.09 MiB |

两者都处理首个和最终版本；修改前在消费时跳过 1999 个旧版本，修改后在入队时移除它们。修改覆盖入口队列和每会话队列，避免入口突发时仍保留全部版本；最新版本位于自己的到达位置，不提前到被替换版本的位置。没有增加独立消息的丢弃、背压、断线或进程回收策略。不同 item、不同会话、其他方法的通知仍保留。

这解释了一条“积压制造高水位、排空后留下堆页”的本地因果链，不能推算生产的增长速率，也不能证明线上主要由此导致。实际依赖与生产镜像可能不同，线上还需检查大 HTTP 请求、慢数据库及其他分配路径。

在 `server/` 运行（先按开发指南安装依赖）：

```bash
PYTHONPATH=. .venv/bin/python scripts/bench_notification_memory.py --trim
# 不让出事件循环，观察入口突发积压：
PYTHONPATH=. .venv/bin/python scripts/bench_notification_memory.py --yield-every 0 --trim
# 对照：独立 item 不能通过完整替换合并，仍会随积压增长：
PYTHONPATH=. .venv/bin/python scripts/bench_notification_memory.py --distinct-items --trim
```

入口突发对照同样只保留两条，活对象约 0.15 MiB，RSS 增量约 0.19 MiB。独立 item 对照完整处理 2001 条，排队活对象约 127.10 MiB；本次修复不限制这类必要的积压。

每次使用新进程比较 RSS；`python_live_mib` 是启动 tracemalloc 后分配的活对象，不包含导入时的常驻对象和全部原生分配。`--trim` 只作用于这个本地实验进程。

## 回归验证

弱引用回归覆盖阻塞 handler 后的入口突发和会话积压，确认被替换载荷在排空前就已释放；两项测试在原始 main `25ab3150` 上均失败。另覆盖混合通知中最新快照的到达位置、不同会话同名 item 的隔离，以及合并后正常关闭排空和取消丢弃的计数、清理与停止入队。既有 RPC 响应旁路和断线所有权测试继续保留。

本轮没有进行生产采样、真实远程 Runtime 会话验证或部署。下面的只读观察步骤属于 #466 后续排查，不是已完成的验证。

## 一台生产 worker 的只读观察

按内部 `aa-ops/docs/cluster-a.md` 及发布记录确认正确入口。先排除容器重建、进程重启、镜像变化，保持现有配置；不重启、不向进程发信号、不 attach profiler、不读进程内存或环境变量。

在已授权主机上记录容器身份及非敏感配置（将 `CONTAINER` 替换为实际名称）：

```bash
docker inspect --format '{{.Id}} {{.Config.Image}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}} {{json .HostConfig.RestartPolicy}} {{.HostConfig.Memory}}' CONTAINER
docker top CONTAINER -eo pid,ppid,comm
```

只靠 `RestartCount` 不能排除外部重建：它会随新容器归零。需要同时比对容器 ID、启动时间、进程身份，以及既有部署/自动更新/调度记录。容器重建会切断时间序列，不能把重建前后的内存差当作回收效果。

`docker top` 显示宿主机 PID。确认目标应用 worker PID，区别 Uvicorn 管理进程、辅助事件进程、其他服务；不输出可能带凭据的命令行或完整 `docker inspect`。把 `server/scripts/sample_worker_memory.py` 放在宿主机临时目录，使用具备读取目标 `/proc` 权限的身份运行：

```bash
# 示例 PID；一次只选一台 worker 节点，不扫描六台。
# 可选该容器内的所有应用 worker PID，以分辨单进程和容器合计。
umask 077
python3 /tmp/sample_worker_memory.py 1234 1235 --interval 600 --samples 36 > /tmp/worker-memory.jsonl
```

脚本只有标准库依赖，读取 `/proc/<pid>/stat`、`smaps` 和系统 boot ID，只输出聚合映射元数据，不输出路径、命令行或环境。PID 退出、复用或读取权限不足会报错停止；重新确认容器及 PID 后另开观察文件。36 次采样覆盖约 5 小时 50 分钟；要覆盖 12 小时可用 73 次。长采样放到可查看和停止的持久终端中运行。

输出每行对应一个 PID 的一个采样点，数值单位为 KiB。按 `boot_id + pid + start_ticks` 分组，用 `sampled_at` 计算 RSS、私有脏页、Anonymous、Swap 的每小时变化；`read_ms` 用于观察读 smaps 的成本。不同 PID 合计优先用 PSS；RSS 会重复计算共享页，不能直接等同容器 cgroup 用量。

- `heap`：名为 `[heap]` 的映射。
- `anonymous_1mib_mapping`、`anonymous_64mib_mapping`：恰好该虚拟大小的匿名映射，**只是观察线索**。不能仅凭大小认定是 pymalloc 或线程 arena；arena 可能拆成多个映射，也可能合并。
- `anonymous_other`：其余匿名映射，包含可能的大块 mmap。
- `file`、`stack`、`special`：其余映射；`file` 内也可能有匿名脏页，需同时看 `Anonymous`。

这些是内核映射分类，无法区分活的 Python 对象和 allocator 内的空闲页；只读 smaps 不足以确认泄漏。结合既有请求耗时、错误频率、DB 抖动、流量及镜像内依赖清单，判断下一步实验。当前采样不会给旧版本 Server 增加队列深度指标。

## 仍待验证和决定

- 取得同一容器、同一 PID 的生产基线及分类斜率，核对 11-05 重建来源。
- 应用层 `/connector/ingest` 没有请求体字节上限；入口限制以 `aa-ops` 配置为准。#548、#589 减少了历史会话内联图片及大批量上传，不能据此排除大请求造成的高水位。
- #586 默认关闭。发版、单节点设 `AGENT_SERVER_MALLOC_TRIM_INTERVAL_SECONDS=300` 均需另行决定；不能为了观察擅自更改生产配置。每次调用默认写 debug 日志，只有耗时至少 100 ms 才升到 info，因此没有 info 日志不代表没运行。
- 开关上线后还需观察单次耗时及前后内存斜率；不要为了调用 trim 向生产进程注入代码。
- 独立消息无限积压、消息字节限额及超载时的处理策略仍未解决；增加限额可能影响交付，需要单独评估。按请求数回收 worker 也可能中断 WebSocket，不作为本次修复的默认行为。
