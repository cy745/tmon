#!/usr/bin/env node
// npm 卸载钩子（preuninstall）：停止 tmon server 实例。
// detached server 不随 npm 卸载退出，卸载前通过 server.pid 清理进程与发现文件。
// 零依赖（仅 node 内置模块）：卸载时依赖目录可能已被移除，不能 require 任何第三方包。
// 与 `tmon kill-server` 逻辑一致；卸载脚本失败不应阻塞卸载，故任何错误都视为成功退出。
// ⚠️ 已知限制：npm 7+ 的全局卸载不执行 preuninstall（npm/cli#3042，长期未修）。
//    可靠路径是文档指引的 `tmon kill-server`；本钩子保留以便 npm 6 / 未来修复 / 本地卸载时生效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = process.env.TMON_DATA_DIR ?? path.join(os.homedir(), '.tmon');
const pidFile = path.join(dataDir, 'server.pid');
const portFile = path.join(dataDir, 'port');

let pid = 0;
try {
  pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
} catch {
  // 无 pid 文件：server 未运行
}
if (Number.isInteger(pid) && pid > 0) {
  try {
    process.kill(pid, 'SIGKILL');
    console.error(`tmon: 卸载清理——已停止 server（pid ${pid}）`);
  } catch {
    // 进程已不存在
  }
}
for (const f of [pidFile, portFile]) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
