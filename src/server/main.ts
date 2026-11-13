// 區域網路小伺服器：供應 public/ 靜態檔＋WebSocket（/ws）。房間狀態全在記憶體，伺服器權威。
// 執行：npm start（PORT 預設 3000；PUBLIC_URL 可指定 QR Code 用的網址）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room } from './room.ts';
import type { ClientMessage, ServerMessage } from './view.ts';

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

interface Conn {
  ws: WebSocket;
  roomCode: string | null;
  playerId: string | null;
}

export function startServer(opts: { port?: number; publicUrl?: string; tickMs?: number } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const rooms = new Map<string, Room>();
  const conns = new Set<Conn>();
  const qrCache = new Map<string, string>();
  let baseUrl = opts.publicUrl ?? process.env.PUBLIC_URL ?? '';

  function joinUrl(code: string): string {
    return `${baseUrl.replace(/\/$/, '')}/?room=${code}`;
  }

  async function qr(code: string): Promise<string> {
    let svg = qrCache.get(code);
    if (!svg) {
      svg = await QRCode.toString(joinUrl(code), { type: 'svg', margin: 1, color: { dark: '#0b1d3a', light: '#ffffff' } });
      qrCache.set(code, svg);
    }
    return svg;
  }

  function newCode(): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  async function broadcast(room: Room): Promise<void> {
    const svg = await qr(room.code);
    for (const c of conns) {
      if (c.roomCode !== room.code || !c.playerId || !room.get(c.playerId)) continue;
      send(c.ws, { t: 'state', view: room.view(c.playerId, joinUrl(room.code), svg) });
    }
  }

  async function handle(conn: Conn, msg: ClientMessage): Promise<void> {
    const room = conn.roomCode ? rooms.get(conn.roomCode) : undefined;
    switch (msg.t) {
      case 'create': {
        const code = newCode();
        const r = new Room(code);
        rooms.set(code, r);
        const p = r.addPlayer(String(msg.nickname ?? ''));
        conn.roomCode = code;
        conn.playerId = p.id;
        send(conn.ws, { t: 'welcome', playerId: p.id, token: p.token, code });
        return broadcast(r);
      }
      case 'join': {
        const r = rooms.get(String(msg.code ?? '').toUpperCase().trim());
        if (!r) throw new Error('找不到這個房號');
        const p = r.addPlayer(String(msg.nickname ?? ''));
        conn.roomCode = r.code;
        conn.playerId = p.id;
        send(conn.ws, { t: 'welcome', playerId: p.id, token: p.token, code: r.code });
        return broadcast(r);
      }
      case 'resume': {
        for (const r of rooms.values()) {
          const p = r.get(String(msg.playerId));
          if (!p) continue;
          if (!r.resume(p.id, String(msg.token))) break;
          conn.roomCode = r.code;
          conn.playerId = p.id;
          send(conn.ws, { t: 'welcome', playerId: p.id, token: p.token, code: r.code });
          return broadcast(r);
        }
        throw new Error('房間已經不存在，請重新加入');
      }
    }
    if (!room || !conn.playerId) throw new Error('請先加入房間');
    const pid = conn.playerId;
    switch (msg.t) {
      case 'pref':
        room.setPref(pid, msg.value);
        break;
      case 'start':
        room.start(pid);
        break;
      case 'next':
        room.next(pid);
        break;
      case 'act': {
        const id = String(msg.id ?? '');
        if (!id) throw new Error('缺少動作代號');
        try {
          room.act(pid, id, msg.ev);
        } finally {
          send(conn.ws, { t: 'ack', id });
        }
        break;
      }
      case 'thank':
        room.thank(pid, msg.to);
        break;
      case 'leave':
        room.leave(pid);
        conn.roomCode = null;
        conn.playerId = null;
        break;
    }
    return broadcast(room);
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

  wss.on('connection', (ws) => {
    const conn: Conn = { ws, roomCode: null, playerId: null };
    conns.add(conn);
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send(ws, { t: 'error', msg: '看不懂的訊息' });
      }
      handle(conn, msg).catch((e: Error) => send(ws, { t: 'error', msg: e.message }));
    });
    ws.on('close', () => {
      conns.delete(conn);
      const room = conn.roomCode ? rooms.get(conn.roomCode) : undefined;
      if (room && conn.playerId) {
        const stillOpen = [...conns].some((c) => c.roomCode === room.code && c.playerId === conn.playerId);
        if (!stillOpen) {
          room.disconnect(conn.playerId);
          broadcast(room).catch(() => {});
        }
      }
    });
  });

  const ticker = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.tick()) broadcast(room).catch(() => {});
    }
  }, opts.tickMs ?? 250);

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.isEmpty() && now - room.lastActivity > 30 * 60_000) {
        rooms.delete(code);
        qrCache.delete(code);
      }
    }
  }, 60_000);

  return new Promise<{ port: number; close: () => Promise<void>; rooms: Map<string, Room> }>((resolve) => {
    server.listen(port, () => {
      const actual = (server.address() as { port: number }).port;
      if (!baseUrl) baseUrl = `http://${lanAddress() ?? 'localhost'}:${actual}`;
      resolve({
        port: actual,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(ticker);
            clearInterval(sweeper);
            for (const c of conns) c.ws.terminate();
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
