// 區域網路小伺服器：供應 public/ 靜態檔＋WebSocket（/ws）。房間狀態全在記憶體，伺服器權威。
// 執行：npm start（PORT 預設 3000；PUBLIC_URL 可指定 QR Code 用的網址）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub, type Conn } from './hub.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export function startServer(opts: { port?: number; publicUrl?: string; tickMs?: number } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const hub = new Hub({ publicUrl: opts.publicUrl ?? process.env.PUBLIC_URL ?? null });
  let actualPort = port;

  function originOf(req: IncomingMessage): string {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${actualPort}`);
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
    // 主持人用 localhost 開，QR Code 改用區域網路位址，手機才連得到
    if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return `http://${lanAddress() ?? 'localhost'}:${actualPort}`;
    return `${proto}://${host}`;
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(PUBLIC_DIR, path));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('找不到');
    }
  }

  const server = createServer((req, res) => {
    serveStatic(req, res).catch(() => res.writeHead(500).end());
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const conn: Conn = { send: (d) => ws.readyState === ws.OPEN && ws.send(d), origin: originOf(req), roomCode: null, playerId: null };
    hub.open(conn);
    ws.on('message', (data) => hub.message(conn, String(data)));
    ws.on('close', () => hub.close(conn));
  });

  const ticker = setInterval(() => hub.tick(), opts.tickMs ?? 250);
  const sweeper = setInterval(() => hub.sweep(), 60_000);

  return new Promise<{ port: number; close: () => Promise<void>; rooms: Map<string, unknown> }>((resolve) => {
    server.listen(port, () => {
      actualPort = (server.address() as { port: number }).port;
      resolve({
        port: actualPort,
        rooms: hub.rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(ticker);
            clearInterval(sweeper);
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { port } = await startServer();
  const lan = lanAddress();
  console.log(`不可能的任務 原型伺服器已啟動`);
  console.log(`  本機：  http://localhost:${port}`);
  if (lan) console.log(`  手機（同一個 Wi-Fi）：http://${lan}:${port}`);
}
