// Cloudflare Workers 入口：靜態檔交給 Assets，/ws 交給唯一的 GameHub Durable Object（ADR-0005）。
import { Hub, type Conn } from '../server/hub.ts';

export interface Env {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return env.HUB.get(env.HUB.idFromName('global')).fetch(req);
    if (url.pathname === '/healthz') return new Response('ok');
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** 所有房間都在這一個物件的記憶體裡；只要還有人連線就會一直活著。 */
export class GameHub implements DurableObject {
  private hub = new Hub();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
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
