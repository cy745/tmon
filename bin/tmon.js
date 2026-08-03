#!/usr/bin/env node
// tmon CLI 入口
// 发布产物：dist/cli.js（esbuild bundle，Node 禁止 node_modules 下运行 .ts）
// 开发模式：src/cli.ts（Node >= 22.18 原生 type stripping，dist 不存在时回退）
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, '..', 'dist', 'cli.js');
const entry = existsSync(distEntry) ? '../dist/cli.js' : '../src/cli.ts';

const { main } = await import(entry);

// 查询类命令自然退出（避免 process.exit 与 fetch/undici 清理的 libuv 断言竞态）；
// 执行类命令（run / 透传）强制退出（Windows 下 node-pty 的 ConPTY handle 残留会 hang）
const QUERY_CMDS = new Set(['serve', 'last', 'ls', 'status', 'show', 'wait', 'kill', 'progress', 'stage', 'skill', 'help', '--help', '-h']);
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
