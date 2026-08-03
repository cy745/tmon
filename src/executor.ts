// PTY 执行器（docs/03-design.md §6）：单进程内联
// 职责：创建 PTY 子进程 → 编码清洗 → 逐 chunk 事件（seq/ts/dt 单调时钟）上报 server
//       → 接收 server 转发的控制指令（kill/input/resize）→ 退出码透传
import { spawn, type IPty } from 'node-pty';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import WebSocket from 'ws';
import type { TaskMeta, TaskStatus, WsServerMsg } from './protocol.ts';
import { cleanChunk } from './encoding.ts';
import { stripAnsi } from './sanitize.ts';

/** 事件负载（不含 seq/ts/dt，由 emit 填充） */
type EventBody =
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'progress'; pct: number; msg?: string }
  | { type: 'stage'; name: string }
  | { type: 'status'; status: TaskStatus; exitCode: number | null };

export interface ExecutorOptions {
  taskId: string;
  token: string;
  port: number;
  cmd: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Agent 侧输出净化（FR-9）：默认剥离 ANSI；--raw 关闭 */
  cleanStdout?: boolean;
}

export interface ExecutorResult {
  status: TaskStatus;
  exitCode: number | null;
}

const WIN = process.platform === 'win32';

/** node-pty 1.1.0 的 prebuild 产物发布时丢失了执行位（macOS/Linux 的 spawn-helper 为 644），
 *  直接 spawn 会 posix_spawnp EACCES。npm 解包不会恢复该位，这里运行时兜底 chmod +x。
 *  （node-pty prebuilds 只在 prebuild 下载路径生效；node-gyp 本地编译产物不受影响） */
function ensureSpawnHelper(): void {
  if (WIN) return;
  const require = createRequire(import.meta.url);
  let ptyRoot: string;
  try {
    ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return; // node-pty 未安装（理论上不会发生，run 命令必装）
  }
  const candidates = [
    path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
  for (const p of candidates) {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      // 不存在或已可执行，忽略
    }
  }
}

export function runTask(opts: ExecutorOptions): Promise<ExecutorResult> {
  return new Promise((resolve) => {
    ensureSpawnHelper();
    const { taskId, token, port, cmd } = opts;
    const shell = WIN ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
    const shellArgs = WIN ? ['/c', cmd] : ['-c', cmd];

    let pty: IPty | null = null;
    let ws: WebSocket | null = null;
    let seq = 0;
    let lastMono = process.hrtime.bigint();
    let finished = false;
    let pendingKill: 'SIGINT' | 'SIGKILL' | null = null;
    let upgradeTimer: NodeJS.Timeout | null = null;
    let stdinBridge: (chunk: Buffer) => void = () => {};

    function emit(ev: EventBody): void {
      const now = process.hrtime.bigint();
      const dt = Number(now - lastMono) / 1e6;
      lastMono = now;
      const full = { ...ev, seq: ++seq, ts: Date.now(), dt };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: full }));
      }
    }

    function sendStatus(status: TaskStatus, exitCode: number | null): void {
      emit({ type: 'status', status, exitCode });
    }

    function finish(status: TaskStatus, exitCode: number | null): void {
      if (finished) return;
      finished = true;
      if (upgradeTimer) clearTimeout(upgradeTimer);
      // 恢复宿主终端状态（若启用了 stdin 转发）
      try {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
          process.stdin.off('data', stdinBridge);
        }
      } catch { /* ignore */ }
      try { sendStatus(status, exitCode); } catch { /* server 已断 */ }
      // 等待事件 flush 后关闭
      setTimeout(() => {
        try { ws?.close(); } catch { /* ignore */ }
        try {
          if (WIN) {
            // Windows：不调 pty.kill() —— 与 libuv 存在 UV_HANDLE_CLOSING 断言竞态（node-pty 已知问题）
            // 进程树由 taskkill 兜底清理；ConPTY handle 残留由 bin 的 process.exit 回收
            if (pty?.pid) exec(`taskkill /PID ${pty.pid} /T /F`, () => { /* ignore */ });
          } else {
            pty?.kill('SIGKILL');
          }
        } catch { /* 已退出 */ }
        resolve({ status, exitCode });
      }, 120);
    }

    function killGroup(signal: 'SIGINT' | 'SIGKILL'): void {
      // POSIX：向整个前台进程组发信号（forkpty 子进程是会话 leader，-pid 即 pgid）。
      // 只杀直接子进程（sh）会因 sh 延迟处理 SIGINT 而无法终止孙进程（issue #1）
      if (!pty) return;
      try {
        process.kill(-pty.pid, signal);
      } catch {
        try { pty.kill(signal); } catch { /* ignore */ }
      }
    }

    function escalateKill(): void {
      if (upgradeTimer) clearTimeout(upgradeTimer);
      pendingKill = 'SIGKILL';
      if (!pty) return;
      if (WIN) {
        // ConPTY 无信号语义：进程树强杀
        exec(`taskkill /PID ${pty.pid} /T /F`, () => { /* ignore */ });
      } else {
        killGroup('SIGKILL');
      }
    }

    function applyKill(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
      if (!pty || finished) return;
      if (signal === 'SIGKILL') {
        escalateKill();
        return;
      }
      if (signal === 'SIGTERM') {
        escalateKill(); // POSIX 下 SIGTERM→SIGKILL 简化处理（MVP）
        return;
      }
      // SIGINT（Ctrl-C）
      if (pendingKill === 'SIGINT') {
        // 再次点击 → 升级强杀
        escalateKill();
        return;
      }
      pendingKill = 'SIGINT';
      if (WIN) {
        // ConPTY 写入 \x03 等价真实 Ctrl-C：程序可捕获并优雅退出
        try { pty.write('\x03'); } catch { /* ignore */ }
      } else {
        killGroup('SIGINT');
      }
      upgradeTimer = setTimeout(() => escalateKill(), 5000); // D6：5s 未退升级
    }

    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });

    ws.on('open', () => {
      const meta: Omit<TaskMeta, 'id' | 'status' | 'exitCode' | 'startedAt' | 'endedAt' | 'seq'> = {
        cmd,
        cwd: opts.cwd ?? process.cwd(),
        pid: process.pid,
        mode: 'pty',
      };
      ws!.send(JSON.stringify({ hello: { token, role: 'agent', taskId, meta } }));
    });

    // server 注册完成后下发 welcome，此时才启动 PTY（保证事件顺序）
    ws.on('message', (raw) => {
      let msg: WsServerMsg;
      try {
        msg = JSON.parse(raw.toString()) as WsServerMsg;
      } catch {
        return;
      }
      if ('welcome' in msg && !pty) {
        startPty();
        return;
      }
      if ('cmd' in msg && pty) {
        const c = msg.cmd;
        if (c.kind === 'kill') applyKill(c.signal);
        else if (c.kind === 'input') pty.write(c.data);
        else if (c.kind === 'resize') pty.resize(c.cols, c.rows);
      }
    });

    ws.on('close', () => {
      if (!finished) {
        console.error(`tmon: 与 server 的连接断开，监控中断（任务继续执行，id=${taskId}）`);
      }
    });
    ws.on('error', () => {
      if (!finished) {
        console.error(`tmon: server 连接错误，监控中断（任务继续执行，id=${taskId}）`);
      }
    });

    function startPty(): void {
      try {
        pty = spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: opts.cols ?? 120,
          rows: opts.rows ?? 30,
          cwd: opts.cwd,
          env: {
            ...process.env,
            TMON_TASK_ID: taskId,
            TMON_TOKEN: token,
            TMON_ENDPOINT: `127.0.0.1:${port}`,
          },
        });
      } catch (err) {
        // 命令无法启动（如 shell 不存在）：直接失败
        console.error(`tmon: 无法启动命令: ${err}`);
        finish('error', 1);
        return;
      }
      pty.onData((data) => {
        const cleaned = cleanChunk(data);
        // ① 写回 stdout（Agent 侧；默认剥离 ANSI 防污染解析，--raw 时原样）
        process.stdout.write(opts.cleanStdout === false ? cleaned : stripAnsi(cleaned));
        // ② 上报 server（Web 端完整流）
        emit({ type: 'output', stream: 'stdout', data: cleaned });
      });
      // ③ 宿主 stdin 是 TTY（人类用户在前台终端运行 tmon）时：本机键盘转发到 PTY，
      //    与 Web 端输入并行可用；Agent 场景 stdin 非 TTY，自动不转发（不干扰 Agent）
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(true);
        } catch { /* ignore */ }
        stdinBridge = (chunk) => {
          if (!finished) pty?.write(chunk.toString());
        };
        process.stdin.on('data', stdinBridge);
      }
      pty.onExit(({ exitCode, signal }) => {
        // Windows 无信号概念：Ctrl-C 表现为 STATUS_CONTROL_C_EXIT (0xC000013A)
        const ctrlC = WIN && (exitCode ?? 0) >>> 0 === 0xc000013a;
        if (signal || ctrlC || pendingKill) {
          finish('killed', exitCode ?? 130);
        } else {
          finish(exitCode === 0 ? 'success' : 'failed', exitCode ?? 1);
        }
      });
    }
  });
}
