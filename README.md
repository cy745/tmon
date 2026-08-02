# tmon — AI Agent 命令执行追踪与监控工具

> **tmon**（terminal monitor）：为 AI Agent 的长耗时命令执行加一层透明代理，实时记录逐行输出与时间戳，提供 Web 端监控界面（行间隔可视化、一键取消、完整终端交互），并让 Agent 通过 CLI 查询任务状态。

## 核心思路

```
Agent 原本：  curl -o big.bin <url>
Agent 改用：  tmon "curl -o big.bin <url>"    # 输出原样返回，行为透明
```

- **对 Agent 透明**：stdout/stderr、退出码与直接执行一致
- **用户可见**：Web 端实时查看输出，每行带时间戳，**行间间隔可视化**（一眼区分"卡死"与"缓慢"）
- **可干预**：Web 端一键 Ctrl-C（进程组级终止）
- **Agent 可查**：`tmon status <id>` / `tmon wait <id>`（阻塞等待并透传退出码）
- **可扩展**：脚本内 `tmon.progress(45, "解压中")` 上报进度，Web 端渲染进度条

## 文档

| 文档 | 说明 |
|---|---|
| [docs/01-requirements.md](docs/01-requirements.md) | 需求文档 v0.2（已回填调研结论，FR/架构/路线图定稿） |
| [docs/02-research-report.md](docs/02-research-report.md) | 全网调研报告（开源现状、Agent 生态、技术选型、命名冲突，含引用） |

## 状态

- ✅ 需求文档 v0.2 + 调研报告（2026-08-02）
- 🔄 详细设计文档（事件协议 / JSONL 落盘 / hook 强制层 / IPC 进度 API）
- ⬜ v0.1 MVP：wrapper + 行时间戳 + Web 实时视图 + Ctrl-C 取消
- ⬜ v0.2：跨平台（node-pty ConPTY/forkpty）+ PTY 全终端交互 + Agent 侧状态查询 CLI
- ⬜ v0.3：脚本进度 API + 静默告警
- ⬜ v1.0：多任务 + 历史回放 + 部署文档

## 技术选型（调研定稿）

Node.js/TypeScript + node-pty（微软维护，ConPTY/forkpty 跨平台）+ WebSocket + xterm.js；server 借鉴 asciinema 的 relay + 服务器端终端模拟器模型（中途加入的观看者立即拿到当前完整状态）。

## 命名历史

原名 tck，因 npm / PyPI / crates.io 三注册表均被占用而弃用；候选全量筛查后定名 **tmon**（2026-08-02）。
