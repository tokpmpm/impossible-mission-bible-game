// 房間存檔（2026-11-22 連線加強，ADR-0010）：伺服器重啟、重新部署、Durable Object 被回收後，房間還在。
// 介面是同步的（Durable Object 的 storage.sql.exec 是同步的）。Node 本機版預設不存（MemoryRoomStore 只給測試模擬重啟）。
import type { SqlExec } from './leaderboard.ts';

export interface SavedRoom {
  code: string;
  /** 建房那支手機的網址（QR Code 用）。 */
  origin: string;
  data: string;
}

export interface RoomStore {
  loadAll(): SavedRoom[];
  save(room: SavedRoom): void;
  remove(code: string): void;
}

/** 記憶體版：同一個物件交給新的 Hub，就等於「伺服器重啟後讀回存檔」。只給測試用。 */
export class MemoryRoomStore implements RoomStore {
  rows = new Map<string, SavedRoom>();
  saves = 0;
  loadAll(): SavedRoom[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  save(room: SavedRoom): void {
    this.saves++;
    this.rows.set(room.code, { ...room });
  }
  remove(code: string): void {
    this.rows.delete(code);
  }
}

/** Cloudflare Durable Object 的 SQLite 版（與排行榜同一個資料庫）。 */
export class SqlRoomStore implements RoomStore {
  private exec: SqlExec;
  constructor(exec: SqlExec) {
    this.exec = exec;
    exec(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }
  loadAll(): SavedRoom[] {
    return this.exec('SELECT code, origin, data FROM rooms').map((r) => ({ code: String(r.code), origin: String(r.origin), data: String(r.data) }));
  }
  save(room: SavedRoom): void {
    this.exec('INSERT INTO rooms (code, origin, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET origin = excluded.origin, data = excluded.data, updated_at = excluded.updated_at', room.code, room.origin, room.data, Date.now());
  }
  remove(code: string): void {
    this.exec('DELETE FROM rooms WHERE code = ?', code);
  }
}
