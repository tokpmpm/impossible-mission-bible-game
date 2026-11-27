// 與平台無關的房間中心：所有房間、所有連線、訊息處理、廣播、定時 tick。
// Node（src/server/main.ts）與 Cloudflare Durable Object（src/worker/index.ts）共用這一份。
// @ts-expect-error qrcode 的內部模組沒有型別；只用純 JS 的核心＋SVG，避免 Workers 不支援的 fs／png。
import QRCore from 'qrcode/lib/core/qrcode.js';
// @ts-expect-error 同上
import SvgTag from 'qrcode/lib/renderer/svg-tag.js';
import { FORMULA_VERSION, computeScore } from '../engine/score.ts';
import { MemoryStore, NAME_REASON_TEXT, TOP_N, checkTeamName, type LeaderboardStore } from './leaderboard.ts';
import { Room } from './room.ts';
import type { RoomStore } from './roomstore.ts';
import type { ClientMessage, ServerMessage } from './view.ts';

export interface Conn {
  send(data: string): void;
  /** 這條連線來自哪個網址（例如 https://xxx.workers.dev），用來產生 QR Code。 */
  origin: string;
  roomCode: string | null;
  playerId: string | null;
  /** 最後一次收到這條連線任何訊息的時間（心跳逾時用）。 */
  lastSeen?: number;
  /** 伺服器主動關閉連線（心跳逾時）。 */
  close?(): void;
}

/** 伺服器多久沒收到某條連線的任何訊息就當作斷線（手機每 10 秒送 ping）。 */
export const STALE_MS = 45_000;
/** 房間存檔最多多久寫一次。 */
export const SAVE_EVERY_MS = 1_000;

/** 帶代碼的錯誤：手機可以依代碼處理，不用比對文字。 */
class CodedError extends Error {
  readonly code: 'ROOM_GONE';
  constructor(msg: string, code: 'ROOM_GONE') {
    super(msg);
    this.code = code;
  }
}

/** 會改變狀態、可以帶 mid 去重的訊息（act 用自己的 id）。 */
const RELIABLE = new Set(['pref', 'start', 'next', 'vote', 'thank', 'submitScore']);

export function qrSvg(text: string): string {
  const data = QRCore.create(text, {});
  return SvgTag.render(data, { margin: 1, color: { dark: '#0b1d3a', light: '#ffffff' } }) as string;
}

/** 進行中的局，至少每幾毫秒存一次檔。 */
export const LIVE_SAVE_EVERY_MS = 5_000;

export class Hub {
  rooms = new Map<string, Room>();
  conns = new Set<Conn>();
  private roomOrigin = new Map<string, string>();
  private qrCache = new Map<string, string>();
  private fixedBaseUrl: string | null;
  private introMs: number | undefined;
  private sweepWarningMs: number | undefined;
  private voteMs: number | undefined;
  /** 團隊排行榜（Node：記憶體或 JSON 檔；Cloudflare：Durable Object 的 SQLite）。 */
  leaderboard: LeaderboardStore;
  /** 房間存檔（Cloudflare：Durable Object 的 SQLite；Node 預設不存）。 */
  private store: RoomStore | null;
  private dirty = new Set<string>();
  private lastSave = 0;
  private staleMs: number;
  private now: () => number;

  constructor(
    opts: { publicUrl?: string | null; introMs?: number; sweepWarningMs?: number; voteMs?: number; leaderboard?: LeaderboardStore; store?: RoomStore | null; staleMs?: number; now?: () => number } = {},
  ) {
    this.leaderboard = opts.leaderboard ?? new MemoryStore();
    // 公式改版（docs/13）：舊版本的紀錄用存下來的原始資料以目前公式重算，不必清榜
    this.leaderboard.rescore(FORMULA_VERSION, (raw) => computeScore(raw).total);
    // （原始資料壞掉、算不出數字的紀錄由 rescore 保留原分數）
    this.fixedBaseUrl = opts.publicUrl || null;
    this.introMs = opts.introMs;
    this.sweepWarningMs = opts.sweepWarningMs;
    this.voteMs = opts.voteMs;
    this.store = opts.store ?? null;
    this.staleMs = opts.staleMs ?? STALE_MS;
    this.now = opts.now ?? Date.now;
    // 讀回存檔：伺服器重啟前的房間都回來，所有人算離線，等各自重連（進行中的局會先暫停）
    for (const saved of this.store?.loadAll() ?? []) {
      try {
        const room = Room.restore(saved.data);
        this.rooms.set(saved.code, room);
        this.roomOrigin.set(saved.code, saved.origin);
      } catch {
        this.store!.remove(saved.code); // 壞掉或舊版的存檔：丟掉
      }
    }
  }

  /** 進行中的局上次「定時存檔」的時間。 */
  private liveSaved = new Map<string, number>();

  /** 標記房間要存檔（實際寫入在 flush，最多每秒一次）。 */
  private markDirty(code: string | null | undefined): void {
    if (code && this.store) this.dirty.add(code);
  }

  /** 把有變動的房間寫進存檔。force：不等節流（例如最後一個人斷線、物件可能被回收前）。 */
  flush(force = false): void {
    if (!this.store || !this.dirty.size) return;
    const now = this.now();
    if (!force && now - this.lastSave < SAVE_EVERY_MS) return;
    this.lastSave = now;
    for (const code of this.dirty) {
      const room = this.rooms.get(code);
      if (room) this.store.save({ code, origin: this.roomOrigin.get(code) ?? '', data: room.serialize() });
      else this.store.remove(code);
    }
    this.dirty.clear();
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
    conn.lastSeen = this.now();
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(conn, { t: 'error', msg: '看不懂的訊息' });
    }
    try {
      this.handle(conn, msg);
    } catch (e) {
      // for：這個錯誤是回應哪一種訊息（手機用來把登記上榜的錯誤放在輸入框旁，其他錯誤不混進去；docs/15 L2）
      const kind = typeof (msg as { t?: unknown })?.t === 'string' ? (msg as { t: string }).t : undefined;
      this.send(conn, { t: 'error', msg: (e as Error).message, ...(kind ? { for: kind } : {}), ...(e instanceof CodedError ? { code: e.code } : {}) });
    } finally {
      this.markDirty(conn.roomCode);
    }
  }

  close(conn: Conn): void {
    // 同一條連線可能被關兩次（心跳逾時先關，ws 的 close 事件又來一次）：第二次什麼都不做（審查 #29 建議 3）
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (room && conn.playerId) {
      const stillOpen = [...this.conns].some((c) => c.roomCode === room.code && c.playerId === conn.playerId);
      if (!stillOpen) {
        room.disconnect(conn.playerId);
        this.markDirty(room.code);
        this.broadcast(room);
      }
    }
  }

  private handle(conn: Conn, msg: ClientMessage): void {
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    switch (msg.t) {
      case 'ping':
        return this.send(conn, { t: 'pong' });
      case 'leaderboard':
        return this.send(conn, { t: 'leaderboard', ...this.leaderboardJson() });
      case 'create': {
        const code = this.newCode();
        const r = new Room(code, { introMs: this.introMs, sweepWarningMs: this.sweepWarningMs, voteMs: this.voteMs, practice: msg.practice === true });
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
        throw new CodedError('房間已經不存在，請重新加入', 'ROOM_GONE');
      }
    }
    if (!room || !conn.playerId) throw new Error('請先加入房間');
    const pid = conn.playerId;
    // 帶 mid 的訊息：同一個 mid 只處理一次；不論成功或被擋都回 ack，手機就不再重送
    const mid = RELIABLE.has(msg.t) && typeof (msg as { mid?: unknown }).mid === 'string' ? (msg as { mid: string }).mid : '';
    if (mid) {
      if (room.seen(pid, 'm:' + mid)) return this.send(conn, { t: 'ack', id: mid });
      try {
        this.handleInRoom(conn, room, pid, msg);
      } finally {
        this.send(conn, { t: 'ack', id: mid });
      }
      return;
    }
    this.handleInRoom(conn, room, pid, msg);
  }

  private handleInRoom(conn: Conn, room: Room, pid: string, msg: ClientMessage): void {
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
      case 'vote':
        // 全員同意（DECISIONS 18）：重複送出同一票會被忽略
        room.vote(pid, String(msg.id ?? ''), msg.choice);
        break;
      case 'thank':
        room.thank(pid, msg.to);
        break;
      case 'submitScore': {
        // 伺服器檢查：房主、已結算、非練習房、這局沒登記過；隊名最多 12 字、過濾不雅字詞
        const sub = room.submission(pid);
        const name = checkTeamName(msg.name);
        if (!name.ok) throw new Error(NAME_REASON_TEXT[name.reason]);
        if (this.leaderboard.hasRound(sub.roundId)) throw new Error('這局已經登記過了');
        const res = this.leaderboard.add({
          roundId: sub.roundId,
          name: name.name,
          key: name.key,
          score: sub.score.total,
          players: sub.players,
          at: Date.now(),
          formula: sub.score.formula,
          raw: sub.raw,
        });
        room.markSubmitted(sub.roundId, { name: name.name, ...res });
        this.send(conn, { t: 'submitted', name: name.name, ...res });
        break;
      }
      case 'leave':
        room.leave(pid);
        this.markDirty(room.code);
        conn.roomCode = null;
        conn.playerId = null;
        break;
    }
    this.broadcast(room);
  }

  /** 排行榜前 10 名（HTTP GET /api/leaderboard 與 WebSocket 共用）。 */
  leaderboardJson(): { entries: ReturnType<LeaderboardStore['top']>; formula: string; trial: true } {
    return { entries: this.leaderboard.top(TOP_N), formula: FORMULA_VERSION, trial: true };
  }

  /** 定時呼叫：推進各房間時間（2:15 提示、2:45 危機、修復協助、8:00）、關掉沒心跳的連線、存檔。 */
  tick(): void {
    this.reapStale();
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.tick()) {
        this.markDirty(room.code);
        this.broadcast(room);
      }
      // 進行中（沒暫停）的局每 5 秒至少存一次：伺服器當掉時，讀回的倒數不會跳回很久以前（審查 #29 建議 2）
      if (room.isLive() && now - (this.liveSaved.get(room.code) ?? 0) >= LIVE_SAVE_EVERY_MS) {
        this.liveSaved.set(room.code, now);
        this.markDirty(room.code);
      }
    }
    this.flush();
  }

  /** 心跳逾時：太久沒收到任何訊息的連線（網路換手後的「假連線」）當作斷線並關掉。 */
  reapStale(now = this.now()): void {
    for (const c of [...this.conns]) {
      if (c.lastSeen === undefined) c.lastSeen = now;
      if (now - c.lastSeen <= this.staleMs) continue;
      try {
        c.close?.();
      } catch {
        // 已經關了
      }
      this.close(c);
    }
  }

  /** 清掉沒人在、閒置超過 30 分鐘的房間。 */
  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now - room.lastActivity > 30 * 60_000) {
        this.rooms.delete(code);
        this.qrCache.delete(code);
        this.roomOrigin.delete(code);
        this.markDirty(code);
      }
    }
  }

  hasActivity(): boolean {
    return [...this.rooms.values()].some((r) => !r.isEmpty());
  }
}
