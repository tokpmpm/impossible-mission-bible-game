// 與平台無關的房間中心：所有房間、所有連線、訊息處理、廣播、定時 tick。
// Node（src/server/main.ts）與 Cloudflare Durable Object（src/worker/index.ts）共用這一份。
// @ts-expect-error qrcode 的內部模組沒有型別；只用純 JS 的核心＋SVG，避免 Workers 不支援的 fs／png。
import QRCore from 'qrcode/lib/core/qrcode.js';
// @ts-expect-error 同上
import SvgTag from 'qrcode/lib/renderer/svg-tag.js';
import { Room } from './room.ts';
import type { ClientMessage, ServerMessage } from './view.ts';

export interface Conn {
  send(data: string): void;
  /** 這條連線來自哪個網址（例如 https://xxx.workers.dev），用來產生 QR Code。 */
  origin: string;
  roomCode: string | null;
  playerId: string | null;
}

export function qrSvg(text: string): string {
  const data = QRCore.create(text, {});
  return SvgTag.render(data, { margin: 1, color: { dark: '#0b1d3a', light: '#ffffff' } }) as string;
}

export class Hub {
  rooms = new Map<string, Room>();
  conns = new Set<Conn>();
  private roomOrigin = new Map<string, string>();
  private qrCache = new Map<string, string>();
  private fixedBaseUrl: string | null;
  private introMs: number | undefined;

  constructor(opts: { publicUrl?: string | null; introMs?: number } = {}) {
    this.fixedBaseUrl = opts.publicUrl || null;
    this.introMs = opts.introMs;
  }

  joinUrl(code: string): string {
    const base = this.fixedBaseUrl ?? this.roomOrigin.get(code) ?? '';
    return `${base.replace(/\/$/, '')}/?room=${code}`;
  }

  private qr(code: string): string {
    let svg = this.qrCache.get(code);
    if (!svg) {
      svg = qrSvg(this.joinUrl(code));
      this.qrCache.set(code, svg);
    }
    return svg;
  }

  private newCode(): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  private send(conn: Conn, msg: ServerMessage): void {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      // 連線已關閉
    }
  }

  broadcast(room: Room): void {
    const svg = this.qr(room.code);
    const url = this.joinUrl(room.code);
    for (const c of this.conns) {
      if (c.roomCode !== room.code || !c.playerId || !room.get(c.playerId)) continue;
      this.send(c, { t: 'state', view: room.view(c.playerId, url, svg) });
    }
  }

  open(conn: Conn): void {
    this.conns.add(conn);
  }

  message(conn: Conn, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(conn, { t: 'error', msg: '看不懂的訊息' });
    }
    try {
      this.handle(conn, msg);
    } catch (e) {
      this.send(conn, { t: 'error', msg: (e as Error).message });
    }
  }

  close(conn: Conn): void {
    this.conns.delete(conn);
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (room && conn.playerId) {
      const stillOpen = [...this.conns].some((c) => c.roomCode === room.code && c.playerId === conn.playerId);
      if (!stillOpen) {
        room.disconnect(conn.playerId);
        this.broadcast(room);
      }
    }
  }

  private handle(conn: Conn, msg: ClientMessage): void {
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    switch (msg.t) {
      case 'ping':
        return this.send(conn, { t: 'pong' });
      case 'create': {
        const code = this.newCode();
        const r = new Room(code, { introMs: this.introMs });
        this.rooms.set(code, r);
        this.roomOrigin.set(code, conn.origin);
        const p = r.addPlayer(String(msg.nickname ?? ''));
        conn.roomCode = code;
        conn.playerId = p.id;
        this.send(conn, { t: 'welcome', playerId: p.id, token: p.token, code });
        return this.broadcast(r);
      }
      case 'join': {
        const r = this.rooms.get(String(msg.code ?? '').toUpperCase().trim());
        if (!r) throw new Error('找不到這個房號');
        const p = r.addPlayer(String(msg.nickname ?? ''));
        conn.roomCode = r.code;
        conn.playerId = p.id;
        this.send(conn, { t: 'welcome', playerId: p.id, token: p.token, code: r.code });
        return this.broadcast(r);
      }
      case 'resume': {
        for (const r of this.rooms.values()) {
          const p = r.get(String(msg.playerId));
          if (!p) continue;
          if (!r.resume(p.id, String(msg.token))) break;
          conn.roomCode = r.code;
          conn.playerId = p.id;
          this.send(conn, { t: 'welcome', playerId: p.id, token: p.token, code: r.code });
          return this.broadcast(r);
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
          const rejected = room.act(pid, id, msg.ev);
          if (rejected) this.send(conn, { t: 'rejected', id, ...rejected });
        } finally {
          this.send(conn, { t: 'ack', id });
          this.broadcast(room);
        }
        return;
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
    this.broadcast(room);
  }

  /** 定時呼叫：推進各房間時間（2:15 提示、2:45 危機、修復協助、8:00）。 */
  tick(): void {
    for (const room of this.rooms.values()) if (room.tick()) this.broadcast(room);
  }

  /** 清掉沒人在、閒置超過 30 分鐘的房間。 */
  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now - room.lastActivity > 30 * 60_000) {
        this.rooms.delete(code);
        this.qrCache.delete(code);
        this.roomOrigin.delete(code);
      }
    }
  }

  hasActivity(): boolean {
    return [...this.rooms.values()].some((r) => !r.isEmpty());
  }
}
