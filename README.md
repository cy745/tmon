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
| [docs/01-requirements.md](docs/01-requirements.md) | 需求文档 v0.3（含 2026-08-03 决策：skill 指引替代 hook 强制） |
| [docs/02-research-report.md](docs/02-research-report.md) | 全网调研报告（开源现状、Agent 生态、技术选型、命名冲突，含引用） |
| [docs/03-design.md](docs/03-design.md) | 详细设计 v0.2（事件协议 / JSONL 落盘 / 进程模型 / 进度 IPC / skill 指引） |
| [docs/04-web-design.md](docs/04-web-design.md) | Web 端布局与样式设计 v1.0（左右分栏工作台 + 极简主义风格，已实现验收） |

## 状态

- ✅ 需求 v0.3 + 调研报告 + 详细设计 v0.2（2026-08-02/03）
- ✅ **v0.1 MVP**：wrapper + 时间戳 + Web 实时视图（间隔可视化）+ Ctrl-C 取消 + Agent 查询 + 进度上报（Windows 实测通过）
- ✅ **Web 端 v1.0**：左右分栏任务工作台 + 极简主义风格（2026-08-03 验收通过）
- ✅ 决策：放弃 hook 强制层，改为 **skill 指引**（2026-08-03）
- 🔄 下一步：skill 文件、Linux 实测、自动化测试、输出净化、发布打包

## 技术选型（调研定稿）

Node.js/TypeScript + node-pty（微软维护，ConPTY/forkpty 跨平台）+ WebSocket + xterm.js；server 借鉴 asciinema 的 relay + 服务器端终端模拟器模型（中途加入的观看者立即拿到当前完整状态）。

## 命名历史

原名 tck，因 npm / PyPI / crates.io 三注册表均被占用而弃用；候选全量筛查后定名 **tmon**（2026-08-02）。
