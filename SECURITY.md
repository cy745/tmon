# Security Policy

## Reporting a Vulnerability

tmon 是开发者工具，权限边界 = 启动它的进程的权限（不额外提权）。

如果你发现了安全相关漏洞（而非一般 bug），**请不要创建公开 issue**，而是通过 GitHub 私有方式联系维护者：

- 创建 issue 时选择 "Security" 标签（GitHub 会视为私有报告），或
- 直接私信仓库维护者（[cy745](https://github.com/cy745)）

我们会在 7 天内确认并处理。

## Scope

- tmon server 的本地鉴权（`~/.tmon/token`、127.0.0.1 绑定）
- PTY 子进程隔离与信号处理
- Web 端输入/输出通道的注入风险
