# tmon —— AI Agent 命令执行追踪与监控工具 需求文档

> 曾用名：tck（因 npm / PyPI / crates.io 三注册表均被占用而弃用，2026-08-02 定名 tmon，terminal monitor）

> 状态：v0.3（2026-08-03）——v0.2 已回填调研结论；本次更新：放弃 hook 强制层、改为 skill 指引（Q1/FR-1b），并同步 v0.1 MVP 实现进度。

---

## 1. 背景与动机

AI Agent 经常需要执行耗时极长的任务（大文件下载、编译、数据迁移、批处理等）。现状痛点：

1. **状态不可见**：Agent 将长任务放到后台执行（如 Bash 工具的 `run_in_background`），用户无法直观了解执行状态，只能等待或反复询问 Agent。
2. **"静默"造成的焦虑**：某些流程因等待/阻塞长时间无输出，或网络原因执行缓慢，用户无法区分"卡死了"和"在慢慢跑"。
3. **无法干预**：任务出现问题（如要输入密码、确认提示、或想中止重跑）时，用户没有直接的干预入口，只能干等 Agent 超时或手动找进程 kill。

**核心诉求**：给 Agent 的命令执行加一层**透明代理**，让用户通过 Web 界面实时、直观地看到任务在干什么、跑了多快、是否需要干预。

## 2. 目标

| 目标 | 说明 |
|---|---|
| G1 最小侵入接入 | Agent 只需把 `curl xxx` 改为 `tmon "curl xxx"`，或通过 skill 指引强制使用 |
| G2 对 Agent 完全透明 | 输出内容、退出码、整体行为与直接执行一致，Agent 感知不到代理存在 |
| G3 实时可见 | Web 端实时展示输出，**每行输出带时间戳，行间间隔可视**，能直观区分"卡死"与"缓慢" |
| G4 可干预 | Web 端一键发送 Ctrl-C（SIGINT）取消任务，可升级 SIGTERM/SIGKILL |
| G5 可扩展 | 后续提供脚本封装（SDK），脚本内调用 `tmon.progress(...)` 上报任务/进度百分比，Web 端展示进度条 |

## 3. 非目标（v1 不做）

- 不做通用终端仿真器产品（复用 xterm.js 等成熟组件，不重复造）
- 不做 Agent 对话/工具调用的完整审计平台（仅聚焦命令执行流）
- 不做任务编排/调度器（不管理任务依赖，只监控单个命令/脚本）
- 不做分布式集群监控（单机/单 Agent 场景优先）

## 4. 总体架构

```
                    ┌─────────────────────────────────────────────┐
                    │               tmon server (Web 后端)           │
                    │  任务注册表 / 事件流(WS) / REST / IPC 端点    │
                    │  借鉴 asciinema relay 模型：服务器端终端模拟器，│
                    │  中途加入的观看者立即拿到当前完整终端状态      │
                    └───────▲───────────────────────▲─────────────┘
                            │ 事件：行输出+时间戳     │ 控制：kill / stdin
    Agent Bash 工具         │                       │
        │  skill 指引        │                       │
        │  (tmon "cmd")     │                       │
        ▼                   │                       │
  ┌─────────────┐   ┌───────┴──────────┐    ┌────────┴─────────┐
  │ tmon CLI      │──▶│ 输出拦截器        │──▶│ Web 前端          │
  │ (wrapper)    │   │ 行缓冲+时间戳     │    │ xterm.js 终端视图  │
  │ PTY/子进程    │   │ ANSI 处理        │    │ 间隔热力图/进度条  │
  │ tee 回 stdout │   │ 落盘 (JSONL)    │    │ 取消/输入按钮      │
  └──────┬──────┘   └───────────────────┘    └───────────────────┘
         │ 脚本内 tmon.progress() → IPC（socket/文件）→ server
         └─ 对 Agent 的输出保持原样（透明；TUI 场景净化见 FR-9）
```

**三个组件：**

1. **tmon CLI（wrapper）**：接收命令 → 创建子进程（PTY 或纯管道，见 FR-7）→ 输出同时流向：① 原始 stdout/stderr（Agent 侧透明）② 行级事件流（时间戳）→ server。
2. **tmon server（Web 后端）**：任务注册表、实时事件推送、控制通道（取消、输入转发）、脚本进度 API 的 IPC 端点。设计借鉴 asciinema 的「生产者-CLI → 服务器继电器 → 消费者播放器」模型（服务器端终端模拟器维护完整流状态）。
3. **tmon Web 前端**：任务列表页 + 实时终端视图（xterm.js，可评估直接复用 asciinema-player）+ 行间隔可视化 + 控制按钮。

**进程模型（已定）**：wrapper 与 server 分离。wrapper 启动时向 server 注册任务并建立事件通道；`tmon "cmd" &` 后台执行时子进程由 server / 独立 daemon 托管（孤儿回收），Agent 侧不等待。Agent 侧引导采用 **skill 指引**（2026-08-03 决策，见 Q1）。

## 5. 用户场景

| 编号 | 场景 | 期望 |
|---|---|---|
| U1 | Agent 后台下载 10GB 文件 | 用户打开 Web 页，实时看到下载进度输出，行间隔稳定 = 正常 |
| U2 | 长编译/批量任务 | 阶段输出可见，行间隔分布判断瓶颈在哪一步 |
| U3 | 疑似卡死（长时间无输出） | 间隔视图一眼看出"5 分钟没动静"，Web 端可设无输出告警 |
| U4 | 任务跑偏/太久，想中止 | 一键 Ctrl-C，进程组级终止，状态标为 killed |
| U5 | 命令出现交互提示（sudo 密码、ssh 指纹、yes/no） | 初步判断 Agent 无法自动应答（待实测，见 02 报告 §4-O2）；Web 端可代答或先取消 |
| U6 | 脚本化任务（Agent 构建脚本） | 脚本内调用 `tmon.progress("下载", 45)` 等，Web 端显示阶段与百分比 |
| U7 | 多个任务并发 / 历史任务复盘 | 任务列表 + 归档检索 + 回放 |
| U8 | **Agent 自身需要获取任务结果**（后台执行后轮询） | `tmon wait <id>` 阻塞等待并透传退出码，Agent 据此继续后续步骤，无需用户干预 |

## 6. 功能需求（MoSCoW 优先级）

### P0（MVP：必须）
- **FR-1 CLI 封装**：`tmon "curl xxx"` 形式，也可支持 `tmon curl xxx`（字符串化命令，避免 shell 解析二义性）；支持环境变量透传、工作目录指定。
- **FR-2 透明输出**：子进程 stdout/stderr 原样回流到 Agent 侧（含合并顺序语义）；退出码透传；`tmon` 自身报错（如命令不存在）与命令报错可区分。
- ~~FR-1b 强制层~~ **已取消（2026-08-03 决策）**：原计划用 Claude Code PreToolUse hook 强制包装命令，决定放弃强制手段，改为 **skill 指引**——提供 tmon skill 文件，指导 Agent 在长任务/后台任务场景主动使用 tmon。理由：hook 存在边界限制（headless 竞态、`allowedTools: ['*']` 跳过）且强制有副作用；skill 指引温和、跨框架、零维护成本。
- **FR-1d skill 指引（P1，替代 FR-1b）**：随项目交付 `tmon` skill 文件（SKILL.md），内容含：触发场景（长任务/后台任务/需要用户实时监控的命令）、使用模式（`tmon "cmd"` 前台执行、`tmon wait/status` 查询结果、`tmon progress/stage` 进度上报）、注意事项（不包装 tmon 自身命令、复杂命令用字符串形式）。
- **FR-1c Agent 侧状态查询（P1）**：CLI 子命令让 Agent 不依赖 Web 也能获取任务状态与结果（查询式，与 Web 端实时流互补）：
  - `tmon ls` —— 任务列表（id、命令摘要、状态、开始时间、时长、输出行数）
  - `tmon status <id>` —— 单任务状态（running / success / failed / killed）+ 退出码，Agent 轮询循环专用
  - `tmon show <id> [--tail N | --full]` —— 输出快照
  - `tmon wait <id> [--timeout N]` —— 阻塞等待任务完成，透传退出码（配合 `tmon "cmd" &` 后台执行 + 轮询使用，见 U8）
- **FR-3 行级时间戳与间隔**：逐行记录到达时间（毫秒精度）；行间间隔可计算、可聚合（总时长、最长静默、平均速率、间隔分布直方图）；数据落盘（SQLite 或 JSONL）。
- **FR-4 Web 实时视图**：任务列表（状态：running / success / failed / killed）；实时输出流（自动滚动 + 暂停滚动）；**行间隔可视化**（每行左侧时间轴或间距图，卡顿行高亮）；任务耗时统计。
- **FR-5 取消与信号**：Web 端按钮发送 Ctrl-C（SIGINT，Windows 上模拟 Ctrl-C）→ 可升级 SIGTERM → SIGKILL；向**整个进程组**发送（避免子进程逃逸）；状态正确上报为 killed。

### P1（重要）
- **FR-6 静默/缓慢检测**：无输出超时告警（可配置阈值，如 60s）；Web 端自动高亮"卡死疑似段"。
- **FR-7 完整终端交互（PTY 代理）**：TUI 程序（vim、htop、交互式进度条、ssh）可完整运行：ANSI 转义、光标移动、全屏刷新均正确；Web 端用 xterm.js 渲染真实终端。
- **FR-8 输入转发**：Web 端键盘输入 → PTY stdin；支持 Ctrl-C 等控制键透传。
- **FR-9 Agent 侧输出净化 ⚠️**：TUI/ANSI 场景下，回流给 Agent 的输出应剥离 ANSI 转义（或仅保留最后状态帧），避免污染 Agent 的文本解析——**与 FR-2 透明性冲突，需要设计决策**。

### P2（后续）
- **FR-10 脚本进度 API（SDK）**：`tmon.progress(percent, message)` / `tmon.stage(name)` / `tmon.log(...)`；多语言（bash / python / node / rust）；IPC 通道由 tmon 环境变量暴露（如 `TCK_ENDPOINT`），脚本无需知道端口；Web 端渲染阶段步骤 + 百分比进度条。
- **FR-11 多任务并发**：同一 tmon server 下多任务并行，列表 + 筛选。
- **FR-12 历史与回放**：任务归档、按时间轴回放输出（还原当时的"行间间隔"体验）。
- **FR-13 通知**：任务结束/超时告警的 webhook / 桌面通知。

### P3（想法池）
- 间隔异常模式识别（"每 30s 一跳"自动标注）；输出速率曲线；与 Agent 日志关联。

## 7. 非功能需求

| 编号 | 需求 | 指标/说明 |
|---|---|---|
| NFR-1 | 低开销 | 行级缓冲，tmon 引入的端到端延迟 < 5ms；高吞吐输出（MB/s 级）不丢行、不阻塞子进程（背压策略：优先丢弃 Web 侧消费不及时的数据，绝不阻塞子进程） |
| NFR-2 | 可靠性 | 输出落盘（崩溃/断电不丢已记录内容）；Web 断线自动重连（事件序号续传）；server 崩溃可重启恢复任务状态 |
| NFR-3 | 安全 | 默认只监听 127.0.0.1；Token 鉴权（防 DNS rebinding / 局域网嗅探）；跨机部署（Agent 在服务器）时提供 TLS 方案与文档；**tmon 的权限边界 = Agent 的权限边界**（它就是包装器，不额外提权） |
| NFR-4 | 跨平台 | **Windows（本机开发环境）+ Linux（常见 Agent 服务器）+ macOS**；Windows 上需 ConPTY + Ctrl-C 模拟（GenerateConsoleCtrlEvent） |
| NFR-5 | 部署 | 单二进制 / 单包可起步（P0）；server 独立部署模式（Agent 在远程服务器，用户在本地浏览器）作为 v0.2 目标 |
| NFR-6 | 语言与运行时 | ⚠️ 待调研：候选 Rust（单二进制、性能）、Go、Python、Node（node-pty 成熟）——取决于 PTY 库成熟度、Windows 支持、分发便利性 |
| NFR-7 | 编码 | 正确处理 UTF-8 / GBK 等（Windows 中文环境常见 GBK 输出），Web 端统一转 UTF-8 |

## 8. 关键设计问题（待调研 ⚠️）

| 编号 | 问题 | 初步判断 |
|---|---|---|
| Q1 | Agent 使用 tmon 的引导方式 | ✅ **已定（2026-08-03）：skill 指引，放弃 hook 强制**。调研确认 hook 可强制包装（`updatedInput` 重写）但无流式输出（wrapper 仍是实时主通道）、存在边界限制（headless 竞态等）；skill 指引 Agent 在长任务场景主动使用，温和且跨框架 |
| Q2 | **Agent 是否有能力处理终端阻塞等待输入的情况？**（决定全可交互终端代理的必要性） | 维持初步判断（Agent 大概率无法注入 stdin，交互命令挂起至超时），**降级为待实测**（O2）：调研未找到直接证据链；但后台任务无可见性的缺陷已确凿（issue #61568）→ 监控+取消价值获验证，PTY 全交互维持 P1 |
| Q3 | `tmon "cmd" &` 后台执行时，server 如何接管控件生命周期？ | **已定**：wrapper 与 server 分离，后台任务由 server/daemon 托管并回收孤儿进程 |
| Q4 | 输出体积控制 | 行数/字节上限、滚动窗口、日志轮转策略 |
| Q5 | 时间戳语义 | 墙钟时间 vs 单调时钟（间隔计算用单调时钟，展示用墙钟） |
| Q6 | 命名冲突与定名 | **[已验证]** 原构想名 tck 三大注册表全部被占用（crates.io 同领域终端任务应用硬冲突、PyPI、npm）→ 全量筛查 5 字母内候选（tock/tick/tempo/lens/radar/kron/clk/lurk/scry/telem/tide/trce/trac 均不可直接使用）→ **最终定名 `tmon`**（4 字母，terminal monitor，三注册表均可用；2026-08-02 用户确认） |
| Q7 | 与既有生态的关系：asciinema、tmux、ttyd 等是否可底层复用 | **[已验证]** 复用：asciinema 3.0 实时流 relay 模型 + 服务器端模拟器设计、asciinema-player（Apache-2.0）作 Web 视图起点、node-pty（微软维护，ConPTY/forkpty）作 PTY 层、xterm.js 作终端渲染。不复用：ttyd/gotty（通用远程终端，无任务语义）、tmuxctl（纯协议层需自配模拟器） |

## 9. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows 信号模拟复杂度（Ctrl-C 到子进程组） | 高 | 复用 node-pty 的 ConPTY 成熟路径（微软维护，VS Code 验证） |
| PTY + tee + 时间戳性能开销 | 中 | 复用成熟 PTY 库；基准测试验证 NFR-1 |
| ANSI/TUI 输出污染 Agent 上下文（FR-2 vs FR-9 冲突） | 高 | 双通道设计：Web 完整流 / Agent 净化流 |
| 编码问题（GBK） | 中 | NFR-7 统一方案 |
| 输出量与 Web 端渲染性能 | 中 | 虚拟滚动 + 窗口化存储 |
| 安全边界 | 高 | 127.0.0.1 + token + 文档化跨机部署 |
| 命名冲突 | 已解决 | crates.io 同领域硬冲突 → 必须改名，定名前全注册表复验 |
| skill 指引未被 Agent 遵守（无强制手段） | 中 | skill 文档覆盖高频场景；长期可评估监控统计（tmon 使用率） |

## 10. 路线图（调研后定稿）

**技术选型（已定）**：Node.js/TypeScript + node-pty（PTY 层，微软维护，ConPTY/forkpty 跨平台）+ WebSocket 实时流 + xterm.js 终端渲染（可评估直接复用 asciinema-player）；server 借鉴 asciinema relay + 服务器端终端模拟器模型。**命名**：已定名 `tmon`（原构想名 tck 因三注册表冲突弃用，2026-08-02 确认；候选筛查过程见 §8-Q6）。

- **v0.1 MVP（✅ 已完成，2026-08-02/03）**：wrapper（PTY）+ 行时间戳 + Web 实时查看（间隔可视化）+ Ctrl-C 取消 + Agent 侧查询（FR-1c）+ 进度 API（FR-10 提前）+ **Web 端左右分栏工作台与极简风格重构（2026-08-03 验收，见 04-web-design.md）**；Windows 实测通过。
- **v0.2**：Linux/macOS 实测（forkpty 分支）；Agent 输出净化（FR-9）；**skill 指引文件（FR-1d）**；**交互输入实测（O2）**；静默告警（FR-6）。
- **v0.3**：自动化测试；输出体积控制；历史回放动画；通知（FR-13）。
- **v1.0**：发布打包（npm publish + web dist 构建验证）；部署文档（跨机 + TLS）。

## 11. 验收标准（草稿）

1. `tmon "curl -o big.bin <url>"`：Web 端实时显示输出，行间隔可视化，能看出网络快慢变化；Ctrl-C 后子进程（含其子进程组）在 <1s 内终止，状态 = killed，Agent 侧拿到对应退出信号。
2. Agent 侧输出与直接执行 `curl -o big.bin <url>` 完全一致（含退出码）。
3. 长时间无输出任务：Web 端明确标识静默段，可配置阈值触发告警。
4. 交互式命令（如 `ssh` 指纹确认）：若为 v0.2，Web 端可键入回车确认，PTY 表现与本地终端一致。
5. 脚本内 `tmon.progress(50, "解压中")`：Web 端显示阶段与百分比。

## 12. 下一步

1. ✅ 调研 / 定名 / 需求 v0.2 / 详细设计 / v0.1 MVP 实现与验证（2026-08-02/03）。
2. ✅ 决策：放弃 hook 强制层，改 skill 指引（2026-08-03）。
3. 制作 skill 文件（FR-1d：指引 Agent 在长任务/后台任务场景主动使用 tmon）。
4. Linux 实测（forkpty 分支、`/bin/sh`、GBK 编码）。
5. 自动化测试（vitest：协议/executor/server 核心逻辑 + e2e 脚本）。
6. Agent 侧输出净化（FR-9）与静默告警（FR-6）。
7. 发布打包（npm publish、Node 版本策略、web dist 构建验证）。
