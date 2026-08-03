<h1 align="center">tmon</h1>

<p align="center">
  <b>AI Agent 长耗时命令的实时终端监控与控制工具</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.18-339933.svg" alt="Node >= 22.18">
  <img src="https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20macOS-lightgrey.svg" alt="Platforms">
  <a href="https://github.com/cy745/tmon/issues"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

---

## tmon 是什么？

AI Agent 执行长任务（大文件下载、编译、数据迁移）时，往往会放到后台——**状态完全不可见**：你无法判断它是卡死了、在缓慢爬行、还是即将完成；出问题时也没有任何干预手段。

**tmon** 用一层透明代理包装命令：

```bash
tmon "curl -o big.bin https://example.com/big.bin"
```

对 Agent 而言行为**完全一致**（同样的输出、同样的退出码），而你获得一个**实时 Web 工作台**：每行输出带时间戳、行间间隔可视化（一眼区分「卡死」与「缓慢」）、进度条、一键 Ctrl-C 取消——还有一个可以亲自键入的完整交互式终端。

## 特性

- 🔍 **透明代理** —— 输出与退出码与直接执行完全一致；零配置（server 自动拉起）
- ⏱️ **逐行时间戳** —— 行间间隔可视化区分「卡死」与「缓慢」，长静默段高亮
- 🖥️ **Web 工作台** —— 任务侧边栏（筛选/搜索/实时微进度）+ 终端视图 + 间隔时间线 + 进度条
- ⌨️ **完整终端交互** —— 在 Web 终端里键入，可代答密码 / Y-N 确认等交互提示
- 🛑 **一键取消** —— Ctrl-C（SIGINT）自动升级，进程组级安全终止
- 🤖 **Agent 可编程接口** —— `tmon wait <id>` 阻塞等待并透传退出码
- 📊 **脚本进度上报** —— 脚本内 `tmon progress 45 "解压中"` → Web 与侧边栏实时进度条
- 🌐 **跨平台** —— Windows（ConPTY）/ Linux / macOS（forkpty）

## 快速开始

```bash
npm install -g @qiu745/tmon

# 包装任意命令
tmon "curl -o big.bin https://example.com/big.bin"

# 打开 Web 工作台（或直接访问 stderr 打印的地址）
tmon serve
```

浏览器打开打印的地址——任务列表即刻可见。

## 用法

```
tmon "命令字符串"                    前台执行（阻塞，输出原样回传，stderr 打印任务 id）
tmon 命令 参数...                     同上，直接透传 argv 形式
tmon last                            最近任务 id
tmon ls                              任务列表
tmon status <id>                     任务状态 + 退出码（Agent 轮询用）
tmon show <id> [--tail N | --full]   输出快照（剥离 ANSI）
tmon wait <id> [--timeout=N]         阻塞等待完成，透传退出码
tmon kill <id> [--signal=SIGINT|SIGTERM|SIGKILL]
tmon progress <pct> <msg>            脚本内进度上报
tmon stage <name>                    脚本内阶段上报
tmon serve                           前台启动 server（默认自动拉起）
```

Agent 后台执行范式：

```bash
tmon "npm run build" &      # stderr 打印任务 id
tmon last                   # 或取最近任务 id
tmon wait 7f2a9c3e          # 阻塞等待完成，退出码透传
```

## 工作原理

```
Agent Bash 工具  →  tmon CLI（PTY 代理）  →  tmon server（事件 + JSONL）
                        │                       │
                        ├─ stdout 原样回传      ├─ WebSocket → Web 工作台
                        └─ chunk 事件           └─ REST → tmon ls/status/wait
                     (seq, 墙钟 ts, 单调 dt)
```

每个输出 chunk 记录墙钟时间戳与单调时钟增量，JSONL 持久化，实时推送到 Web。Web 端用 xterm.js 渲染完整终端（含 ANSI/TUI 输出），间隔时间线按绿→红着色每个输出间隔。

## 安全模型

- 仅监听 `127.0.0.1`。全部 REST 端点校验 Host 头（白名单 `127.0.0.1`/`localhost`/`::1`）与 Origin 头（浏览器请求必须来自本机页面）——DNS rebinding 与 CSRF 一律 403/415 拒绝。
- WebSocket 握手在 upgrade 阶段校验 Origin（CSWSH 防护，RFC 6455 §10.2）；非本机 agent 必须携带 Bearer token；`web` 角色只读（禁止伪造事件）。
- 状态变更端点（`kill`/`input`/`resize`/`progress`）强制 `application/json` content-type——form POST 与 text/plain 伪 JSON（绕过 CORS 预检的注入通道）被拒绝。
- token/port/任务数据文件均为 0600，数据目录 0700（多用户机器上其他用户无法读取任务输出）。
- 本机浏览器访问 Web **默认免认证**（设计取舍）——能打开你桌面浏览器的人即可查看任务输出；跨机部署（TLS + 用户认证）计划在 v1.0。
- tmon 是包装器：权限边界 = Agent 的权限，绝不额外提权。
- **升级**：CLI 通过 `/api/health` 版本握手检测到残留的旧版本 server 时自动替换（pid 文件 + 版本比对），残留旧进程（可能缺少安全修复）不会被复用。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/01-requirements.md](docs/01-requirements.md) | 需求文档 v0.3（含 skill 指引决策） |
| [docs/02-research-report.md](docs/02-research-report.md) | 全网调研报告（含引用来源） |
| [docs/03-design.md](docs/03-design.md) | 详细设计 v0.2（协议 / 落盘 / 进程模型） |
| [docs/04-web-design.md](docs/04-web-design.md) | Web 端设计 v1.0（工作台布局、极简风格） |
| [skills/tmon/SKILL.md](skills/tmon/SKILL.md) | Agent skill：何时用、怎么用 tmon |

## Agent skill 安装

让 Agent 在长任务场景自动使用 tmon：

```bash
cp -r skills/tmon ~/.claude/skills/
```

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run test:security    # 安全测试（tests/security/，启动真实 server 的攻击模拟）
bash tests/e2e-linux.sh   # Linux e2e（POSIX 路径、信号语义）
cd web && npm ci && npx tsc --noEmit
```

issue → 分支 → PR 的协作流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © cy745
