// 團隊排行榜（試行；docs/13-SCORING.md、ADR-0008）。一個總榜、不分人數、永不重置，顯示前 10 名。
// - 每次登記都存一筆（含原始計分資料與公式版本），將來改公式可以重算，不必清榜。
// - 同一隊名只顯示最高分（同分取較早那筆）；隊與隊同分時較早者在前。
// - 儲存與平台無關：MemoryStore（Node 本機，可選擇寫到 JSON 檔）與 SqlStore（Cloudflare Durable Object 的 SQLite）。
//   兩者都是同步介面（DO 的 storage.sql.exec 是同步的），排名規則共用 rankBest()。
import type { ScoreRaw } from '../engine/score.ts';

export const TEAM_NAME_MAX = 12;
export const TOP_N = 10;

/** 一筆登記（存進資料庫的完整資料）。 */
export interface LeaderRow {
  id: number;
  roundId: string; // 每局唯一；同一局只能登記一次
  name: string; // 顯示用隊名
  key: string; // 比對用隊名（去空白、全形半形與大小寫統一）
  score: number;
  players: number;
  at: number; // 登記時間（毫秒）
  formula: string;
  raw: ScoreRaw;
}

/** 排行榜上顯示的一列。 */
export interface LeaderEntry {
  rank: number;
  name: string;
  score: number;
  players: number;
  at: number;
}

export interface SubmitResult {
  /** 這一隊現在在總榜第幾名（以隊伍最好成績排）。 */
  rank: number;
  /** 這次是不是這一隊的最好成績（不是＝榜上仍顯示之前那筆）。 */
  best: boolean;
  bestScore: number;
}

export interface LeaderboardStore {
  /** 前 n 名（每隊只列最好的一筆）。 */
  top(n?: number): LeaderEntry[];
  /** 這局登記過了沒。 */
  hasRound(roundId: string): boolean;
  add(row: Omit<LeaderRow, 'id'>): SubmitResult;
  /** 全部登記（給重算或匯出用）。 */
  all(): LeaderRow[];
}

// ---------- 隊名 ----------

/** 比對用：NFKC（全形→半形）、小寫、去掉空白與標點、常見數字代字。 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\u200b-\u200f\u2060\ufeff]/gu, '');
}

function leet(s: string): string {
  return s.replace(/[013457@$]/g, (c) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' })[c] ?? c);
}

/** 不雅字詞（比對去掉空白標點後的隊名；寧可擋多一點，隊名換一個就好）。 */
const BLOCKED = [
  // 中文（含常見諧音）
  '幹你', '幹妳', '幹您', '幹林', '幹恁', '幹拎', '操你', '操妳', '肏', '靠北', '靠杯', '靠夭', '他媽', '他馬', '你媽', '妳媽', '媽的', '馬的', '尼瑪',
  '雞掰', '機掰', '雞巴', '機八', '雞八', '屌', '王八', '白痴', '白癡', '智障', '腦殘', '去死', '賤人', '賤貨', '婊', '妓', '淫', '色情', '做愛', '性交',
  '屁眼', '陰莖', '陰道', '三小', '殺小', '垃圾人', '廢物', '畜生', '畜牲', '狗娘', '娘炮', '死胖子',
  // 英文
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'porn', 'sex', 'nigg', 'asshole', 'bastard', 'slut', 'whore', 'wtf', 'stfu',
];

export type NameCheck = { ok: true; name: string; key: string } | { ok: false; reason: 'EMPTY' | 'TOO_LONG' | 'BLOCKED' };

export const NAME_REASON_TEXT: Record<'EMPTY' | 'TOO_LONG' | 'BLOCKED', string> = {
  EMPTY: '請輸入團隊名稱',
  TOO_LONG: `團隊名稱最多 ${TEAM_NAME_MAX} 個字`,
  BLOCKED: '這個名稱不太適合，換一個吧',
};

export function checkTeamName(input: unknown): NameCheck {
  const name = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 只有表情符號的隊名：去掉標點符號後是空的，改用去空白後的原字當比對用 key
  const key = nameKey(name) || name.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  if (!key) return { ok: false, reason: 'EMPTY' };
  if ([...name].length > TEAM_NAME_MAX) return { ok: false, reason: 'TOO_LONG' };
  // 不雅比對：先把 $、@ 等代字還原成字母，再去空白標點（否則 $hit 的 $ 會先被刪掉）
  const k2 = nameKey(leet(name.normalize('NFKC').toLowerCase()));
  if (BLOCKED.some((w) => key.includes(w) || k2.includes(w))) return { ok: false, reason: 'BLOCKED' };
  return { ok: true, name, key };
}

// ---------- 排名（兩種儲存共用） ----------

const better = (x: LeaderRow, y: LeaderRow) => y.score - x.score || x.at - y.at || x.id - y.id;

/** 每隊只留最高分（同分取較早），再依分數高→低、時間早→晚排。 */
export function rankBest(rows: LeaderRow[]): LeaderRow[] {
  const best = new Map<string, LeaderRow>();
  for (const r of rows) {
    const cur = best.get(r.key);
    if (!cur || better(r, cur) < 0) best.set(r.key, r);
  }
  return [...best.values()].sort(better);
}

function toEntries(rows: LeaderRow[]): LeaderEntry[] {
  return rows.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, players: r.players, at: r.at }));
}

function resultFor(ranked: LeaderRow[], key: string, id: number): SubmitResult {
  const i = ranked.findIndex((r) => r.key === key);
  return { rank: i + 1, best: ranked[i]?.id === id, bestScore: ranked[i]?.score ?? 0 };
}

// ---------- 記憶體（Node 本機；可接 JSON 檔） ----------

export class MemoryStore implements LeaderboardStore {
  private rows: LeaderRow[];
  private onChange: ((rows: LeaderRow[]) => void) | null;

  constructor(opts: { rows?: LeaderRow[]; onChange?: (rows: LeaderRow[]) => void } = {}) {
    this.rows = [...(opts.rows ?? [])];
    this.onChange = opts.onChange ?? null;
  }

  top(n = TOP_N): LeaderEntry[] {
    return toEntries(rankBest(this.rows).slice(0, n));
  }

  hasRound(roundId: string): boolean {
    return this.rows.some((r) => r.roundId === roundId);
  }

  add(row: Omit<LeaderRow, 'id'>): SubmitResult {
    if (this.hasRound(row.roundId)) throw new Error('這局已經登記過了');
    const id = this.rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    this.rows.push({ ...row, id });
    this.onChange?.(this.rows);
    return resultFor(rankBest(this.rows), row.key, id);
  }

  all(): LeaderRow[] {
    return this.rows.map((r) => ({ ...r }));
  }
}

// ---------- SQLite（Cloudflare Durable Object；測試用 node:sqlite） ----------

/** 最小的 SQL 介面：執行並回傳所有列。DO 用 storage.sql.exec(...).toArray()；Node 測試用 node:sqlite。 */
export type SqlExec = (sql: string, ...params: (string | number | null)[]) => Record<string, unknown>[];

export class SqlStore implements LeaderboardStore {
  private exec: SqlExec;

  constructor(exec: SqlExec) {
    this.exec = exec;
    exec(`CREATE TABLE IF NOT EXISTS leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      score INTEGER NOT NULL,
      players INTEGER NOT NULL,
      at INTEGER NOT NULL,
      formula TEXT NOT NULL,
      raw TEXT NOT NULL
    )`);
    exec('CREATE INDEX IF NOT EXISTS leaderboard_key ON leaderboard (name_key, score DESC, at ASC)');
  }

  private static row(r: Record<string, unknown>): LeaderRow {
    return {
      id: Number(r.id),
      roundId: String(r.round_id),
      name: String(r.name),
      key: String(r.name_key),
      score: Number(r.score),
      players: Number(r.players),
      at: Number(r.at),
      formula: String(r.formula),
      raw: JSON.parse(String(r.raw)) as ScoreRaw,
    };
  }

  /** 每隊最好的一筆，已排好。 */
  private ranked(limit?: number): LeaderRow[] {
    const rows = this.exec(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY score DESC, at ASC, id ASC) AS rn FROM leaderboard
       ) WHERE rn = 1 ORDER BY score DESC, at ASC, id ASC` + (limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : ''),
    );
    return rows.map(SqlStore.row);
  }

  top(n = TOP_N): LeaderEntry[] {
    return toEntries(this.ranked(n));
  }

  hasRound(roundId: string): boolean {
    return this.exec('SELECT 1 AS x FROM leaderboard WHERE round_id = ?', roundId).length > 0;
  }

  add(row: Omit<LeaderRow, 'id'>): SubmitResult {
    if (this.hasRound(row.roundId)) throw new Error('這局已經登記過了');
    const inserted = this.exec(
      'INSERT INTO leaderboard (round_id, name, name_key, score, players, at, formula, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      row.roundId,
      row.name,
      row.key,
      row.score,
      row.players,
      row.at,
      row.formula,
      JSON.stringify(row.raw),
    );
    return resultFor(this.ranked(), row.key, Number(inserted[0].id));
  }

  all(): LeaderRow[] {
    return this.exec('SELECT * FROM leaderboard ORDER BY id').map(SqlStore.row);
  }
}
