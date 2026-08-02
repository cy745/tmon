// tmon CLI 命令面（docs/03-design.md §2）
import crypto from 'node:crypto';
import { ensureServer } from './discover.ts';
import { runTask } from './executor.ts';
import { reportProgress } from './progress.ts';
import { serve as startServer } from './server.ts';
import { toReadableText } from './sanitize.ts';
import type { TaskEvent, TaskMeta, TaskStatus } from './protocol.ts';

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return help();
  if (cmd === 'serve') {
    await startServer();
    return 0;
  }
  if (cmd === 'run') return run(rest);
  if (cmd === 'last') return last();
  if (cmd === 'ls') return ls();
  if (cmd === 'status') return status(rest[0]);
  if (cmd === 'show') return show(rest);
  if (cmd === 'wait') return wait(rest);
  if (cmd === 'kill') return kill(rest);
  if (cmd === 'progress') return progress(rest);
  if (cmd === 'stage') return stage(rest);
  // 兜底：`tmon "cmd string"` 与 `tmon cmd args...` 透传形式
  return run(argv);
}

async function api(port: number, token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error('tmon: 用法: tmon "命令字符串"  或  tmon 命令 参数...');
    return 2;
  }
  const cmd = argv.join(' ');
  const { port, token } = await ensureServer();
  const taskId = crypto.randomBytes(4).toString('hex');
  // stderr 打印任务 id，不污染 stdout（Agent 可后台执行后由此取 id）
  console.error(`tmon: task ${taskId} started: ${cmd}`);
  const result = await runTask({ taskId, token, port, cmd });
  if (result.status === 'killed') {
    console.error(`tmon: task ${taskId} 已终止（killed）`);
    return 130;
  }
  if (result.status === 'error') {
    console.error(`tmon: task ${taskId} 执行错误`);
    return 1;
  }
  if (result.status === 'failed') {
    console.error(`tmon: task ${taskId} 失败，exit code = ${result.exitCode}`);
    return result.exitCode ?? 1;
  }
  return 0;
}

async function last(): Promise<number> {
  const { port, token } = await ensureServer();
  const res = await api(port, token, '/api/tasks');
  const { tasks } = (await res.json()) as { tasks: TaskMeta[] };
  if (tasks.length === 0) {
    console.error('tmon: 暂无任务');
    return 1;
  }
  process.stdout.write(tasks[0].id + '\n');
  return 0;
}

async function ls(): Promise<number> {
  const { port, token } = await ensureServer();
  const res = await api(port, token, '/api/tasks');
  const { tasks } = (await res.json()) as { tasks: TaskMeta[] };
  if (tasks.length === 0) {
    console.log('(暂无任务)');
    return 0;
  }
  process.stdout.write('ID         STATUS     ELAPSED   CMD\n');
  for (const t of tasks) {
    const elapsed = t.endedAt ? t.endedAt - t.startedAt : Date.now() - t.startedAt;
    process.stdout.write(
      `${t.id.padEnd(10)} ${t.status.padEnd(10)} ${fmtDur(elapsed).padEnd(9)} ${t.cmd.slice(0, 60)}\n`,
    );
  }
  return 0;
}

async function status(id?: string): Promise<number> {
  if (!id) return usage('status <id>');
  const { port, token } = await ensureServer();
  const res = await api(port, token, `/api/tasks/${id}`);
  if (!res.ok) {
    console.error(`tmon: 任务 ${id} 不存在`);
    return 1;
  }
  const { task } = (await res.json()) as { task: TaskMeta };
  const elapsed = task.endedAt ? task.endedAt - task.startedAt : Date.now() - task.startedAt;
  console.log(`id:        ${task.id}`);
  console.log(`status:    ${task.status}`);
  console.log(`exit code: ${task.exitCode ?? '-'}`);
  console.log(`elapsed:   ${fmtDur(elapsed)}`);
  console.log(`cmd:       ${task.cmd}`);
  return 0;
}

async function show(argv: string[]): Promise<number> {
  const id = argv[0];
  const tailFlag = argv.includes('--full') ? Infinity : parseTail(argv);
  if (!id) return usage('show <id> [--tail N | --full]');
  const { port, token } = await ensureServer();
  const res = await api(port, token, `/api/tasks/${id}/events`);
  if (!res.ok) {
    console.error(`tmon: 任务 ${id} 不存在`);
    return 1;
  }
  const { events } = (await res.json()) as { events: TaskEvent[] };
  let raw = '';
  for (const ev of events) {
    if (ev.type === 'output') raw += ev.data;
  }
  const lines = toReadableText(raw).split('\n');
  const tail = tailFlag === Infinity ? lines.length : Math.min(tailFlag, lines.length);
  for (const line of lines.slice(lines.length - tail)) {
    process.stdout.write(line + '\n');
  }
  return 0;
}

async function wait(argv: string[]): Promise<number> {
  const id = argv[0];
  const timeoutArg = argv.find((a) => a.startsWith('--timeout'));
  const timeout = timeoutArg ? Number(timeoutArg.split('=')[1] ?? timeoutArg.split(' ')[1]) : 0;
  if (!id) return usage('wait <id> [--timeout=N]');
  const { port, token } = await ensureServer();
  const start = Date.now();
  for (;;) {
    const res = await api(port, token, `/api/tasks/${id}`);
    if (!res.ok) {
      console.error(`tmon: 任务 ${id} 不存在`);
      return 1;
    }
    const { task } = (await res.json()) as { task: TaskMeta };
    if (task.status !== 'running') {
      if (task.status === 'success') return 0;
      if (task.status === 'killed') return 130;
      return task.exitCode ?? 1;
    }
    if (timeout > 0 && Date.now() - start > timeout * 1000) {
      console.error(`tmon: 等待超时（${timeout}s）`);
      return 124;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function kill(argv: string[]): Promise<number> {
  const id = argv[0];
  const sigArg = argv.find((a) => a.startsWith('--signal'));
  const signal = sigArg ? sigArg.split('=')[1] ?? 'SIGINT' : 'SIGINT';
  if (!id) return usage('kill <id> [--signal=SIGINT|SIGTERM|SIGKILL]');
  const { port, token } = await ensureServer();
  const res = await api(port, token, `/api/tasks/${id}/kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    console.error(`tmon: ${body?.error ?? 'kill 失败'}`);
    return 1;
  }
  console.log(`tmon: 已向任务 ${id} 发送 ${signal}`);
  return 0;
}

async function progress(argv: string[]): Promise<number> {
  const pct = Number(argv[0]);
  const msg = argv.slice(1).join(' ');
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return usage('progress <pct> <msg>');
  try {
    await reportProgress({ pct, msg });
    return 0;
  } catch (err) {
    console.error(`tmon: ${(err as Error).message}`);
    return 1;
  }
}

async function stage(argv: string[]): Promise<number> {
  const name = argv.join(' ');
  if (!name) return usage('stage <name>');
  try {
    await reportProgress({ stage: name });
    return 0;
  } catch (err) {
    console.error(`tmon: ${(err as Error).message}`);
    return 1;
  }
}

function parseTail(argv: string[]): number {
  const i = argv.indexOf('--tail');
  if (i >= 0) {
    const n = Number(argv[i + 1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 50;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function usage(msg: string): number {
  console.error(`tmon: 用法错误: ${msg}`);
  return 2;
}

function help(): number {
  console.log(`tmon — AI Agent 命令执行追踪与监控

用法:
  tmon "命令字符串"                 前台执行（阻塞，输出原样回传；stderr 打印任务 id）
  tmon 命令 参数...                 直接透传形式（等价字符串化）
  tmon last                         最近任务 id（后台执行后取 id）
  tmon ls                           任务列表
  tmon status <id>                  单任务状态（Agent 轮询）
  tmon show <id> [--tail N|--full]  输出快照（剥离 ANSI）
  tmon wait <id> [--timeout=N]      阻塞等待完成，透传退出码
  tmon kill <id> [--signal=SIGINT|SIGTERM|SIGKILL]   取消任务
  tmon progress <pct> <msg>         脚本内进度上报
  tmon stage <name>                 脚本内阶段上报
  tmon serve                        前台启动 server（默认自动拉起）`);
  return 0;
}
