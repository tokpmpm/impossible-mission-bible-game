// Cloudflare Workers 入口：靜態檔交給 Assets，/ws 交給唯一的 GameHub Durable Object（ADR-0005）。
import { Hub, type Conn } from '../server/hub.ts';
import { SqlStore } from '../server/leaderboard.ts';

export interface Env {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname === '/api/leaderboard') return env.HUB.get(env.HUB.idFromName('global')).fetch(req);
    if (url.pathname === '/healthz') return new Response('ok');
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/**
 * 所有房間都在這一個物件的記憶體裡；只要還有人連線就會一直活著。
 * 排行榜存在這個物件的 SQLite（wrangler.toml 的 new_sqlite_classes）：物件被回收、重新部署後仍在（ADR-0008）。
 */
export class GameHub implements DurableObject {
  private hub: Hub;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  constructor(state: DurableObjectState, _env: Env) {
    const sql = state.storage.sql;
    this.hub = new Hub({ leaderboard: new SqlStore((query, ...params) => sql.exec(query, ...params).toArray()) });
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === '/api/leaderboard') {
      return new Response(JSON.stringify(this.hub.leaderboardJson()), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    const conn: Conn = { send: (d) => server.send(d), origin: new URL(req.url).origin, roomCode: null, playerId: null };
    this.hub.open(conn);
    server.addEventListener('message', (e) => {
      this.hub.message(conn, typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
    });
    const closed = () => {
      this.hub.close(conn);
      if (this.hub.conns.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
    server.addEventListener('close', closed);
    server.addEventListener('error', closed);
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.hub.tick();
        if (++this.ticks % 240 === 0) this.hub.sweep();
      }, 250);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}
