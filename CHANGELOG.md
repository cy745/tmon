# Changelog

本文件记录 tmon 的显著变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-08-03

### Added

- **`tmon skill` 命令**：输出 Agent skill（SKILL.md）全文（含 frontmatter），Agent 可自行落盘安装（`mkdir -p ~/.claude/skills/tmon && tmon skill > ~/.claude/skills/tmon/SKILL.md`）；文件随包分发（`files` 含 `skills/`），src/dist 模式均从包根定位
- **`tmon kill-server` 命令**：停止 detached server 实例（读 `server.pid` → SIGKILL → 清理 pid/port 发现文件，幂等）——解决卸载后 server 进程残留问题
- **`preuninstall` 卸载钩子**（`scripts/kill-server.js`，零依赖）：npm 6 / 本地卸载 / 未来 npm 修复时自动清理 server。注意 npm 7+ 全局卸载不执行 preuninstall（[npm/cli#3042](https://github.com/npm/cli/issues/3042) 已知 bug），可靠路径是显式 `tmon kill-server`
- **README（中英）"卸载"小节**：`tmon kill-server && npm rm -g @qiu745/tmon && rm -rf ~/.tmon`

### Fixed

- 无

## [0.1.0] - 2026-08-03

初始发布（scoped 包名 `@qiu745/tmon`，因 npm 相似度保护拦截 `tmon` 与 `t-mon` 撞名；豁免申请通过后切回非 scoped 名）。

### Added

- **透明代理执行**：`tmon "cmd"` / `tmon cmd args...`，输出与退出码与直接执行完全一致（PTY 层基于 node-pty，Windows ConPTY / POSIX forkpty）
- **行级时间戳与间隔可视化**：逐 chunk 记录墙钟时间戳 + 单调时钟增量（seq/ts/dt），Web 端热力图区分「卡死」与「缓慢」
- **Web 工作台**：左侧任务侧边栏（筛选/搜索/微进度条）+ 右侧四段式（任务头统计 / 静默告警 / 间隔时间线 / xterm.js 终端）；极简主义风格（近黑 + 强调绿，无圆角无阴影）；hash 路由兼容；<900px 抽屉布局
- **完整终端交互**：Web 终端键盘输入转发 PTY（代答密码/Y-N 提示）、尺寸变化 resize 转发、自动滚动
- **一键取消**：Ctrl-C（SIGINT）进程组级发送，5s 未退自动升级 SIGTERM→SIGKILL（Windows `taskkill /T /F` 兜底）
- **Agent 可编程接口**：`last` / `ls` / `status` / `show` / `wait`（阻塞等待并透传退出码）/ `kill`
- **脚本进度上报**：`tmon progress <pct> <msg>` / `tmon stage <name>`（经环境变量注入的 IPC 通道），Web 实时进度条
- **零配置自动拉起**：server detached 长驻，任何子命令自动探测/拉起，CLI 查询命令不加载 node-pty（规避 Node 25 libuv 噪声）
- **安全加固（P0）**：仅监听 127.0.0.1；REST 全端点 Host 白名单 + Origin 校验（防 DNS rebinding / CSRF）；状态变更端点强制 `application/json`（挡 form POST 与 text/plain 伪 JSON 注入）；WS 校验移至 upgrade 阶段（CSWSH 防护）；web 角色只读（禁止伪造事件）；token/数据文件 0600、目录 0700；附 `tests/security/` 攻击模拟测试（14 用例）
- **server 版本握手**：`/api/health` 返回版本，CLI 检测到旧版本残留 server 自动替换（pid 文件 + 版本比对）
- **单例检查**：`tmon serve` 探测到已有健康 server 直接复用，杜绝多实例并存
- **运行时修复 node-pty 1.1.0 prebuild 缺陷**：`spawn-helper` 缺执行位导致 macOS/Linux 无法启动命令，加载时兜底恢复 755

### Fixed

- 无
