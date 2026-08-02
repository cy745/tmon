// PTY 执行器（docs/03-design.md §6）：单进程内联
// 职责：创建 PTY 子进程 → 编码清洗 → 逐 chunk 事件（seq/ts/dt 单调时钟）上报 server
//       → 接收 server 转发的控制指令（kill/input/resize）→ 退出码透传
import { spawn, type IPty } from 'node-pty';
import { exec } from 'node:child_process';
import WebSocket from 'ws';
import type { TaskMeta, TaskStatus, WsServerMsg } from './protocol.ts';
import { cleanChunk } from './encoding.ts';

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
}

export interface ExecutorResult {
  status: TaskStatus;
  exitCode: number | null;
}

const WIN = process.platform === 'win32';

export function runTask(opts: ExecutorOptions): Promise<ExecutorResult> {
  return new Promise((resolve) => {
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

    function escalateKill(): void {
      if (upgradeTimer) clearTimeout(upgradeTimer);
      pendingKill = 'SIGKILL';
      if (!pty) return;
      if (WIN) {
        // ConPTY 无信号语义：进程树强杀
        exec(`taskkill /PID ${pty.pid} /T /F`, () => { /* ignore */ });
      } else {
        try { pty.kill('SIGKILL'); } catch { /* ignore */ }
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
        try { pty.kill('SIGINT'); } catch { /* ignore */ }
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
        // ① 原样写回 stdout（Agent 侧透明，含 ANSI）
        process.stdout.write(cleaned);
        // ② 上报 server（Web 端完整流）
        emit({ type: 'output', stream: 'stdout', data: cleaned });
      });
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
