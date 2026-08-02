#!/usr/bin/env node
// tmon CLI 入口 —— Node >=22.18 原生 TypeScript 支持（type stripping），直接导入 .ts
import { main } from '../src/cli.ts';

// 查询类命令自然退出（避免 process.exit 与 fetch/undici 清理的 libuv 断言竞态）；
// 执行类命令（run / 透传）强制退出（Windows 下 node-pty 的 ConPTY handle 残留会 hang）
const QUERY_CMDS = new Set(['serve', 'last', 'ls', 'status', 'show', 'wait', 'kill', 'progress', 'stage', 'help', '--help', '-h']);
const needsForceExit = !QUERY_CMDS.has(process.argv[2]);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    if (needsForceExit) process.exit(code);
  },
  (err) => {
    console.error(`tmon: 内部错误: ${err?.stack ?? err}`);
    process.exit(1);
  },
);
