// Web → tmon server 的 REST/WS 客户端（协议见 docs/03-design.md §4）

export type TaskStatus = 'running' | 'success' | 'failed' | 'killed' | 'error';

export interface TaskMeta {
  id: string;
  cmd: string;
  cwd: string;
  pid: number;
  mode: 'pty' | 'pipe';
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  seq: number;
  latestPct?: number | null;
  latestStage?: string | null;
}

export type TaskEvent =
  | { type: 'output'; seq: number; ts: number; dt: number; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'progress'; seq: number; ts: number; dt: number; pct: number; msg?: string }
  | { type: 'stage'; seq: number; ts: number; dt: number; name: string }
  | { type: 'status'; seq: number; ts: number; dt: number; status: TaskStatus; exitCode: number | null };

export async function fetchTasks(): Promise<TaskMeta[]> {
  const res = await fetch('/api/tasks');
  const body = (await res.json()) as { tasks: TaskMeta[] };
  return body.tasks;
}

export async function fetchTask(id: string): Promise<TaskMeta> {
  const res = await fetch(`/api/tasks/${id}`);
  const body = (await res.json()) as { task: TaskMeta };
  return body.task;
}

export async function fetchEvents(id: string, after = 0): Promise<TaskEvent[]> {
  const res = await fetch(`/api/tasks/${id}/events?after=${after}`);
  const body = (await res.json()) as { events: TaskEvent[] };
  return body.events;
}

export async function postKill(id: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const res = await fetch(`/api/tasks/${id}/kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `终止失败（HTTP ${res.status}）`);
  }
}

export async function postInput(id: string, data: string): Promise<void> {
  await fetch(`/api/tasks/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
}

export async function postResize(id: string, cols: number, rows: number): Promise<void> {
  await fetch(`/api/tasks/${id}/resize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });
}

/** 订阅任务实时事件流（含历史续传回放） */
export function connectWs(
  id: string,
  lastSeq: number,
  handlers: { onEvent: (ev: TaskEvent) => void; onOpen?: () => void; onClose?: () => void },
): WebSocket {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ hello: { token: '', role: 'web', taskId: id, lastSeq } }));
    handlers.onOpen?.();
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data) as
      | { welcome: { task: TaskMeta; replayed: TaskEvent[] } }
      | { event: TaskEvent };
    if ('welcome' in msg) {
      for (const ev of msg.welcome.replayed) handlers.onEvent(ev);
    } else {
      handlers.onEvent(msg.event);
    }
  };
  ws.onclose = () => handlers.onClose?.();
  return ws;
}

export function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  killed: '已终止',
  error: '异常',
};
