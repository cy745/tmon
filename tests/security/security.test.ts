// 安全测试（tests/security/）：模拟攻击者视角验证本地服务安全边界（P0 修复）
// 与 tests/unit/（纯逻辑单测）区分：本目录启动真实 server，做 HTTP/WS 协议层攻击模拟
// 覆盖：R1 REST 鉴权（Host 白名单 + Origin 校验）｜ R2 WS 跨域握手（CSWSH）｜
//       R3 CSRF 注入通道（form POST / text/plain 伪 JSON）｜ R4 web 角色只读｜ R5 文件权限
// 运行：npm run test:security（或 npm test 全量；注意 vitest fileParallelism=false，
//       store.test.ts 与本文件都操作 TMON_DATA_DIR，须串行）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { serve } from '../../src/server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 攻击者域名（模拟恶意网页来源，仅作为 header 字符串，测试全程不发外部请求） */
const ATTACKER_ORIGIN = 'https://test-security.com';

let dataDir: string;
let server: http.Server;
let port = 0;
let taskId = '';
let taskProc: ReturnType<typeof spawn> | null = null;

function base(): string {
  return `http://127.0.0.1:${port}`;
}

/** fetch 封装：可注入 origin（Node fetch 允许；浏览器禁止但攻击场景等价） */
function req(pathname: string, opts: { origin?: string; ct?: string; body?: string; method?: string } = {}): Promise<Response> {
  return fetch(base() + pathname, {
    method: opts.method ?? 'GET',
    body: opts.body,
    headers: {
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.ct ? { 'content-type': opts.ct } : {}),
    },
  });
}

/** http.request 封装：可注入任意 header（含 forbidden 的 Host，模拟 DNS rebinding） */
function rawReq(pathname: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** WS 客户端封装：可注入 Origin header（模拟浏览器跨域握手） */
function wsOpen(opts: { origin?: string } = {}): Promise<{ kind: 'open' | 'close' | 'error'; ws?: WebSocket; code?: number }> {
  return new Promise((resolve) => {
    const headers = opts.origin ? { origin: opts.origin } : undefined;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const timer = setTimeout(() => resolve({ kind: 'error', ws }), 3000);
    ws.on('open', () => { clearTimeout(timer); resolve({ kind: 'open', ws }); });
    ws.on('close', (code) => { clearTimeout(timer); resolve({ kind: 'close', code, ws }); });
    ws.on('error', () => { clearTimeout(timer); resolve({ kind: 'error', ws }); });
  });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmon-sec-'));
  process.env.TMON_DATA_DIR = dataDir;
  server = (await serve())!; // 临时数据目录无已有 server，必返回新实例
  port = Number(fs.readFileSync(path.join(dataDir, 'port'), 'utf8').trim());
  // 起一个后台运行任务（sleep 30），供 web 角色注入测试使用
  // 入口必须用 bin/tmon.js（src/cli.ts 只导出 main 不自调用，直接 node 跑会无输出退出）
  taskProc = spawn(process.execPath, [path.join(ROOT, 'bin/tmon.js'), 'sleep 30'], {
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  taskId = await new Promise((resolve) => {
    taskProc!.stderr?.on('data', (c: Buffer) => {
      const m = c.toString().match(/task ([0-9a-f]{8}) started/);
      if (m) resolve(m[1]);
    });
  });
});

afterAll(async () => {
  // 终止任务子进程并等其退出：agent 断开会触发 server 的失联处理（异步写 meta.json），
  // 该处理依赖 TMON_DATA_DIR，必须在删除环境变量之前完成。
  // 注意 ws 升级后的连接由 ws 库管理，server.close() 不等待它们，需显式等 socket 关闭。
  if (taskProc) {
    const exited = new Promise<void>((resolve) => {
      taskProc!.once('exit', () => resolve());
      taskProc!.kill('SIGKILL');
    });
    await exited;
    await new Promise((r) => setTimeout(r, 200)); // 等 TCP 关闭 + 失联状态落盘（同步写，毫秒级）
  }
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  // 环境与数据目录最后清理
  delete process.env.TMON_DATA_DIR;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('R1: REST 鉴权（Host 白名单 + Origin 校验）', () => {
  it('恶意 Origin 的请求被拒 (403)', async () => {
    const res = await req('/api/tasks', { origin: ATTACKER_ORIGIN });
    expect(res.status).toBe(403);
  });

  it('恶意 Host 的请求被拒 (403，模拟 DNS rebinding)', async () => {
    const { status } = await rawReq('/api/tasks', { host: new URL(ATTACKER_ORIGIN).hostname });
    expect(status).toBe(403);
  });

  it('本机 Origin 的浏览器请求放行 (200)', async () => {
    const res = await req('/api/tasks', { origin: `http://127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('无 Origin 的 CLI/本机进程请求放行 (200)', async () => {
    const res = await req('/api/tasks');
    expect(res.status).toBe(200);
  });
});

describe('R3: CSRF 注入通道（content-type 强制）', () => {
  it('form POST kill（urlencoded，无 preflight）被拒 (415)', async () => {
    const res = await req(`/api/tasks/${taskId}/kill`, {
      method: 'POST',
      ct: 'application/x-www-form-urlencoded',
      body: 'signal=SIGKILL',
    });
    expect(res.status).toBe(415);
  });

  it('text/plain 伪 JSON input（简单请求绕过 preflight）被拒 (415)', async () => {
    const res = await req(`/api/tasks/${taskId}/input`, {
      method: 'POST',
      ct: 'text/plain',
      body: JSON.stringify({ data: 'rm -rf /tmp/victim-data\r' }),
    });
    expect(res.status).toBe(415);
  });

  it('合法 JSON + 恶意 Origin 的 kill 被拒 (403)', async () => {
    const res = await req(`/api/tasks/${taskId}/kill`, {
      method: 'POST',
      ct: 'application/json',
      origin: ATTACKER_ORIGIN,
      body: JSON.stringify({ signal: 'SIGKILL' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('R2: WebSocket 跨域握手（CSWSH）防护', () => {
  it('恶意 Origin 握手被拒（upgrade 阶段 403，客户端收不到 open）', async () => {
    const r = await wsOpen({ origin: ATTACKER_ORIGIN });
    expect(r.kind).not.toBe('open');
  });

  it('本机 Origin 放行', async () => {
    const r = await wsOpen({ origin: `http://127.0.0.1:${port}` });
    expect(r.kind).toBe('open');
    r.ws?.close();
  });

  it('无 Origin（executor/CLI 场景）放行', async () => {
    const r = await wsOpen();
    expect(r.kind).toBe('open');
    r.ws?.close();
  });
});

describe('R4: web 角色只读（禁止生产事件）', () => {
  it('注入事件被拒 (4400)', async () => {
    const r = await wsOpen();
    expect(r.kind).toBe('open');
    const closeCode = new Promise<number>((resolve) => {
      r.ws!.on('close', (code) => resolve(code));
    });
    // 注册为 web 角色
    r.ws!.send(JSON.stringify({ hello: { token: '', role: 'web', taskId, lastSeq: 0 } }));
    await new Promise((resolve) => {
      r.ws!.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { welcome?: unknown };
        if (msg.welcome) resolve(null);
      });
    });
    // 伪造 output 事件（web 角色无权生产）
    r.ws!.send(JSON.stringify({
      event: { type: 'output', seq: 999, ts: Date.now(), dt: 1, stream: 'stdout', data: 'FAKE-INJECTED\n' },
    }));
    expect(await closeCode).toBe(4400);
  });
});

describe('R5: 文件/目录权限', () => {
  it('token 文件 0600，数据目录 0700', () => {
    expect(fs.statSync(path.join(dataDir, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
  });
});

describe('端到端回归（P0 修复不破坏正常功能）', () => {
  it('tmon 正常执行命令', async () => {
    // 用异步 spawn：spawnSync 会阻塞测试进程事件循环，导致本进程 server 无法响应
    // 子进程的 health ping（800ms 超时 → 误触发 server 自动拉起，产生冗余进程）
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'bin/tmon.js'), 'echo sec-ok'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (c: Buffer) => (out += c));
      p.stderr.on('data', (c: Buffer) => (err += c));
      p.on('exit', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('sec-ok');
  });

  it('全部任务目录 0700、stream.jsonl 0600', () => {
    const tasks = fs.readdirSync(path.join(dataDir, 'tasks'));
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      const dir = path.join(dataDir, 'tasks', t);
      expect(fs.statSync(dir).mode & 0o777, `目录 ${t}`).toBe(0o700);
      const stream = path.join(dir, 'stream.jsonl');
      if (fs.existsSync(stream)) {
        expect(fs.statSync(stream).mode & 0o777, `stream ${t}`).toBe(0o600);
      }
    }
  });
});
