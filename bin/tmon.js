#!/usr/bin/env node
// tmon CLI 入口 —— Node >=22.18 原生 TypeScript 支持（type stripping），直接导入 .ts
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).then(
  (code) => {
    // 强制退出：Windows 下 node-pty 的 ConPTY handle 可能残留导致进程 hang
    process.exit(code);
  },
  (err) => {
    console.error(`tmon: 内部错误: ${err?.stack ?? err}`);
    process.exit(1);
  },
);
