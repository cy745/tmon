// server 发现与自动拉起（docs/03-design.md §6）
// 任何 tmon 子命令先 ensureServer()：探测健康 → 不存在则 detached spawn 拉起
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readPort, readToken } from './paths.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ServerInfo {
  port: number;
  token: string;
}

export async function ensureServer(): Promise<ServerInfo> {
  const token = (await readToken()) ?? '';
  const port = await readPort();
  if (port !== null && (await ping(port, token))) {
    return { port, token };
  }
  return launch();
}

async function ping(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function launch(): Promise<ServerInfo> {
  // detached + stdio ignore：CLI 退出后 server 独立存活
  const entry = path.join(__dirname, '..', 'bin', 'tmon.js');
  const child = spawn(process.execPath, [entry, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  // 等待 server 就绪（最多 5s）
  const deadline = Date.now() + 5000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const token = (await readToken()) ?? '';
    const port = await readPort();
    if (port !== null && (await ping(port, token))) {
      return { port, token };
    }
    lastErr = new Error(`server 未就绪（port=${port ?? '-'}）`);
  }
  throw new Error(`tmon server 自动拉起失败: ${lastErr}`);
}
