// 區域網路小伺服器：供應 public/ 靜態檔＋WebSocket（/ws）。房間狀態全在記憶體，伺服器權威。
// 執行：npm start（PORT 預設 3000；PUBLIC_URL 可指定 QR Code 用的網址）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub, type Conn } from './hub.ts';
import { MemoryStore, type LeaderRow } from './leaderboard.ts';

/** 本機排行榜：給了檔名就存成 JSON（伺服器重開還在）；沒給就只在記憶體。 */
export function fileLeaderboard(file: string | null | undefined): MemoryStore {
  if (!file) return new MemoryStore();
  let rows: LeaderRow[] = [];
  if (existsSync(file)) rows = (JSON.parse(readFileSync(file, 'utf8')) as { rows: LeaderRow[] }).rows ?? [];
  return new MemoryStore({
    rows,
    onChange: (all) => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows: all }, null, 1));
      renameSync(tmp, file);
    },
  });
}

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

export function startServer(opts: { port?: number; publicUrl?: string; tickMs?: number; introMs?: number; sweepWarningMs?: number; voteMs?: number; leaderboardFile?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  // INTRO_MS：只給自動測試縮短「認識隊友」時間用；正式遊戲固定 60 秒
  const introMs = opts.introMs ?? (process.env.INTRO_MS ? Number(process.env.INTRO_MS) : undefined);
  // SWEEP_WARN_MS：同上，只給自動測試縮短「捲走前 10 秒提醒」
  const sweepWarningMs = opts.sweepWarningMs ?? (process.env.SWEEP_WARN_MS ? Number(process.env.SWEEP_WARN_MS) : undefined);
  // LEADERBOARD_FILE：排行榜存檔位置（例如 data/leaderboard.json）；不給就只在記憶體，伺服器重開會清空
  const leaderboard = fileLeaderboard(opts.leaderboardFile ?? process.env.LEADERBOARD_FILE);
  // VOTE_MS：同上，只給自動測試縮短「沒回應就算同意」的 10 秒
  const voteMs = opts.voteMs ?? (process.env.VOTE_MS ? Number(process.env.VOTE_MS) : undefined);
  const hub = new Hub({ publicUrl: opts.publicUrl ?? process.env.PUBLIC_URL ?? null, introMs, sweepWarningMs, voteMs, leaderboard });
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
    if (url.pathname === '/api/leaderboard') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(hub.leaderboardJson()));
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
