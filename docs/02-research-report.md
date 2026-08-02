# 调研报告：AI Agent 命令执行追踪与监控工具（暂名 tck）

> 日期：2026-08-02 ｜ 方法：deep-research 多路并行调研（5 路搜索角度 → 抓取 23 个来源 → 提取 106 条断言 → 25 条进入对抗性三方验证 → 24 条确认、1 条否决 → 综合）
> 置信度标注：**[已验证]** = 官方文档/上游仓库/注册表 API 直接证实（3-0 票）；**[开放]** = 本次调研未能闭合、需实测或持续跟踪

---

## 1. 执行摘要

**核心判断：你的构想目前没有功能完全等效的开源实现——它不是「已被做出来的东西」，而是一块「积木齐备但缺少一体化封装」的白地。** 但三个关键事实会影响后续决策：

1. **各核心组件均有成熟积木可拼装**（asciinema 实时流、node-pty、xterm.js、Claude Code hooks），无需从零造轮子，但也意味着**差异化价值必须落在「面向 Agent 的一体化封装 + 控制通道 + 进度语义」上**，单做「Web 看终端」没有意义。
2. **Claude Code 生态有两个重要发现**：① PreToolUse hook 能拦截/重写/取消 Bash 命令（可作为「强制 Agent 使用 tck」的机制），但 hook **看不到流式输出**（PostToolUse 只有事后完整结果）——所以 wrapper 仍是实时输出的唯一主通道，hook 只是强制层；② Claude Code 后台任务**无时长上限、无内置可见性**（issue #61568 官方确认），「用户和模型都看不到在跑什么」是确凿的痛点，且可能让 headless 模式永久挂起——**这正面验证了本项目的最小价值（看得见 + 能取消）**。
3. **命名必须改**：`tck` 在 crates.io（同领域终端任务应用！）、PyPI、npm 三大注册表**全部被占用**，且 crates.io 是硬性全局唯一、无法同名发布。

## 2. 核心结论

### 2.1 结论一：无等效开源实现，属「白地」，但积木齐备 [已验证]

对全行业扫描（web 终端网关、终端录制回放、实时日志、命令插桩、agent 可观测性）后确认：**没有一个现成工具同时具备「拦截 Agent 命令 + 实时行级时间戳 + Web 监控 + Ctrl-C 取消 + 脚本进度 API」**。最接近的三个方向都差关键一块：

| 方向 | 代表 | 差什么 |
|---|---|---|
| 终端实时流 | asciinema 3.0 | 单向广播（无输入转发、无 Ctrl-C 注入）——这是与 tck 构想的**本质差距** |
| Web 终端网关 | ttyd / gotty / wetty | 通用远程终端，无任务语义、无行时间戳、无取消、不面向 Agent |
| Agent 可观测性 | claude-code-observer、AgentTrace | 事后遥测/会话分析，不拦截命令、不实时、无控制通道 |

### 2.2 结论二：Claude Code 生态——hooks 是强制层，wrapper 是主通道 [已验证]

- **PreToolUse hook 可拦截、可重写、可取消 Bash 工具调用**：官方文档确认 hook 在工具执行前触发，收到含完整 `command`/`timeout`/`run_in_background` 的 JSON；通过 `hookSpecificOutput.updatedInput` 可在执行前把 `curl xxx` 重写为 `tck "curl xxx"`；exit code 2 或 `permissionDecision: "deny"` 可完全阻断。
- **hook 拿不到流式输出**：PostToolUse 只在整条命令成功后触发（只能改写最终结果）；MessageDisplay 仅影响屏显、不改写模型所见。→ **实时输出的唯一通道就是 wrapper 进程本身**，hook 只能做「确保 Agent 必须走 wrapper」的强制层。
- **已知边界情况**（削弱 hook 可靠性，需测试）：headless/-p 模式存在异步竞态、`allowedTools: ['*']` 会跳过钩子管道、MCP 工具不强制 deny。交互模式下对 Bash 命令可靠。
- **后台任务可见性缺陷确凿**：issue #61568 官方确认 `run_in_background` 「无时长上限、无内置方式让用户或模型看到正在跑什么」，buggy 轮询可跑数小时无人知晓、headless 下可能永不退出；issue #58297 确认 agents view 会把空闲 agent 因后台 bash 未结束而错误标为 Working（v2.1.141 修复）。→ 监控 + 取消的价值获正面验证。

### 2.3 结论三：Agent 能否处理交互式阻塞输入？——仍属开放 [开放]

调研未能找到直接证据链证明「主流 Agent 的 Bash 工具能向子进程 stdin 注入交互输入」。维持需求文档中的初步判断：**大概率不能**（命令挂起至超时），但触发频率与规避策略（`--batch`/`-y`/`< /dev/null`）未知。**对路线图的影响**：全交互 PTY 代理定为 P1 而非 P0 的判断不变；建议在 v0.1 后用真实场景实测（见 §4 开放问题 O2）。同时注意 asciinema 的实时流是单向广播——**输入转发/Ctrl-C 注入是 tck 相对所有现成工具的独特卖点**，即使 Agent 侧很少需要，用户侧（Web 代答 sudo 密码等）依然成立。

### 2.4 结论四：技术路线——Node.js + node-pty + xterm.js，借鉴 asciinema 模型 [已验证]

- **PTY 层**：node-pty（MIT，**微软维护**，VS Code/Hyper/Theia/Wetty 在用）同时提供 forkpty（Linux/macOS）与 ConPTY（Windows 10+）绑定，`onData`/`write` 即输出流式 + 输入转发——跨平台全交互代理的地基已被大型项目验证。
- **Web 监控层**：asciinema CLI 3.0 原生支持实时终端流（ALiS 协议：WebSocket 二进制 + 微秒时间戳），采用**生产者-CLI → 服务器继电器 → 消费者播放器**模型，且服务器端自带虚拟终端模拟器（avt），使**中途加入的观看者立即拿到当前完整终端状态**（而非从任务开始重放）——这个模型直接可借鉴为 tck server 的设计。asciinema-player（Apache-2.0，2913 stars）可作为 Web 终端视图的起点。
- **反面案例**：Rust 路线（tmuxctl）是纯协议层，明确不做终端模拟/渲染/UI，需自配 vt100/avt 模拟器与渲染器——自研成本高，不推荐 v1 走 Rust。

### 2.5 结论五：命名冲突——必须改名 [已验证]

| 注册表 | `tck` 占用情况 | 严重度 |
|---|---|---|
| crates.io | Rust 二进制终端任务应用 v0.2.0（"A tactile terminal task app for fast capture and triage"）——**同领域** | 硬冲突（全局唯一，无法发布同名 crate） |
| PyPI | `tck` v1.0.0（Time-Series-Cluster-Kernel 包） | 冲突 |
| npm | `tck` v1.2.0（JavaScript 类型检查库） | 冲突 |

短名基本全军覆没（trk/trak/trax/tsk 在 npm 均被占用）。**候选方向**（2026-08-02 在 npm 验证可用，正式定名前需在 crates.io/PyPI/GitHub 复验）：

- `termtrace` ✅ npm 可用 —— 语义直白（终端追踪）
- `cmdcast` ✅ npm 可用 —— 呼应「命令直播」的实时广播感
- `watchterm` ✅ npm 可用 —— 强调监控
- `taskcast` ✅ npm 可用 —— 强调任务流

## 3. 现有工具全景（与 tck 的关系定位）

| 工具 | 定位 | 可复用部分 | 与 tck 的本质差异 |
|---|---|---|---|
| asciinema 3.0 + asciinema server | 终端会话录制/实时流（WebSocket 二进制，微秒时间戳，relay 模型 + 服务器端模拟器） | 实时流协议与 relay 架构设计；asciinema-player 直接可做 Web 视图 | **单向广播**：无输入转发、无 Ctrl-C 注入、无任务/取消/进度语义 |
| ttyd / gotty / wetty | 浏览器访问真实终端 | node-pty + xterm.js 组合范式 | 通用远程终端：无 Agent 适配、无行时间戳/间隔可视化、无任务管理 |
| dozzle | Docker 容器日志 Web 查看 | 实时日志 UI 范式 | 仅容器日志源，非宿主任意命令、无插桩 API |
| moreutils `ts` | 命令输出逐行加时间戳 | 时间戳思路 | 仅文本前缀，无 Web、无控制、无记录 |
| claude-code-observer | Claude Code 可观测性仪表盘（Go + OTel + Bubble Tea TUI） | agent 遥测思路 | 事后遥测，不拦截命令、无 Web、无实时 |
| AgentTrace | Agent 会话历史离线分析 TUI | 会话分析思路 | 离线审计，与实时/交互无关 |
| tmuxctl (Rust) | tmux 协议层 | PTY/协议参考 | 纯协议，需自配模拟器与渲染器 |

## 4. 开放问题（需实测或持续跟踪）

| 编号 | 问题 | 影响 | 建议动作 |
|---|---|---|---|
| O1 | headless/-p 模式下 PreToolUse hook 的异步竞态、`allowedTools:['*']` 跳过钩子等边界是否削弱强制层可靠性 | hook 强制层设计 | v0.1 做 Hook 冒烟测试矩阵 |
| O2 | 交互式阻塞输入在真实 Agent 工作流中的触发频率与规避策略 | 决定 PTY 全交互的优先级 | v0.1 后对 Claude Code 实测（sudo 提示、ssh 指纹、yes/no、TUI 程序各测一轮） |
| O3 | Codex / gemini-cli / OpenHands 等非 Claude 框架的 stdin 能力 | 决定是否做跨框架统一包装器 | 若未来要支持多框架再调研 |
| O4 | LangSmith/Langfuse/OTel GenAI 是否已有等价的行间隔热图 / 进度上报能力 | 决定自研 vs 集成 | 若用户已在用这些平台，优先看其 tracing 扩展点 |
| O5 | Claude Code hooks / 后台任务行为持续迭代（活跃开发中） | 兼容性 | 设计上把 hook 强制层做成可开关、可降级 |

## 5. 对需求文档的修订建议

1. **更名**（§8-Q6 → 已确认冲突）：全文 `tck` 改为占位名，候选 §2.5。
2. **架构增加「hook 强制层」**（§4）：PreToolUse hook 用 `updatedInput` 把裸命令重写为 wrapper 调用；wrapper 是实时输出唯一主通道。
3. **技术选型定稿**（§10）：Node.js + node-pty（PTY 层）+ xterm.js/asciinema-player（Web 视图）+ WebSocket（实时流）；server 借鉴 asciinema relay + 服务器端模拟器模型（中途加入者拿当前状态）。
4. **差异化定位写进目标**（§2）：区别于 ttyd 等通用终端的关键点 = 面向 Agent 的命令拦截 + 任务语义 + 控制通道（取消/输入）+ 进度 API。
5. **Q2 结论降级为「待实测」**：交互式输入能力维持 P1，但路线图加 O2 实测步骤。
6. **风险表补充**：hook 边界情况（O1）与命名冲突已解决但「改名」需在定名时全注册表复验。

## 附：核心已验证断言清单（投票 = 三方对抗验证）

| 断言 | 置信度 | 来源 |
|---|---|---|
| asciinema CLI 3.0 原生支持实时终端流（ALiS/WebSocket/微秒时间戳），relay + 服务器端模拟器模型 | high (3-0) | docs.asciinema.org/manual/server/streaming/ |
| asciinema-player 是成熟浏览器播放器（Apache-2.0） | high (3-0) | github.com/asciinema/asciinema-player |
| Dozzle 仅支持 Docker 系日志源，非宿主任意命令 | high (3-0) | dozzle.dev |
| PreToolUse hook 可拦截、updatedInput 可重写命令、exit 2/deny 可取消 Bash 调用 | high (3-0) | code.claude.com/docs/en/hooks |
| hook 看不到流式输出（PostToolUse 事后、MessageDisplay 仅展示） | high (3-0) | code.claude.com/docs/en/hooks + issue #11224 |
| claude-code-observer 走 OTel + TUI，无 Web、无拦截 | high (3-0) | github.com/kamikaze011001/claude-code-observer |
| AgentTrace 是离线会话历史分析，不实时 | high (3-0) | github.com/luoyuctl/agenttrace |
| run_in_background 无时长上限、无内置可见性 | medium (2-1) | issue #61568、#58297 |
| node-pty 是微软维护的成熟跨平台 PTY 库（forkpty/ConPTY，onData/write 流式+输入） | high (3-0) | github.com/microsoft/node-pty |
| holdpty 验证 node-pty 三平台抽象；tmuxctl 纯协议层不自带模拟器 | high (3-0) | github.com/marcfargas/holdpty、ace-rs/tmuxctl |
| `tck` 在 crates.io（终端任务应用）与 PyPI 均被占用 | high (3-0) | crates.io/api/v1/crates/tck、pypi.org/pypi/tck/json |
| 【被否决】PreToolUse 不能修改工具输入参数 | 0-3 否决 | issue #4368（与官方文档冲突，文档胜出） |
