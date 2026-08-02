---
name: tmon
description: 用 tmon 包装长耗时命令执行，提供 Web 端实时监控（逐行输出/行间间隔/进度百分比）与一键取消能力，并通过 CLI 查询任务结果。当需要执行耗时较长的命令（大文件下载、编译、批量处理、数据迁移、长测试等），或需要用户实时观察进度、可能需要在执行中取消的任务时，使用 tmon。
---

# tmon 使用指引

tmon 是命令执行追踪工具：把命令包装进 tmon 后，命令行为与直接执行完全一致（输出原样返回、退出码透传），同时用户可以在 Web 端实时看到输出、行间间隔（判断卡死 vs 缓慢）与进度，并可一键 Ctrl-C 取消。

## 何时使用

- 预计执行超过约 30 秒的命令（下载、编译、批量任务、迁移、长测试）
- 需要用户实时看到进度、或可能在执行中被取消的任务
- 任务可能长时间无输出，用户需要区分「卡死」与「缓慢」的场景
- 用户需要在任务执行中干预（中止、代答交互提示）的场景

## 使用模式

### 1. 前台执行（推荐，行为透明）

把命令字符串包进 tmon 即可，输出与退出码与直接执行完全一致：

```
tmon "curl -o big.bin https://example.com/big.bin"
tmon "npm run build"
tmon "rsync -a /data/ /backup/"
```

复杂命令（含管道、引号、重定向）用**字符串形式**（外层引号包裹）。简单命令也可直接透传参数：`tmon ls -la`。

### 2. 后台执行 + 查询结果

需要将任务放到后台时，使用 shell 的后台化（`&`）或工具自带的后台执行能力，然后通过 CLI 查询：

```
tmon "npm run build" &        # stderr 会打印任务 id：tmon: task 7f2a9c3e started
tmon last                     # 或获取最近任务 id
tmon wait 7f2a9c3e            # 阻塞等待完成，退出码透传（0/非 0 可编程判断）
tmon status 7f2a9c3e          # 或轮询状态（running/success/failed/killed）
tmon show 7f2a9c3e --tail 20  # 查看输出快照
```

### 3. 脚本内进度上报

在由 tmon 启动的脚本中，直接调用 tmon 子命令上报进度（tmon 会自动注入所需环境变量）：

```
tmon progress 45 "解压中"     # 百分比 + 阶段消息
tmon stage "编译"             # 仅阶段名
```

Web 端会实时显示进度条与当前阶段；侧边栏任务列表同步显示微进度条。

## 注意事项

- **不要包装 tmon 自身命令**：`tmon ls / status / wait / show / progress / stage / last / kill` 直接调用，不要嵌套
- 命令输出含 ANSI 控制字符属正常现象（Web 端显示完整终端流）
- 交互式提示（密码、Y/N 确认）：
  - 优先给命令添加非交互参数（`--batch`、`-y`、`< /dev/null`）
  - 若必须交互，用户可在 Web 端终端窗口中直接输入代答
- 命令失败时 tmon 透传退出码；Agent 用 `tmon wait <id>` 的退出码做流程判断
- 长时间无输出不一定是卡死——Web 端间隔视图可区分「静默但活着」与「真卡死」
