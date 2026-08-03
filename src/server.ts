// tmon server（docs/03-design.md §6/§12）：
//  - HTTP REST：健康检查 / 任务查询 / 历史事件 / 控制指令（kill/input/resize）/ 进度上报
//  - WebSocket：事件广播（agent 生产者 ↔ web 消费者），历史续传
//  - 安全：仅监听 127.0.0.1；非本机 Host 请求必须 Bearer token（MVP 取舍，见 03-design.md §12）
//  - 静态托管：web/dist 存在时直接提供前端
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { TaskEvent, TaskMeta, TaskStatus, WsClientMsg, WsServerMsg } from './protocol.ts';
import { Store } from './store.ts';
import { DEFAULT_PORT, ensureDirs, pidFile, portFile, readPort, readToken, tokenFile } from './paths.ts';
import pkg from '../package.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 版本唯一来源：package.json（health 返回 + discover 版本比对用） */
export const VERSION = pkg.version;

interface ClientConn {
  ws: WebSocket;
  role: 'agent' | 'web' | 'progress';
  taskId: string;
}

export async function serve(): Promise<http.Server | null> {
  // 单例（docs/03-design.md §6）：同一数据目录已有健康 server 时直接复用，不再新建实例。
  // 防手动 `tmon serve` 与自动拉起并存产生多实例（此前实测出现过 8456/8457 并存，
  // 后者覆盖 port 文件、前者成孤儿）。
  const existingPort = await readPort();
  const existingToken = (await readToken()) ?? '';
  if (existingPort !== null) {
    const v = await checkHealth(existingPort, existingToken);
    if (v !== null) {
      console.error(
        v === VERSION
          ? `tmon server 已在运行: http://127.0.0.1:${existingPort}`
          : `tmon server 已在运行（旧版本 ${v}），执行任意 tmon 命令将自动替换`,
      );
      return null;
    }
  }
  ensureDirs();
  const token = await ensureToken();
  const port = await findFreePort();
  fs.writeFileSync(portFile(), String(port), { mode: 0o600 });
  // 记录进程 pid：CLI 升级后发现版本不匹配时据此 kill 旧 server 完成替换
  fs.writeFileSync(pidFile(), String(process.pid), { mode: 0o600 });
  console.error(`tmon server: http://127.0.0.1:${port} (token 模式)`);

  const store = new Store();
  store.loadExisting();

  const clients = new Set<ClientConn>();
  const byTask = new Map<string, Set<ClientConn>>();

  function broadcast(taskId: string, msg: WsServerMsg, except?: ClientConn): void {
    const set = byTask.get(taskId);
    if (!set) return;
    const raw = JSON.stringify(msg);
    for (const conn of set) {
      if (conn === except) continue;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(raw);
    }
  }

  function agentOf(taskId: string): ClientConn | undefined {
    const set = byTask.get(taskId);
    return set ? [...set].find((c) => c.role === 'agent') : undefined;
  }

  function onClientEvent(conn: ClientConn, ev: TaskEvent): void {
    store.appendEvent(conn.taskId, ev);
    if (ev.type === 'status') {
      store.updateStatus(conn.taskId, ev.status, ev.exitCode, ev.ts);
      const meta = store.get(conn.taskId);
      if (meta) {
        // 通知所有客户端刷新列表状态
        broadcast(conn.taskId, { event: ev }, conn);
      }
      return;
    }
    // 进度事件同步到 meta（侧边栏微进度条数据源）
    if (ev.type === 'progress' || ev.type === 'stage') {
      const meta = store.get(conn.taskId);
      if (meta) {
        if (ev.type === 'progress') {
          meta.latestPct = ev.pct;
          if (ev.msg) meta.latestStage = ev.msg;
        } else {
          meta.latestStage = ev.name;
        }
      }
    }
    broadcast(conn.taskId, { event: ev }, conn);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';
    const p = url.pathname;
    try {
      // 安全校验（P0，防 DNS rebinding / CSRF）：
      //  - Host 白名单：仅放行本机环回主机名（挡 rebinding 后的 evil.com Host）
      //  - Origin 校验：无 Origin（CLI/本机进程）放行；浏览器请求必须来自本机页面
      if (!isLocalHost(req.headers.host)) {
        return json(res, 403, { error: 'forbidden' });
      }
      if (!isLocalOrigin(req.headers.origin)) {
        return json(res, 403, { error: 'forbidden' });
      }
      // 静态资源（web/dist）
      if (method === 'GET' && (p === '/' || p.startsWith('/assets/') || p === '/favicon.svg')) {
        if (serveStatic(p, res)) return;
      }
      if (p === '/api/health' && method === 'GET') {
        return json(res, 200, { ok: true, version: VERSION });
      }
      if (p === '/api/tasks' && method === 'GET') {
        return json(res, 200, { tasks: store.all() });
      }
      let m = p.match(/^\/api\/tasks\/([0-9a-f]{8})$/);
      if (m && method === 'GET') {
        const task = store.get(m[1]);
        return task ? json(res, 200, { task }) : json(res, 404, { error: 'task not found' });
      }
      m = p.match(/^\/api\/tasks\/([0-9a-f]{8})\/events$/);
      if (m && method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(res, 200, { events: store.readEventsAfter(m[1], after) });
      }
      m = p.match(/^\/api\/tasks\/([0-9a-f]{8})\/(kill|input|resize|progress)$/);
      if (m && method === 'POST') {
        const [, id, action] = m;
        // 状态变更端点强制 JSON content-type：挡 form POST（urlencoded 无 preflight）与
        // text/plain 伪 JSON（简单请求绕过 CORS 预检的 CSRF 注入路径，见安全审计 R3）
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!ct.startsWith('application/json')) {
          return json(res, 415, { error: 'content-type must be application/json' });
        }
        const body = (await readBody(req)) as Record<string, unknown>;
        if (action === 'kill') {
          const agent = agentOf(id);
          if (!agent) {
            const task = store.get(id);
            if (!task) return json(res, 404, { error: '任务不存在' });
            return json(res, 409, {
              error:
                task.status === 'running'
                  ? '任务的监控连接已中断（executor 失联），无法发送信号'
                  : `任务已${task.status}，无需终止`,
            });
          }
          send(agent.ws, { cmd: { kind: 'kill', signal: (body.signal as 'SIGINT') ?? 'SIGINT' } });
          return json(res, 200, { ok: true });
        }
        if (action === 'input') {
          const agent = agentOf(id);
          if (!agent) return json(res, 409, { error: '任务无 agent 连接' });
          send(agent.ws, { cmd: { kind: 'input', data: String(body.data ?? '') } });
          return json(res, 200, { ok: true });
        }
        if (action === 'resize') {
          const agent = agentOf(id);
          if (!agent) return json(res, 409, { error: '任务无 agent 连接' });
          send(agent.ws, {
            cmd: { kind: 'resize', cols: Number(body.cols ?? 120), rows: Number(body.rows ?? 30) },
          });
          return json(res, 200, { ok: true });
        }
        // progress：生成带 seq/ts/dt 的进度事件（server 单进程内 dt 自洽）
        const task = store.get(id);
        if (!task) return json(res, 404, { error: 'task not found' });
        const now = Date.now();
        const pct = Number(body.pct);
        const ev: TaskEvent = Number.isFinite(pct)
          ? { type: 'progress', seq: ++task.seq, ts: now, dt: 0, pct, msg: body.msg ? String(body.msg) : undefined }
          : { type: 'stage', seq: ++task.seq, ts: now, dt: 0, name: String(body.stage ?? '') };
        onClientEvent({ ws: null as never, role: 'progress', taskId: id }, ev);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  });

  // CSWSH 防护（P0）：浏览器 WS 握手不受同源策略保护（RFC 6455 §10.2），恶意网页可跨域直连。
  // 校验必须发生在 upgrade 阶段（connection 回调触发时握手已完成、客户端已收到 101），
  // 因此用 noServer 模式 + 手动 handleUpgrade，拒绝时直接回 401/403 并销毁 socket。
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const auth = req.headers.authorization ?? '';
    if (!isLocal && auth !== `Bearer ${token}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // 非本机页面 Origin 一律拒绝；无 Origin 的客户端（executor/CLI 等本机进程）放行，由 token 兜底
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    let conn: ClientConn | null = null;
    ws.on('message', (raw) => {
      let msg: WsClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMsg;
      } catch {
        return;
      }
      if (!('hello' in msg)) {
        // 非 hello 消息：事件（agent/progress 生产）或未注册即发消息
        if (conn && 'event' in msg) {
          // 只读角色禁止生产事件（P0）：web 角色只能消费，伪造事件会污染 JSONL 并误导 Agent 流程判定
          if (conn.role === 'web') {
            ws.close(4400, 'read-only role');
            return;
          }
          onClientEvent(conn, msg.event);
        } else {
          ws.close(4400, 'bad message');
        }
        return;
      }
      const hello = msg.hello;
      if (typeof hello.token !== 'string') {
        ws.close(4400, 'bad hello');
        return;
      }
      // web 角色（浏览器）经本机 Host 校验放行，免 token；agent/progress 必须带 token
      if (hello.role !== 'web' && hello.token !== token) {
        ws.close(4401, 'unauthorized');
        return;
      }
      if (hello.role === 'agent') {
        const meta: TaskMeta = {
          id: hello.taskId,
          cmd: hello.meta?.cmd ?? '',
          cwd: hello.meta?.cwd ?? process.cwd(),
          pid: hello.meta?.pid ?? 0,
          mode: hello.meta?.mode ?? 'pty',
          status: 'running',
          exitCode: null,
          startedAt: Date.now(),
          endedAt: null,
          seq: 0,
        };
        if (store.get(hello.taskId)) {
          ws.close(4403, 'task already registered');
          return;
        }
        store.create(meta);
        conn = { ws, role: 'agent', taskId: hello.taskId };
        clients.add(conn);
        byTask.set(hello.taskId, (byTask.get(hello.taskId) ?? new Set()).add(conn));
        send(ws, { welcome: { task: meta, replayed: [] } });
        return;
      }
      if (hello.role === 'web') {
        const task = store.get(hello.taskId);
        if (!task) {
          ws.close(4404, 'task not found');
          return;
        }
        // 历史续传（REST 之后连上 WebSocket 的事件经此处回放，避免丢事件）
        const replayed = store.readEventsAfter(hello.taskId, hello.lastSeq ?? 0);
        conn = { ws, role: 'web', taskId: hello.taskId };
        clients.add(conn);
        byTask.set(hello.taskId, (byTask.get(hello.taskId) ?? new Set()).add(conn));
        send(ws, { welcome: { task, replayed } });
        return;
      }
      if (hello.role === 'progress') {
        conn = { ws, role: 'progress', taskId: hello.taskId };
        clients.add(conn);
        byTask.set(hello.taskId, (byTask.get(hello.taskId) ?? new Set()).add(conn));
        send(ws, { welcome: { task: store.get(hello.taskId) ?? ({} as TaskMeta), replayed: [] } });
        return;
      }
    });
    ws.on('close', () => {
      if (conn) {
        clients.delete(conn);
        const set = byTask.get(conn.taskId);
        if (set) {
          set.delete(conn);
          if (set.size === 0) byTask.delete(conn.taskId);
        }
        // agent（executor）失联但任务仍 running：监控中断，标记 error 并广播
        // （子进程可能成为孤儿，孤儿回收后续版本处理）
        if (conn.role === 'agent') {
          const task = store.get(conn.taskId);
          if (task && task.status === 'running') {
            task.status = 'error';
            store.updateStatus(conn.taskId, 'error', null, Date.now());
            broadcast(conn.taskId, {
              event: { type: 'status', seq: ++task.seq, ts: Date.now(), dt: 0, status: 'error', exitCode: null },
            });
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server; // 供测试关闭句柄
}

/** Host 白名单：仅放行本机环回主机名（IPv6 带端口时形如 [::1]:8456，需去括号再拆） */
function isLocalHost(host: string | undefined): boolean {
  const h = (host ?? '').replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** Origin 校验：无 Origin（CLI/executor 等非浏览器客户端）放行；浏览器请求必须来自本机页面。
 *  非法 Origin（含 file:// 与 sandbox iframe 的 'null'）一律拒绝。 */
function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** 探测端口上的 server 是否健康，返回其版本号；不可达/异常返回 null */
async function checkHealth(port: number, token: string): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, msg: WsServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function ensureToken(): Promise<string> {
  try {
    const existing = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (existing) {
      // 收紧既有 token 文件权限（防同机其他用户读取，安全审计 R5）
      try { fs.chmodSync(tokenFile(), 0o600); } catch { /* ignore */ }
      return existing;
    }
  } catch {
    // 首次启动，无 token 文件
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(tokenFile(), token, { mode: 0o600 });
  return token;
}

async function findFreePort(): Promise<number> {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('找不到可用端口');
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function serveStatic(p: string, res: http.ServerResponse): boolean {
  const root = path.join(__dirname, '..', 'web', 'dist');
  if (!fs.existsSync(root)) return false;
  const file = p === '/' ? 'index.html' : p.slice(1);
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full)) return false;
  const ext = path.extname(full);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(full));
  return true;
}
