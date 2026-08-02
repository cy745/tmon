# tmon 详细设计 v0.2（草案）

> 日期：2026-08-02（v0.2：2026-08-03 同步「放弃 hook 强制层，改 skill 指引」决策，见 §10）
> 上游文档：`01-requirements.md`（需求）、`02-research-report.md`（调研）

---

## 1. 模块划分

单包（npm 包名 `tmon`，bin: `tmon`），内部五模块：

| 模块 | 职责 | 技术 |
|---|---|---|
| `cli` | 命令面（run/ls/status/show/wait/kill/progress/serve） | Node CLI（自写解析，零框架依赖） |
| `executor` | 创建 PTY/管道子进程、tee 输出、时间戳、信号控制（单进程内联，无独立 daemon） | node-pty |
| `server` | 任务注册表、WS 事件流、REST 查询、IPC 端点、JSONL 落盘 | Node http + ws（无框架） |
| `web` | 任务列表 + 终端视图 + 间隔可视化 + 控制 | 见 §11（待确认） |
| `sdk` | `tmon progress/stage/log` 子命令（进度上报入口，任何语言脚本可直接调用） | CLI 形式，零依赖 |

> 单包理由：Agent 场景要求零配置起步（`npm i -g tmon` 即用）；server 与前端静态资源内嵌发布。

## 2. 命令面（CLI 接口）

```
tmon "curl -o big.bin <url>"        # 前台执行：阻塞等待，输出 tee 回 stdout，行为与直接执行一致
tmon curl -o big.bin <url>          # 直接透传 argv 形式（等价字符串化，避免 Agent 引号二义性）
                                    # stderr 打印任务 id：tmon: task 7f2a9c3e started
tmon last                           # 最近任务 id（后台执行后取 id 用，见 U8）
tmon ls                             # 任务列表
tmon status <id>                    # 单任务状态 + 退出码（Agent 轮询专用）
tmon show <id> [--tail N | --full]  # 输出快照（按行，剥离 ANSI）
tmon wait <id> [--timeout N]        # 阻塞等待完成，透传退出码（退出码 0/非0 可编程判断）
tmon kill <id> [--signal SIGINT|SIGTERM|SIGKILL]   # CLI 侧取消（Web 按钮的等价物）
tmon progress <pct> <msg>           # 脚本内进度上报（读 TMON_ENDPOINT/TMON_TOKEN 环境变量）
tmon stage <name>                   # 阶段上报
tmon serve                          # 手动前台启动 server（默认由 CLI 自动拉起，见 §6）
```

**任务状态机**：`created → running → success | failed | killed | error`（error = tmon 自身故障，如 server 失联）

**后台执行范式（U8，D1 已定：无 `-b` 模式）**：Agent 用 `tmon "cmd" &`（bash 后台化或工具自带 run_in_background）→ 从 stderr 取任务 id（`tmon: task 7f2a9c3e started`，或 `tmon last`）→ 轮询 `tmon status <id>` 或阻塞 `tmon wait <id>`。tmon 进程被后台化后仍正常上报 server，任务生命周期与 Agent 会话解耦。

## 3. 任务标识与数据目录

- 任务 id：`<8位随机hex>`（短，便于 Agent 引用）
- 数据目录默认 `~/.tmon/tasks/<id>/`，可用 `TMON_DATA_DIR` 覆盖：

```
~/.tmon/
├── tasks/
│   └── 7f2a9c3e/
│       ├── meta.json      # 命令、cwd、pid、状态、退出码、起止时间、模式(pty/pipe)
│       └── stream.jsonl   # 逐 chunk 事件（与 WS 事件同构）
├── tmon.sock / tmon.port  # server 发现文件（进程间定位）
└── token                  # 每次 server 启动生成，CLI/Web 鉴权用
```

## 4. 事件协议（WebSocket，JSON 文本帧）

**上行（server → client）：**

```json
{"type":"hello","task":{"id":"7f2a9c3e","cmd":"curl -o big.bin <url>","status":"running","startedAt":1754140800000}}
{"type":"output","seq":42,"ts":1754140800123,"dt":123,"stream":"stdout","data":"45% |█████-----| 12MB/s\r"}
{"type":"progress","seq":43,"dt":5,"pct":45,"msg":"解压中"}
{"type":"status","status":"success","exitCode":0,"endedAt":1754140830000,"durationMs":30000}
```

**下行（client → server）：**

```json
{"type":"subscribe","lastSeq":41}    // 重连续传（返回 lastSeq 之后的全部事件）
{"type":"kill","signal":"SIGINT"}    // Ctrl-C 按钮；再次点击 → SIGTERM → SIGKILL 升级
{"type":"input","data":""}     // PTY 输入转发（\x03 = Ctrl-C 透传，Web 键盘完整转发）
{"type":"resize","cols":120,"rows":30}
```

**时间戳语义**：`ts` = 墙钟（显示用）；`dt` = 距上一条 chunk 的间隔毫秒（**单调时钟差值**，前端直接画间隔可视化，无需时钟同步）。

**chunk 粒度**：PTY 的 `onData` 天然按块到达（通常行级/帧级），逐 chunk 记录。TUI 程序无「行」概念，行切分只在纯文本展示层做；间隔可视化的数据单元始终是 chunk。

## 5. 落盘格式

`stream.jsonl` 每行一条（与 WS 上行事件同构，`{seq,ts,dt,stream,data}` / `{seq,ts,dt,pct,msg}` / `{status,...}`），崩溃可恢复（server 重启后读 JSONL 重建任务状态）。卷管理：单任务 > 50MB 时压缩旧段（gzip 轮转，v0.2 细化）。

## 6. 进程模型与 server 生命周期

- **单进程模型（D1 已定）**：tmon 不提供后台模式——前台执行即「透明代理」的全部含义，后台化完全交由 Agent 侧（bash `&` 或工具自带 run_in_background）。
- **自动拉起**：任何 `tmon` 子命令先探测 server（发现文件 + 端口心跳）→ 不存在则 `spawn( detached:true )` 拉起独立进程，写入发现文件。对 Agent 完全透明，无需手动 `tmon serve`。
- **执行路径**：CLI 进程内直接创建 PTY 子进程 → 输出三路：① 原样写 stdout（Agent 侧）② 净化版写 stdout（见 §8，与 ① 合并为一个通道决策）③ 逐 chunk 上报 server。CLI 阻塞至子进程退出，转发退出码。**CLI 退出即任务结束**。
- **后台化后的生命周期**：Agent 将 tmon 进程后台化（`&` / run_in_background）时，tmon 进程脱离交互终端继续运行，server 上报与落盘不受影响，任务与 Agent 会话解耦——等效于后台执行，无需独立 -b 模式。
- **单例 server**：同一数据目录下仅一个 server 实例（发现文件 + 端口独占）；Agent 与用户共用同一 server 和 Web。

## 7. 控制通道与取消

- **升级式终止**：`SIGINT` → 等待 5s → `SIGTERM` → 等待 5s → `SIGKILL`（间隔可配置）。Web 端「Ctrl-C」按钮触发 SIGINT；「强制终止」直接 SIGKILL。
- **进程组**（POSIX）：`kill(-pgid)` 覆盖整个进程组，防子进程逃逸；Windows：node-pty `kill()`（ConPTY 模拟 Ctrl-C）+ 进程树 `taskkill /PID <pid> /T /F` 兜底。
- **PTY 模式下的 Ctrl-C**：优先注入 `\x03` 到 PTY（等价真实 Ctrl-C，程序可捕获并优雅退出），超时后再升级信号。

## 8. PTY 与输出净化（FR-2 vs FR-9 冲突的解）

- **默认 PTY 模式**（TUI 程序正常、Web 端完整）；`--pipe` 可选纯管道模式（无 ANSI、行切分干净，牺牲 TUI）。
- **Agent 侧输出净化**（待确认）：默认对回流给 Agent 的 stdout 做净化——剥离 ANSI 转义码（`\x1b[...m` 等），TUI 全屏帧只保留最后一行状态（如进度条取尾帧）。Web 端始终保留完整原始流。`--raw` 选项关闭净化（要求原样输出时用）。
- **编码**：`iconv-lite` 探测 UTF-8/GBK，统一转 UTF-8 后入流（解决 Windows 中文乱码，NFR-7）。

## 9. 进度上报 IPC（FR-10）

- **通道**：TCP `127.0.0.1` 随机端口（跨平台，unix socket 在 Windows 不可用故弃用）+ 每任务独立 token；server 在任务创建时分配，通过环境变量注入子进程：`TMON_ENDPOINT=127.0.0.1:45231`、`TMON_TOKEN=xxxx`。
- **协议**：JSON lines over TCP：`{"type":"progress","pct":45,"msg":"解压中"}` / `{"type":"stage","name":"下载"}` / `{"type":"log","level":"info","msg":"..."}` / `{"type":"ping"}`。
- **调用形式（待确认）**：CLI 子命令 `tmon progress 45 "解压中"`（bash/python/node 脚本直接调用，零 SDK 依赖）→ 可选薄 SDK 包装（`pip install tmon` / `npm i tmon` 提供同名函数，纯语法糖）。
- **Web 渲染**：progress/stage 事件驱动阶段步骤条 + 百分比进度条（P2，v0.3 实现；协议先行）。

## 10. Agent 引导方式（已定：skill 指引，2026-08-03 取消 hook 强制层）

**决策**：放弃 Claude Code PreToolUse hook 强制包装方案（原 FR-1b）。调研确认 hook 技术上可行（`updatedInput` 重写 / exit 2 阻断），但：① hook 无流式输出（实时通道仍是 wrapper 本身，hook 只做包装没有额外价值）；② 存在边界限制（headless/-p 竞态、`allowedTools:['*']` 跳过、MCP 工具不强制 deny）；③ 强制手段有副作用（误包装、递归风险）。

**替代方案：skill 指引（FR-1d）**——随项目交付 skill 文件，指导 Agent 主动使用 tmon。要点：

1. **触发场景**：长任务（下载/编译/批量处理）、后台任务、需要用户实时监控或可干预的命令
2. **使用模式**：
   - `tmon "cmd"` 前台执行（透明，输出原样回传）
   - 需要后台时用 bash `&` / run_in_background，从 stderr 取任务 id 或 `tmon last`
   - 轮询 `tmon status <id>` 或阻塞 `tmon wait <id>`（透传退出码）
   - 脚本内 `tmon progress <pct> <msg>` / `tmon stage <name>` 上报进度
3. **注意事项**：不包装 tmon 自身命令；复杂命令用字符串形式（`tmon "cmd"`）避免引号二义性；命令输出含 ANSI 属正常（Web 端显示完整流）

skill 文件交付位置：仓库 `skills/tmon/SKILL.md`（可发布到 skill 市场）。

## 11. Web 前端（✅ 已定并实现，2026-08-03）

- **技术栈（D4）**：React + Vite + xterm.js
- **布局**：左右分栏任务工作台——左侧任务侧边栏（常驻全景）+ 右侧四段式工作台（任务头 / 进度区 / 间隔时间线 / 终端窗口）
- **风格**：极简主义（Minimalism & Swiss Style）——近黑单色 + 唯一强调绿、无圆角无阴影、色点式徽章、JetBrains Mono + IBM Plex Sans
- 详细设计见 **`04-web-design.md`**（v1.0，已实现验收）

## 12. 安全

- server 仅监听 `127.0.0.1`；WS/REST 均要求 `Authorization: Bearer <token>`（token 存 `~/.tmon/token`，CLI/前端自动携带）
- 进度 IPC 端点同样需 token（防本机其他进程伪造进度）
- 跨机部署（Agent 在服务器、用户在浏览器）→ v1.0：TLS + 用户认证（超出本版范围）
- **权限边界**：tmon 是包装器，权限 = 启动它的 Agent 的权限，不额外提权

## 13. 里程碑映射（与 01 路线图对齐）

| 里程碑 | 本文档覆盖范围 |
|---|---|
| v0.1 MVP | §1-§8、§12（✅ 已完成：含 FR-1c 查询与 §9 进度 API 提前实现，2026-08-02/03） |
| v0.2 | §7 PTY 全交互 + Web 输入、§8 净化、skill 指引文件（§10）、静默告警（FR-6） |
| v0.3 | 自动化测试、输出体积控制、历史回放动画、通知（FR-13） |
| v1.0 | 发布打包、跨机部署（TLS） |

## 14. 待确认决策清单

| 编号 | 决策点 | 草案推荐 |
|---|---|---|
| D1 | 默认运行模式 | ✅ 已定：**仅前台，无 `-b` 模式**——后台化由 Agent 侧 bash `&` / run_in_background 完成（2026-08-02 确认） |
| D2 | Agent 侧输出净化默认值 | 默认净化（剥离 ANSI/TUI 尾帧），`--raw` 关闭 |
| D3 | 进度上报形式 | ✅ 已定：CLI 子命令为主（2026-08-02 确认），SDK 后续可选语法糖 |
| D4 | 前端技术栈 | ✅ 已定：React + Vite + xterm.js（2026-08-02 确认） |
| D5 | 任务 id 长度 | 8 位 hex（Agent 引用友好） |
| D6 | 取消升级间隔 | SIGINT→5s→SIGTERM→5s→SIGKILL |
| D7 | Agent 引导方式 | ✅ 已定：skill 指引，放弃 hook 强制层（2026-08-03 确认，见 §10） |
