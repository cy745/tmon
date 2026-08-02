// tmon 事件协议与消息类型（与 docs/03-design.md §4 对齐）

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
  /** 已发出的最后 seq（历史续传游标） */
  seq: number;
}

export type TaskEvent =
  | { type: 'output'; seq: number; ts: number; dt: number; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'progress'; seq: number; ts: number; dt: number; pct: number; msg?: string }
  | { type: 'stage'; seq: number; ts: number; dt: number; name: string }
  | { type: 'status'; seq: number; ts: number; dt: number; status: TaskStatus; exitCode: number | null };

/** WS 上行（client → server），首消息必为 hello */
export type WsClientMsg =
  | {
      hello: {
        token: string;
        role: 'agent' | 'web' | 'progress';
        taskId: string;
        /** agent 注册任务时携带 */
        meta?: Omit<TaskMeta, 'id' | 'status' | 'exitCode' | 'startedAt' | 'endedAt' | 'seq'>;
        /** web 历史续传游标 */
        lastSeq?: number;
      };
    }
  | { event: TaskEvent };

/** WS 下行（server → client） */
export type WsServerMsg =
  | { welcome: { task: TaskMeta; replayed: TaskEvent[] } }
  | { event: TaskEvent }
  | { cmd: { kind: 'kill'; signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' } }
  | { cmd: { kind: 'input'; data: string } }
  | { cmd: { kind: 'resize'; cols: number; rows: number } };

export const EVENT_REPLAY_WINDOW = 2000; // server 内存环形缓冲保留条数
