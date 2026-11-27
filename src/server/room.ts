// 房間層：玩家、職能分派、故事卡、線索、補船分派、權限、重連、結尾回顧。伺服器權威；規則交給 src/engine。
import {
  activeCards,
  aboardOf,
  apply,
  createGame,
  crisisAtFor,
  dawnOpensAt,
  eliminationClueCount,
  evaluate,
  providers,
  seedOf,
  sweepWarning,
  symbolCount,
  usesNow,
  usesTonight,
  TIME_UP_AT,
  isSafe,
  LOCK_OPENS_AT,
  LOCK_OPENS_AT_LATER,
  type GameEvent,
  type GameState,
} from '../engine/game.ts';
import { REASON_TEXT, evaluatePlan, storyOk, validSetups, type Evaluation, type RejectReason, type Setup } from '../engine/rules.ts';
import { CARDS, CLASSIC, DIALS, ITEMS, NEEDS, USES, type CardId, type DialId, type ItemId, type NeedId, type SeedId, type Tonight, type UseId } from '../engine/seeds.ts';
import { scoreOf, type ScoreBreakdown, type ScoreRaw } from '../engine/score.ts';
import { describeSymbol, makeEliminationClues, makeSlots, parseSymbol, rng } from '../engine/symbols.ts';
import {
  ASKS,
  BIBLE_THROWS,
  CAMEOS,
  CARD_TEXT,
  CLUES,
  ENDING_VERSES,
  FACTS,
  FIRESIDE_VERSE,
  HINT_ROLE,
  HINT_TEXT,
  OBSERVER_ASKS_WITH_SCOUT,
  PREFERENCES,
  QUESTIONS,
  ROLE_BUNDLES,
  ROLE_CARD,
  ROLES,
  SPLIT_FROM,
  STORY,
  TONIGHT_ROLE,
  TONIGHT_TEXT,
  USE_TEXT,
  type Preference,
  type RoleId,
} from './content.ts';
import type { Action, CardView, MomentView, Rejection, View, ViewPhase, VoteChoice } from './view.ts';

export const INTRO_MS = 60_000;
/**
 * 上船（不計時，DECISIONS 20 新手引導 v2 ①A）：按開始後先看角色卡＋短動畫，再開始 8 分鐘倒數。
 * 首局 40 秒（角色卡 8 秒＋三格動畫 30 秒），第二局起 10 秒（只看角色卡）。房主可以提早開船。
 * Room 預設 0（直接開始，方便單元測試）；Hub 預設 BOARDING_MS。
 */
export const BOARDING_MS = 40_000;
export const BOARDING_LATER_MS = 10_000;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const SEED_ID: SeedId = 'ship 001';
/** 表決：其他人幾毫秒沒回應就算同意（DECISIONS 18）。 */
export const VOTE_MS = 10_000;
/** 同一個動作表決沒通過幾次後，負責人可以強制執行。 */
export const FORCE_AFTER = 2;
/** 表決結果（沒通過／強制）在畫面上顯示多久。 */
export const VOTE_RESULT_SHOW_MS = 8_000;
/** 要全員同意的動作。丟東西、撈東西、補船、油燈不用。 */
const VOTED: Action['type'][] = ['lock', 'use', 'depart'];

interface Proposal {
  id: string;
  key: string; // 'lock'、'depart'、'use:吃飯'…（沒通過次數照這個算）
  action: Action;
  by: string;
  at: number; // 局內毫秒
  deadline: number; // 局內毫秒
  voters: string[]; // 提案當時在線的其他參與者
  votes: Map<string, VoteChoice>;
  attempt: number; // 第幾次提
}

export interface Player {
  id: string;
  token: string;
  nickname: string;
  connected: boolean;
  left: boolean;
  pref: Preference | null;
  seenActs: string[];
}

interface Round {
  /** 每局唯一的代號（排行榜用來防止同一局登記兩次）。 */
  id: string;
  no: number;
  seedId: SeedId;
  startedAt: number;
  firstRound: boolean;
  game: GameState;
  participants: string[];
  roles: Map<string, RoleId[]>;
  engineerId: string;
  slotHolders: string[]; // 第 i 格記號在誰手上
  clueHolders: Map<string, string>; // 排除線索
  prefHolderId: string | null;
  /** 油燈是玩家自己帶的（true）還是倉庫配給的（false）。 */
  prefByItem: boolean;
  actors: { kind: string; playerId: string; at: number }[];
  thanks: Map<string, string>;
  /** 突破口第 n 段線索在誰手上（三段在三支手機）。 */
  btHolders: Map<number, string>;
  /** 見聞：哪一張在誰手上（A4 的局不發「繩」）。 */
  tonightHolders: Map<DialId, string>;
  /** 已登記上榜（每局只能一次）。 */
  submitted: { name: string; rank: number; best: boolean; bestScore: number } | null;
  /** 進行中的表決（一次只有一個）。 */
  proposal: Proposal | null;
  /** 各動作表決沒通過幾次（通過或強制後歸零）。 */
  fails: Map<string, number>;
  /** 最近一次表決結果。 */
  lastVote: { key: string; by: string; outcome: 'rejected' | 'forced' | 'cancelled'; wait: number; info: number; at: number; tries: number; phase?: string } | null;
  /** 這局表決的紀錄（結尾回顧用）。 */
  voteLog: { key: string; by: string; outcome: 'passed' | 'rejected' | 'forced' | 'cancelled'; at: number }[];
  /** 剛結束的表決代號（最近幾個）：連點送來的晚到票安靜忽略，不跳錯誤（docs/15 M1）。 */
  endedVotes?: string[];
  /** 這局認識隊友多久（首局 60 秒、第二局起 30 秒；DECISIONS 20）。舊存檔沒有＝房間預設。 */
  introMs?: number;
  /** 停電時記號持有者看到的圖案轉幾度（0／90／180／270；每格一個，DECISIONS 20 試行）。 */
  slotRots?: number[];
  /** 這局上船（不計時的角色卡＋動畫）多久；倒數從 startedAt 開始，上船期間 elapsed() 是負的。 */
  boardingMs?: number;
  /** 上一局誰拿哪個職能（第二局起角色卡寫「上一局的伙房是 大衛」）。 */
  prevRoles?: [RoleId, string][];
  /** 補船每一格補好的時間、誰形容、誰選對（火堆旁回顧用真實紀錄）。 */
  slotDone?: { slot: number; at: number; holder: string | null; by: string }[];
}

const EXTRA_REASON_TEXT: Record<string, string> = {
  WRONG_PHASE: '現在不能做這個動作',
  TOO_EARLY: '還在認識隊友的時間',
  PINNED: '船主不准丟',
  SWEPT: '已經被浪捲走了',
  NO_ITEM: '那樣東西不在船上',
  CANNOT_TONIGHT: '今晚做不到',
  ALREADY_USED: '出發前只來得及做一件',
  PANEL_LOCKED: '選錯了，面板鎖住一下',
  VOTING: '大家正在表決',
};

function reasonText(r: string, overweight = 0): string {
  if (r === 'OVERWEIGHT' && overweight > 0) return `超重 ${overweight}`;
  return REASON_TEXT[r as RejectReason] ?? EXTRA_REASON_TEXT[r] ?? r;
}

function randomId(len = 16): string {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 序列化：Map 存成 {$m: [[k, v]…]}，其餘照 JSON。 */
function replacer(_k: string, v: unknown): unknown {
  return v instanceof Map ? { $m: [...v.entries()] } : v;
}
function reviver(_k: string, v: unknown): unknown {
  return v && typeof v === 'object' && !Array.isArray(v) && '$m' in v && Object.keys(v).length === 1 ? new Map((v as { $m: [unknown, unknown][] }).$m) : v;
}

function cardView(id: CardId, alreadyGone: ItemId[] = []): CardView {
  const v = { id, deck: CARDS[id].deck, ...CARD_TEXT[id] };
  // 卡片要帶走的東西早就被你們丟了：照實說，不假裝有影響
  const removes = CARDS[id].remove ?? [];
  if (removes.length && removes.every((i) => alreadyGone.includes(i))) {
    v.effect = `${removes.join('、')}你們早就丟進海裡了，這件事沒有再改變什麼。` + (CARDS[id].weight ? '（其他效果照常）' : '');
  }
  return v;
}

export class Room {
  code: string;
  players: Player[] = [];
  hostId: string | null = null;
  round: Round | null = null;
  roundsPlayed = 0;
  lastActivity = Date.now();
  /**
   * 暫停（2026-11-22 使用者決定，DECISIONS 19）：這局一半以上的隊員同時離線（伺服器重啟、場地網路掛掉）時，
   * 倒數、表決、捲走等所有局內時間都停住；大家連回來後從停住的地方繼續。值＝開始暫停的伺服器時間。
   */
  pausedAt: number | null = null;
  /** 開局認識隊友的時間；這段時間可以排方案但不能鎖定。 */
  introMs: number;
  private lastSig = '';
  private now: () => number;
  private random: () => number;

  /** 捲走前提醒幾毫秒（正式遊戲 10 秒；只給自動測試縮短）。 */
  sweepWarningMs: number | undefined;
  /** 練習房（單機試玩 solo.html 開的）：分數照算照顯示，但不能登記排行榜。 */
  practice: boolean;
  /** 表決沒回應算同意的時間（正式 10 秒；只給自動測試縮短）。 */
  voteMs: number;
  /** 首局上船多久（不計時；第二局起按比例縮成 1/4）。 */
  boardingMs: number;

  constructor(code: string, opts: { now?: () => number; seed?: number; introMs?: number; sweepWarningMs?: number; voteMs?: number; practice?: boolean; boardingMs?: number } = {}) {
    this.code = code;
    this.boardingMs = opts.boardingMs ?? 0;
    this.voteMs = opts.voteMs ?? VOTE_MS;
    this.practice = !!opts.practice;
    this.introMs = opts.introMs ?? INTRO_MS;
    this.sweepWarningMs = opts.sweepWarningMs;
    this.now = opts.now ?? Date.now;
    this.random = opts.seed !== undefined ? rng(opts.seed) : Math.random;
  }

  // ---------- 玩家 ----------

  addPlayer(nickname: string): Player {
    const active = this.players.filter((p) => !p.left);
    if (active.length >= MAX_PLAYERS) throw new Error('房間已滿（最多 10 人）');
    const name = nickname.trim().slice(0, 12) || `隊員${active.length + 1}`;
    const player: Player = { id: randomId(10), token: randomId(24), nickname: this.uniqueName(name), connected: true, left: false, pref: null, seenActs: [] };
    this.players.push(player);
    this.transferHostIfNeeded(); // 房主不在線時優先交給這局的隊員
    this.touch();
    return player;
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.players.filter((p) => !p.left).map((p) => p.nickname));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
  }

  get(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  resume(id: string, token: string): Player | null {
    const p = this.get(id);
    if (!p || p.token !== token || p.left) return null;
    p.connected = true;
    this.transferHostIfNeeded();
    this.updatePause();
    this.touch();
    return p;
  }

  disconnect(id: string): void {
    const p = this.get(id);
    if (!p) return;
    p.connected = false;
    this.transferHostIfNeeded();
    this.updatePause();
  }

  leave(id: string): void {
    const p = this.get(id);
    if (!p) return;
    p.connected = false;
    p.left = true;
    if (!this.round) this.players = this.players.filter((x) => x.id !== id);
    this.transferHostIfNeeded();
    this.updatePause();
  }

  private transferHostIfNeeded(): void {
    const host = this.hostId ? this.get(this.hostId) : undefined;
    if (host && host.connected && !host.left) return;
    // 一局進行中或剛結算：房主優先交給這局的隊員（登記上榜要由隊員決定隊名）
    const inRound = this.round?.participants ?? [];
    const next = this.players.find((p) => p.connected && !p.left && inRound.includes(p.id)) ?? this.players.find((p) => p.connected && !p.left);
    this.hostId = next ? next.id : null;
  }

  setPref(id: string, value: Preference | null): void {
    const p = this.get(id);
    if (!p) return;
    if (value !== null && !(value in PREFERENCES)) return;
    p.pref = value;
    this.touch();
  }

  connectedPlayers(): Player[] {
    return this.players.filter((p) => p.connected && !p.left);
  }

  isEmpty(): boolean {
    return this.connectedPlayers().length === 0;
  }

  private touch(): void {
    this.lastActivity = this.now();
  }

  // ---------- 開局 ----------

  start(byId: string): void {
    if (byId !== this.hostId) throw new Error('只有房主可以開始');
    if (this.round && this.round.game.phase !== 'settled' && this.round.game.phase !== 'ended') throw new Error('這局還在進行');
    const ready = this.connectedPlayers();
    if (ready.length < MIN_PLAYERS) throw new Error('至少要 3 人才能開始');
    const participants = ready.slice(0, MAX_PLAYERS).map((p) => p.id);
    this.startRound(participants);
  }

  next(byId: string): void {
    if (byId !== this.hostId) throw new Error('只有房主可以開下一局');
    this.players = this.players.filter((p) => !p.left);
    this.start(byId);
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 抽故事卡與見聞：同一個房間盡量不重複最近抽過的卡、也盡量換一組見聞。 */
  private usedCards: CardId[] = [];
  private lastTonight: Tonight | null = null;
  /** 測試用：指定下一局的故事卡（與見聞；不給見聞＝首局經典配置，之後從表裡挑一組能配的）。 */
  forceCards: { a: CardId; b: CardId; tonight?: Tonight } | null = null;
  private drawSetup(): { cards: { a: CardId; b: CardId }; tonight: Tonight } {
    const table = validSetups();
    const same = (x: Tonight, y: Tonight | null) => !!y && DIALS.every((d) => x[d] === y[d]);
    const pickOne = <T>(xs: T[]) => xs[Math.floor(this.random() * xs.length)];
    if (this.forceCards) {
      const f = this.forceCards;
      this.forceCards = null;
      const pool = table.filter((x) => x.a === f.a && x.b.includes(f.b) && (f.tonight ? same(x.tonight, f.tonight) : this.roundsPlayed === 0 ? same(x.tonight, CLASSIC) : true));
      if (!pool.length) throw new Error(`故事卡 ${f.a}+${f.b} 沒有能配的見聞`);
      const tonight = f.tonight ?? (pool.find((x) => same(x.tonight, CLASSIC)) ?? pickOne(pool)).tonight;
      this.usedCards.push(f.a, f.b);
      this.lastTonight = tonight;
      return { cards: { a: f.a, b: f.b }, tonight: { ...tonight } };
    }
    // 首局固定經典配置（新人先學會骨架）；第二局起整張表都可能，盡量換一組見聞（docs/12 3.4）
    let pool: Setup[] = this.roundsPlayed === 0 ? table.filter((x) => same(x.tonight, CLASSIC)) : table;
    const freshA = pool.filter((x) => !this.usedCards.includes(x.a));
    if (freshA.length) pool = freshA;
    const newTonight = pool.filter((x) => !same(x.tonight, this.lastTonight));
    if (newTonight.length) pool = newTonight;
    const setup = pickOne(pool);
    const freshB = setup.b.filter((b) => !this.usedCards.includes(b));
    const b = pickOne(freshB.length ? freshB : setup.b);
    this.usedCards.push(setup.a, b);
    // 一疊 5 張：抽滿一輪就重新開始，但不立刻重複上一局
    if (this.usedCards.length >= 8) this.usedCards = [setup.a, b];
    this.lastTonight = setup.tonight;
    return { cards: { a: setup.a, b }, tonight: { ...setup.tonight } };
  }

  private startRound(participants: string[]): void {
    const n = participants.length;
    const bundles = ROLE_BUNDLES[n];
    const order = this.rotatedOrder(participants, bundles);
    const roles = new Map<string, RoleId[]>();
    order.forEach((pid, i) => roles.set(pid, bundles[i]));
    const engineerId = order.find((pid) => roles.get(pid)!.includes('eng'))!;

    const symbolSeed = Math.floor(this.random() * 2 ** 31);
    const slots = makeSlots(symbolCount(n), symbolSeed);
    const nonEng = this.shuffle(participants.filter((p) => p !== engineerId));
    const k = symbolCount(n);
    const slotHolders = nonEng.slice(0, k);
    const clueTexts = makeEliminationClues(slots, eliminationClueCount(n), symbolSeed);
    const clueHolders = new Map<string, string>();
    nonEng.slice(k).forEach((pid, i) => clueHolders.set(pid, clueTexts[i] ?? '正確的記號都在選項裡，仔細聽隊友形容。'));

    // 油燈：從自己帶油燈的非木匠抽一位；沒有就由倉庫配給一位非木匠（公開顯示是誰）
    const carriers = this.shuffle(nonEng.filter((pid) => this.get(pid)?.pref === 'lamp'));
    const prefHolderId = carriers[0] ?? nonEng[Math.floor(this.random() * nonEng.length)] ?? null;
    const grayOrder = slots.map((s) => this.shuffle(s.options));
    const { cards, tonight } = this.drawSetup();

    const firstRound = this.roundsPlayed === 0;
    // 第二局起同一群人已經認識，認識隊友從 60 秒縮成 30 秒（DECISIONS 20）；測試縮短 introMs 時同比例
    const introMs = firstRound ? this.introMs : Math.round((this.introMs * LOCK_OPENS_AT_LATER) / LOCK_OPENS_AT);
    const slotRots = slots.map(() => [0, 90, 180, 270][Math.floor(this.random() * 4)]);
    const boardingMs = firstRound ? this.boardingMs : Math.round((this.boardingMs * BOARDING_LATER_MS) / BOARDING_MS);
    this.roundsPlayed++;
    const btHolders = this.assignBreakthrough(participants, roles);
    const tonightHolders = new Map<DialId, string>();
    for (const d of DIALS) {
      if (CARDS[cards.a].fix?.[d] !== undefined) continue; // A4：船底已捆好，不發「繩」
      const h = Room.holderIn(participants, roles, TONIGHT_ROLE[d]);
      if (h) tonightHolders.set(d, h);
    }
    // 上一局的職能（每個職能取主要持有者）：第二局起角色卡寫「上一局的伙房是 大衛——卡住可以問他」
    const prevRoles: [RoleId, string][] = [];
    if (this.round) for (const [pid, rs] of this.round.roles) for (const role of rs) if (participants.includes(pid)) prevRoles.push([role, pid]);
    this.round = {
      id: `${this.code}-${this.roundsPlayed}-${randomId(8)}`,
      no: this.roundsPlayed,
      seedId: SEED_ID,
      startedAt: this.now() + boardingMs, // 倒數在上船之後才開始
      firstRound,
      game: createGame({ seedId: SEED_ID, playerCount: n, firstRound, slots, cards, tonight, sweep: !firstRound, sweepWarningMs: this.sweepWarningMs, grayOrder, lockOpensAt: introMs }),
      participants,
      roles,
      engineerId,
      slotHolders,
      clueHolders,
      prefHolderId,
      prefByItem: carriers.length > 0,
      actors: [],
      thanks: new Map(),
      btHolders,
      tonightHolders,
      submitted: null,
      proposal: null,
      fails: new Map(),
      lastVote: null,
      voteLog: [],
      endedVotes: [],
      introMs,
      slotRots,
      boardingMs,
      prevRoles,
      slotDone: [],
    };
    this.touch();
  }

  /** 還在上船（倒數還沒開始）。 */
  boarding(): boolean {
    return !!this.round && this.elapsed() < 0;
  }

  /** 房主：大家都看完角色卡了，提早開船（倒數從現在開始）。 */
  skipBoarding(byId: string): void {
    if (byId !== this.hostId) throw new Error('只有房主可以開船');
    if (!this.boarding() || this.pausedAt !== null) return;
    this.round!.startedAt = this.now();
    this.touch();
  }

  /** 這局認識隊友多久（毫秒）。 */
  introOf(): number {
    return this.round?.introMs ?? this.introMs;
  }

  /** 職能分派：第二局起盡量讓每個人拿到和上一局不同的職能（ADR-0003 第 35 條）。 */
  private rotatedOrder(participants: string[], bundles: RoleId[][]): string[] {
    const prev = this.round?.roles;
    let best = this.shuffle(participants);
    if (!prev) return best;
    const same = (order: string[]) => order.filter((pid, i) => prev.get(pid)?.[0] === bundles[i][0]).length;
    let bestSame = same(best);
    for (let t = 0; t < 30 && bestSame > 0; t++) {
      const o = this.shuffle(participants);
      const k = same(o);
      if (k < bestSame) [best, bestSame] = [o, k];
    }
    return best;
  }

  /** 職能持有者（含拆分職能回到原職能）。 */
  private static holderIn(participants: string[], roles: Map<string, RoleId[]>, role: RoleId): string | null {
    for (const pid of participants) if (roles.get(pid)!.includes(role)) return pid;
    const parent = SPLIT_FROM[role];
    return parent ? Room.holderIn(participants, roles, parent) : null;
  }

  /** 突破口三段線索依職能分給三個人；兩段落在同一支手機時，把後面那段轉給還沒拿到的隊友。 */
  private assignBreakthrough(participants: string[], roles: Map<string, RoleId[]>): Map<number, string> {
    const out = new Map<number, string>();
    const taken = new Set<string>();
    // 第 3 段（伙房，有吃飯按鈕）先排，確保按鈕與線索在同一支手機
    for (const c of CLUES.filter((x) => x.breakthrough).sort((a, b) => b.breakthrough! - a.breakthrough!)) {
      let holder = Room.holderIn(participants, roles, c.role);
      if (!holder || taken.has(holder)) holder = participants.find((p) => !taken.has(p)) ?? holder;
      if (!holder) continue;
      out.set(c.breakthrough!, holder);
      taken.add(holder);
    }
    return out;
  }

  // ---------- 操作 ----------

  elapsed(): number {
    if (!this.round) return 0;
    return (this.pausedAt ?? this.now()) - this.round.startedAt;
  }

  private pausedView(): View['paused'] {
    const r = this.round;
    if (!r || this.pausedAt === null) return null;
    const offline = r.participants.map((id) => this.get(id)).filter((p): p is Player => !!p && !p.left && !p.connected);
    return { at: this.pausedAt, offline: offline.map((p) => p.nickname) };
  }

  /** 這局進行中、沒離開的隊員裡，一半以上離線＝要暫停。 */
  private shouldPause(): boolean {
    const r = this.round;
    if (!r || r.game.phase === 'settled' || r.game.phase === 'ended') return false;
    const team = r.participants.map((id) => this.get(id)).filter((p): p is Player => !!p && !p.left);
    if (!team.length) return false;
    const offline = team.filter((p) => !p.connected).length;
    return offline * 2 >= team.length;
  }

  /** 依目前在線人數開始或結束暫停；結束時把開局時間往後挪，局內時間就接得上。回傳是否有變化。 */
  updatePause(): boolean {
    const want = this.shouldPause();
    if (want && this.pausedAt === null) {
      this.pausedAt = this.now();
      return true;
    }
    if (!want && this.pausedAt !== null) {
      if (this.round) this.round.startedAt += this.now() - this.pausedAt;
      this.pausedAt = null;
      return true;
    }
    return false;
  }

  /** 定時呼叫；回傳狀態是否有需要廣播的變化。 */
  tick(): boolean {
    const pauseChanged = this.updatePause();
    const r = this.round;
    if (!r || r.game.phase === 'settled' || r.game.phase === 'ended') return pauseChanged;
    if (this.pausedAt !== null) return pauseChanged;
    if (this.elapsed() < 0) {
      // 上船中：倒數還沒開始，規則時間不走
      const sig = 'boarding';
      if (sig === this.lastSig) return pauseChanged;
      this.lastSig = sig;
      return true;
    }
    r.game = apply(r.game, { type: 'tick', at: this.elapsed() });
    if (r.proposal) this.settleVote();
    const sig = this.signature();
    if (sig === this.lastSig) return pauseChanged;
    this.lastSig = sig;
    return true;
  }

  private signature(): string {
    const g = this.round?.game;
    if (!g) return '';
    const r = this.round!;
    const open = dawnOpensAt(g);
    const p = r.proposal;
    const voteShown = !!r.lastVote && this.elapsed() - r.lastVote.at <= VOTE_RESULT_SHOW_MS;
    return [g.phase, this.elapsed() >= this.introOf(), g.hint.shown, g.warned, g.repair?.assistLevel, g.crisisAt, g.result?.stars, open !== null && g.now >= open, p?.id, p?.votes.size, voteShown, g.used?.at].join('|');
  }

  private online(pid: string): boolean {
    const p = this.get(pid);
    return !!p && p.connected && !p.left;
  }

  private holderOf(role: RoleId): string | null {
    const r = this.round!;
    return Room.holderIn(r.participants, r.roles, role);
  }

  /** 操作者：持有該職能者在線就是他，否則交給第一位在線的參與者（不讓離線卡死）。 */
  private operatorOf(role: RoleId): string | null {
    const r = this.round!;
    const holder = this.holderOf(role);
    if (holder && this.online(holder)) return holder;
    return r.participants.find((p) => this.online(p)) ?? null;
  }

  private effectiveSlotHolder(slot: number): string | null {
    const r = this.round!;
    const holder = r.slotHolders[slot];
    if (holder && this.online(holder)) return holder;
    const eng = this.operatorOf('eng');
    const busy = new Set(r.slotHolders.filter((h) => this.online(h)));
    return (
      r.participants.find((p) => this.online(p) && p !== eng && !busy.has(p)) ??
      r.participants.find((p) => this.online(p) && p !== eng) ??
      eng
    );
  }

  private effectivePrefHolder(): string | null {
    const r = this.round!;
    if (r.prefHolderId && this.online(r.prefHolderId)) return r.prefHolderId;
    const eng = this.operatorOf('eng');
    return r.participants.find((p) => this.online(p) && p !== eng) ?? null;
  }

  private permitted(pid: string, a: Action): boolean {
    const r = this.round!;
    if (!r.participants.includes(pid)) return false;
    switch (a.type) {
      case 'setItem':
        return this.operatorOf('supply') === pid;
      case 'lock':
      case 'depart':
        return this.operatorOf('nav') === pid;
      case 'repairPick':
        return this.operatorOf('eng') === pid;
      case 'useEliminate':
        return this.effectivePrefHolder() === pid;
      case 'use':
        return Object.hasOwn(USE_TEXT, a.use) && this.operatorOf(USE_TEXT[a.use].role) === pid;
      default:
        return false;
    }
  }

  /**
   * 訊息去重（act 的 id、其他訊息的 mid 共用）：第一次看到回傳 false 並記下；看過回傳 true。
   * 每人只記最近 300 個。
   */
  seen(pid: string, msgId: string): boolean {
    const p = this.get(pid);
    if (!p) return false;
    if (p.seenActs.includes(msgId)) return true;
    p.seenActs.push(msgId);
    if (p.seenActs.length > 300) p.seenActs.shift();
    return false;
  }

  // ---------- 存檔（2026-11-22 連線加強：伺服器重啟、重新部署後房間還在） ----------

  /** 整個房間轉成文字（存進 Durable Object 的 SQLite）。 */
  serialize(): string {
    return JSON.stringify(
      {
        v: 1,
        savedAt: this.now(),
        code: this.code,
        players: this.players,
        hostId: this.hostId,
        round: this.round,
        roundsPlayed: this.roundsPlayed,
        lastActivity: this.lastActivity,
        pausedAt: this.pausedAt,
        introMs: this.introMs,
        boardingMs: this.boardingMs,
        sweepWarningMs: this.sweepWarningMs ?? null,
        practice: this.practice,
        voteMs: this.voteMs,
        usedCards: this.usedCards,
        lastTonight: this.lastTonight,
        forceCards: this.forceCards,
      },
      replacer,
    );
  }

  /**
   * 從存檔讀回。讀回時大家都算離線（連線都斷了），等各自 resume；
   * 進行中的局因此會先暫停（DECISIONS 19），大家連回來再繼續。
   */
  static restore(json: string, opts: { now?: () => number } = {}): Room {
    const d = JSON.parse(json, reviver);
    if (d.v !== 1) throw new Error('看不懂的房間存檔版本');
    const room = new Room(d.code, { now: opts.now, introMs: d.introMs, boardingMs: d.boardingMs ?? 0, sweepWarningMs: d.sweepWarningMs ?? undefined, voteMs: d.voteMs, practice: d.practice });
    room.players = d.players;
    room.hostId = d.hostId;
    room.round = d.round;
    room.roundsPlayed = d.roundsPlayed;
    room.lastActivity = d.lastActivity;
    room.pausedAt = d.pausedAt;
    // 存檔之後到讀回之前（伺服器重啟的那段時間）也算暫停：倒數從最後存檔那一刻接著走
    const live = room.round && room.round.game.phase !== 'settled' && room.round.game.phase !== 'ended';
    if (room.pausedAt === null && live && typeof d.savedAt === 'number') room.pausedAt = d.savedAt;
    room.usedCards = d.usedCards ?? [];
    room.lastTonight = d.lastTonight ?? null;
    room.forceCards = d.forceCards ?? null;
    for (const p of room.players) p.connected = false;
    room.updatePause();
    return room;
  }

  /**
   * 執行一個動作。重複送出（同一個 id）會被忽略並回傳 null；
   * 被規則擋下時回傳 Rejection（原因＋下一步）。
   */
  act(pid: string, actId: string, a: Action): Rejection | null {
    const p = this.get(pid);
    if (!p) throw new Error('找不到玩家');
    if (this.seen(pid, actId)) return null;
    const r = this.round;
    if (!r) throw new Error('還沒開始');
    if (!this.permitted(pid, a)) throw new Error('這不是你負責的操作');
    if (this.pausedAt !== null) return { action: a.type, reasons: [{ code: 'PAUSED', text: '一半以上的隊友斷線了，時間先停住：等大家連回來再繼續' }] };
    if (this.elapsed() < 0) return { action: a.type, reasons: [{ code: 'BOARDING', text: '還在上船：看完角色卡、倒數開始後就能動' }] };
    if (VOTED.includes(a.type)) return this.propose(pid, a);
    return this.execute(pid, a);
  }

  /** 真的交給規則執行（表決通過、強制、或不用表決的動作）。 */
  private execute(pid: string, a: Action): Rejection | null {
    const r = this.round!;
    const at = this.elapsed();
    const event = { ...a, at } as GameEvent;
    const before = r.game;
    const holder = a.type === 'repairPick' && before.repair ? this.effectiveSlotHolder(before.repair.progress) : null;
    r.game = apply(r.game, event);
    r.actors.push({ kind: a.type, playerId: pid, at });
    if (a.type === 'repairPick' && before.repair && r.game.repair && r.game.repair.progress > before.repair.progress) {
      (r.slotDone ??= []).push({ slot: before.repair.progress, at, holder, by: pid });
    }
    this.touch();
    if (r.game.rejections > before.rejections && r.game.lastRejection) {
      return { action: a.type, reasons: r.game.lastRejection.reasons.map((code) => ({ code, text: this.advice(code, pid, at) })) };
    }
    return null;
  }

  private static voteKey(a: Action): string {
    return a.type === 'use' ? `use:${a.use}` : a.type;
  }

  private static voteLabel(key: string): string {
    if (key === 'lock') return '決定好了';
    if (key === 'depart') return '衝向海灘';
    const u = key.slice(4) as UseId;
    return USE_TEXT[u]?.label ?? key;
  }

  /**
   * 提案（DECISIONS 18）：規則會擋的直接回原因（不用表決）；同一個動作已經 2 次沒通過＝強制執行；
   * 沒有其他在線隊員＝直接執行；否則開表決，其他在線參與者同意／不同意，10 秒沒回應算同意。
   */
  private propose(pid: string, a: Action): Rejection | null {
    const r = this.round!;
    const at = this.elapsed();
    // 結算後不開表決（連點「衝向海灘」不留下看不見的表決；docs/15 L3）
    if (r.game.phase === 'settled' || r.game.phase === 'ended') return null;
    if (r.proposal) {
      r.game = apply(r.game, { type: 'tick', at });
      return { action: a.type, reasons: [{ code: 'VOTING', text: `大家正在表決「${Room.voteLabel(r.proposal.key)}」：等結果出來` }] };
    }
    // 先試一次：規則會擋（超重、還在黑暗中…）就直接告訴按的人，不必讓大家表決
    const trial = apply(r.game, { ...a, at } as GameEvent);
    if (trial.rejections > r.game.rejections && trial.lastRejection) {
      r.game = trial;
      return { action: a.type, reasons: trial.lastRejection.reasons.map((code) => ({ code, text: this.advice(code, pid, at) })) };
    }
    const key = Room.voteKey(a);
    const fails = r.fails.get(key) ?? 0;
    const voters = r.participants.filter((p) => p !== pid && this.online(p));
    if (fails >= FORCE_AFTER) {
      r.fails.delete(key);
      r.lastVote = { key, by: pid, outcome: 'forced', wait: 0, info: 0, at, tries: fails, phase: r.game.phase };
      r.voteLog.push({ key, by: pid, outcome: 'forced', at });
      return this.execute(pid, a);
    }
    if (!voters.length) return this.execute(pid, a);
    r.proposal = { id: randomId(8), key, action: a, by: pid, at, deadline: at + this.voteMs, voters, votes: new Map(), attempt: fails + 1 };
    this.touch();
    return null;
  }

  /** 投票。重複投同一個表決會被忽略；表決已經結束會丟錯誤。 */
  vote(pid: string, proposalId: string, choice: VoteChoice): void {
    const r = this.round;
    const p = r?.proposal;
    // 剛結束的表決又收到票（連點、網路晚到）：安靜忽略，不跳錯誤
    if (r && (!p || p.id !== proposalId) && r.endedVotes?.includes(proposalId)) return;
    if (!r || !p || p.id !== proposalId) throw new Error('這個表決已經結束了');
    if (!p.voters.includes(pid)) throw new Error('你不用表決這件事');
    if (choice !== 'yes' && choice !== 'wait' && choice !== 'info') throw new Error('看不懂這一票');
    if (p.votes.has(pid)) return;
    p.votes.set(pid, choice);
    this.touch();
    this.settleVote();
  }

  /** 表決還能不能成立（階段變了、提案的人離線＝取消）。 */
  private proposalValid(p: Proposal): boolean {
    const g = this.round!.game;
    if (!this.online(p.by) || this.operatorOf(p.action.type === 'use' ? USE_TEXT[p.action.use].role : 'nav') !== p.by) return false;
    if (p.action.type === 'lock') return g.phase === 'planning' && !g.locked;
    return g.phase === 'replanning';
  }

  /** 看表決有沒有結果：有人不同意＝沒通過；在線的都同意或時間到＝通過（沒回應算同意）。 */
  private settleVote(): void {
    const r = this.round!;
    const p = r.proposal;
    if (!p) return;
    const at = this.elapsed();
    const end = () => {
      r.proposal = null;
      r.endedVotes = [...(r.endedVotes ?? []), p.id].slice(-5);
    };
    if (!this.proposalValid(p)) {
      end();
      r.lastVote = { key: p.key, by: p.by, outcome: 'cancelled', wait: 0, info: 0, at, tries: r.fails.get(p.key) ?? 0, phase: r.game.phase };
      r.voteLog.push({ key: p.key, by: p.by, outcome: 'cancelled', at });
      return;
    }
    const no = [...p.votes.values()].filter((v) => v !== 'yes');
    if (no.length) {
      const tries = (r.fails.get(p.key) ?? 0) + 1;
      r.fails.set(p.key, tries);
      end();
      r.lastVote = { key: p.key, by: p.by, outcome: 'rejected', wait: no.filter((v) => v === 'wait').length, info: no.filter((v) => v === 'info').length, at, tries, phase: r.game.phase };
      r.voteLog.push({ key: p.key, by: p.by, outcome: 'rejected', at });
      return;
    }
    const pending = p.voters.filter((v) => this.online(v) && !p.votes.has(v));
    if (pending.length && at < p.deadline) return;
    end();
    r.fails.delete(p.key);
    r.voteLog.push({ key: p.key, by: p.by, outcome: 'passed', at });
    this.execute(p.by, p.action);
  }

  /** 操作者的稱呼：自己就說「你」，別人就說「暱稱（職能）」。 */
  private whoDoes(role: RoleId, pid: string): string {
    const op = this.operatorOf(role);
    if (op === pid) return '你';
    return ` ${this.nick(op)}（${ROLES[role].name}）`;
  }

  /** 拒絕原因＋下一步（不直接給答案）。at：局內經過毫秒。 */
  advice(code: string, pid: string, at = this.elapsed(), ev?: Evaluation): string {
    const g = this.round!.game;
    ev ??= evaluate(g);
    switch (code) {
      case 'OVERWEIGHT':
        return `超重 ${ev.overweight}：請${this.whoDoes('supply', pid)}再丟一樣`;
      case 'NOT_POWERED':
        return `天太黑了：先幫木匠 ${this.nick(this.operatorOf('eng'))} 補好船`;
      case 'WAIT_DAWN': {
        const open = dawnOpensAt(g) ?? at;
        return `拋了錨，還要等天色亮一點：再 ${Math.max(1, Math.ceil((open - at) / 1000))} 秒`;
      }
      case 'TOO_EARLY': {
        const sec = Math.max(1, Math.ceil((g.lockOpensAt - at) / 1000));
        const total = Math.round(g.lockOpensAt / 1000);
        return `先花 ${total >= 60 && total % 60 === 0 ? `${total / 60} 分鐘` : `${total} 秒`}認識隊友、交換情報；再 ${sec} 秒就能決定。東西可以先丟`;
      }
      case 'PINNED':
        return '船主不准丟麥子（風暴變大以前）';
      case 'SWEPT':
        return '風暴來的時候被浪捲走了，撈不回來';
      case 'NO_ITEM':
        return `那樣東西不在船上：請${this.whoDoes('supply', pid)}先撈回來`;
      case 'CANNOT_TONIGHT':
        return '今晚做不到這件事';
      case 'ALREADY_USED': {
        const u = this.round!.game.used;
        return u ? `出發前只來得及做一件：${USE_TEXT[u.use].done}` : '出發前只來得及做一件';
      }
      case 'PANEL_LOCKED':
        return '選錯了，面板鎖住一下：趁這幾秒再問清楚';
      default:
        return reasonText(code);
    }
  }

  /** 開局「下一步」：去找誰、問什麼。 */
  private nextSteps(pid: string): View['nextSteps'] {
    const r = this.round!;
    const out: View['nextSteps'] = [];
    const used = new Set<string>([pid]);
    const scoutPresent = r.participants.some((p) => r.roles.get(p)!.includes('scout'));
    for (const role of r.roles.get(pid) ?? []) {
      for (const ask of role === 'observer' && scoutPresent ? OBSERVER_ASKS_WITH_SCOUT : ASKS[role]) {
        const to = Room.holderIn(r.participants, r.roles, ask.to);
        if (!to || used.has(to)) continue;
        used.add(to);
        const toRole = (r.roles.get(to) ?? []).find((x) => x === ask.to || x === SPLIT_FROM[ask.to]) ?? ask.to;
        out.push({ verb: ask.verb, nickname: this.nick(to), text: ask.text, roleId: toRole, roleName: ROLES[toRole].name, toId: to });
        break;
      }
    }
    return out.slice(0, 2);
  }

  /**
   * 任務條（docs/17 問題 2）：每個畫面只有一條「你現在要做的事」，合併 myTask 與下一步、寫出對方的角色。
   * 有主按鈕的人（管倉、船長）：認識隊友後主句是自己的操作，先去問誰放副句；其他人主句是去找誰。
   */
  private taskOf(pid: string, phase: ViewPhase, myTask: string | null, steps: View['nextSteps']): View['task'] {
    if (phase === 'boarding' || phase === 'blackout' || phase === 'lobby' || phase === 'settled' || phase === 'ended') return null;
    const go = phase === 'replanning' ? undefined : steps[0];
    const goTask = go ? { verb: go.verb, nickname: go.nickname, roleId: go.roleId, roleName: go.roleName, text: go.text } : null;
    const operator = this.operatorOf('supply') === pid || (this.operatorOf('nav') === pid && phase !== 'intro');
    // 雙向（docs/17 v2）：被找的人也知道「等一下 阿明（醫生）會來找你」，雙方都抬頭
    const incoming =
      phase === 'intro' || phase === 'planning'
        ? this.round!.participants
            .filter((q) => q !== pid && this.nextSteps(q)[0]?.toId === pid)
            .map((q) => {
              const role = this.round!.roles.get(q)![0];
              return { nickname: this.nick(q), roleId: role, roleName: ROLES[role].name };
            })
        : [];
    if (operator && myTask) return { text: myTask, go: goTask, incoming };
    if (goTask) return { text: null, go: goTask, incoming };
    return myTask || incoming.length ? { text: myTask, go: null, incoming } : null;
  }

  /** 角色卡：這局我的職能（3 人局兩個）、台詞、故事裡的人、按鈕什麼時候出現、只有我知道的事。 */
  private roleCard(pid: string): View['roleCard'] {
    const r = this.round!;
    const mine = r.roles.get(pid) ?? [];
    const scoutPresent = r.participants.some((p) => r.roles.get(p)!.includes('scout'));
    return {
      roles: mine.map((id) => {
        const c = ROLE_CARD[id];
        // 6 人以下沒有測水深：拋錨按鈕回到瞭望手上
        const anchor = id === 'observer' && !scoutPresent;
        return {
          id,
          name: ROLES[id].name,
          line: c.line,
          who: c.who,
          ref: c.ref || null,
          note: c.note ?? null,
          button: anchor ? '從船尾拋錨' : c.button,
          when: anchor ? '補好船以後、水淺時' : c.when,
          know: anchor ? '風浪會變大；水有多深' : c.know,
        };
      }),
      // 第二局起：上一局拿同一個職能的人變成前輩（不是自己才寫）
      prev: mine.flatMap((id) => {
        const was = (r.prevRoles ?? []).find(([role]) => role === id)?.[1];
        return was && was !== pid ? [{ roleName: ROLES[id].name, nickname: this.nick(was) }] : [];
      }),
    };
  }

  thank(from: string, to: string | null): void {
    const r = this.round;
    if (!r || (r.game.phase !== 'settled' && r.game.phase !== 'ended')) throw new Error('結算後才能感謝隊友');
    if (to === null) r.thanks.delete(from);
    else if (to !== from && r.participants.includes(to)) r.thanks.set(from, to);
  }

  // ---------- 計分與登記上榜 ----------

  /** 這局的分數（伺服器依規則狀態計算；還沒結束＝null）。 */
  score(): { raw: ScoreRaw; score: ScoreBreakdown } | null {
    const g = this.round?.game;
    return g ? scoreOf(g) : null;
  }

  /** 登記上榜前的檢查：房主、這局已結算、不是練習房、還沒登記過。通過就回傳要存的資料。 */
  submission(pid: string): { roundId: string; raw: ScoreRaw; score: ScoreBreakdown; players: number } {
    const r = this.round;
    if (this.practice) throw new Error('練習模式不計入排行榜');
    if (pid !== this.hostId) throw new Error('只有房主可以登記上榜');
    if (!r) throw new Error('還沒有可以登記的一局');
    if (!r.participants.includes(pid)) throw new Error('只有這局的隊員可以登記上榜');
    const sc = this.score();
    if (!sc) throw new Error('這局還沒結束');
    if (r.submitted) throw new Error('這局已經登記過了');
    return { roundId: r.id, raw: sc.raw, score: sc.score, players: r.participants.length };
  }

  markSubmitted(roundId: string, info: NonNullable<Round['submitted']>): void {
    if (this.round?.id === roundId) this.round.submitted = info;
    this.touch();
  }

  // ---------- 畫面資料 ----------

  private nick(pid: string | null | undefined): string {
    return (pid && this.get(pid)?.nickname) || '隊友';
  }

  /** 線索裡的 {食}{繩}{水} 換成這局拿那張見聞的人的職能（例：{繩} → 水手長；9 人以下 → 管倉）。 */
  private fillRoles(text: string): string {
    const r = this.round!;
    return text.replace(/\{(食|繩|水)\}/g, (_m, d: DialId) => {
      const h = r.tonightHolders.get(d) ?? Room.holderIn(r.participants, r.roles, TONIGHT_ROLE[d]);
      const role = (h && (r.roles.get(h) ?? []).find((x) => x === TONIGHT_ROLE[d] || x === SPLIT_FROM[TONIGHT_ROLE[d]])) || TONIGHT_ROLE[d];
      return ROLES[role].name;
    });
  }

  /** 我這局的任務：沒有按鈕的人也知道自己在做什麼。 */
  private myTask(pid: string, phase: ViewPhase): string | null {
    const r = this.round!;
    const mine = r.roles.get(pid) ?? [];
    if (phase === 'intro' || phase === 'planning') {
      if (this.operatorOf('supply') === pid)
        return r.game.sweep
          ? '你決定丟什麼：按一下＝丟進海裡。風暴一來，漂著的東西就撈不回來，先問清楚再丟。'
          : '你決定丟什麼：按一下東西＝丟進海裡，再按一下撈回來。';
      if (this.operatorOf('nav') === pid) return r.game.locked ? '你決定好了：風暴馬上就來。' : '大家講好了，就由你按「決定好了」（大家都要同意）。';
      if (this.nextSteps(pid).length) return null; // 「下一步」已經說了要找誰
      return `把你知道的告訴 ${this.nick(this.operatorOf('supply'))}（管倉），他負責丟東西。`;
    }
    if (phase === 'replanning') {
      if (this.operatorOf('supply') === pid) return '浪更大了，船只能留 5：再決定一次留什麼。';
      if (this.operatorOf('nav') === pid) return '大家都準備好了，就由你按「衝向海灘」。';
      const mineUses = usesTonight(r.game).filter((u) => this.operatorOf(USE_TEXT[u].role) === pid);
      if (mineUses.length && !r.game.used) return `要不要由你${USE_TEXT[mineUses[0]].label}？先和大家商量。`;
      const r2 = this.round!;
      const hasNew = [...r2.btHolders.values()].includes(pid);
      if (hasNew) return `你有新線索：說給 ${this.nick(this.operatorOf('supply'))}（管倉）聽。`;
      if (mine.length) return `去問問大家：電來了以後，誰有新發現？`;
    }
    return null;
  }

  view(pid: string, joinUrl: string, qrSvg: string | null): View {
    const me = this.get(pid)!;
    const r = this.round;
    const participant = !!r && r.participants.includes(pid);
    const g = r?.game;
    const elapsed = this.elapsed();
    let phase: ViewPhase = 'lobby';
    if (r && g && participant) {
      phase = elapsed < 0 ? 'boarding' : g.phase === 'planning' && elapsed < this.introOf() ? 'intro' : g.phase;
    } else if (r && g && (g.phase === 'settled' || g.phase === 'ended')) {
      phase = 'lobby';
    }
    const myRoles = participant ? r!.roles.get(pid)! : [];
    const finished = !!g && (g.phase === 'settled' || g.phase === 'ended');

    const v: View = {
      code: this.code,
      joinUrl,
      qrSvg: phase === 'lobby' || phase === 'intro' ? qrSvg : null,
      serverNow: this.now(),
      paused: this.pausedView(),
      me: {
        id: me.id,
        nickname: me.nickname,
        isHost: this.hostId === me.id,
        pref: me.pref,
        roles: myRoles.map((id) => ({ id, ...ROLES[id] })),
        spectator: !!r && !participant && !finished,
      },
      players: this.players
        .filter((p) => !p.left)
        .map((p) => {
          const ids = r && r.participants.includes(p.id) ? r.roles.get(p.id)! : [];
          return { id: p.id, nickname: p.nickname, connected: p.connected, isHost: p.id === this.hostId, pref: p.pref, roles: ids.map((x) => ROLES[x].name), roleIds: ids };
        }),
      phase,
      round: null,
      story: null,
      cards: { a: null, b: null },
      ship: null,
      myTask: null,
      nextSteps: [],
      task: null,
      roleCard: null,
      can: {
        start: this.hostId === pid && (!r || finished) && this.connectedPlayers().length >= MIN_PLAYERS,
        items: false,
        lock: false,
        depart: false,
        repair: false,
        eliminate: false,
        next: false,
        submit: false,
        uses: [],
        force: [],
      },
      vote: null,
      voteResult: null,
      tonight: [],
      clues: [],
      hint: null,
      preferenceHint: null,
      crisis: null,
      repair: null,
      result: null,
    };
    if (!r || !g || !participant) return v;

    const seed = seedOf(g);
    const ev = evaluate(g);
    const editable = g.phase === 'planning' || g.phase === 'replanning';
    const powered = g.powerAt !== null;
    v.round = {
      no: r.no,
      seedId: r.seedId,
      seedTitle: seed.title,
      firstRound: r.firstRound,
      startedAt: r.startedAt,
      elapsedMs: elapsed,
      timeLimitMs: TIME_UP_AT,
      introMs: this.introOf(),
      boardingMs: r.boardingMs ?? 0,
      lockOpensAt: r.startedAt + g.lockOpensAt,
      crisisAt: r.startedAt + crisisAtFor(g.cards),
    };
    const storyKey = phase === 'intro' || phase === 'boarding' ? 'intro' : phase === 'planning' ? 'planning' : phase === 'blackout' ? 'blackout' : phase === 'replanning' ? 'replanning' : 'landing';
    v.story = { ...STORY[storyKey] };
    const thrownBeforeB = g.planAtCrisis ? ITEMS.filter((i) => !g.planAtCrisis!.items.includes(i)) : [];
    v.cards = { a: cardView(g.cards.a), b: powered ? cardView(g.cards.b, thrownBeforeB) : null };

    // 船：6 樣東西的狀態
    const { aboard, pinned, weights } = aboardOf(g);
    const shownReasons = ev.reasons.filter((x) => !(g.phase === 'planning' && x === 'NOT_POWERED'));
    const showNeeds = g.crisisAt !== null;
    const useActor = g.used ? [...r.actors].reverse().find((a) => a.kind === 'use' && a.at === g.used!.at) : undefined;
    const dawn = dawnOpensAt(g);
    const warn = sweepWarning(g);
    v.ship = {
      items: ITEMS.map((id) => ({ id, weight: weights[id], onShip: g.plan.items.includes(id), gone: !aboard.includes(id), pinned: pinned.includes(id), swept: g.swept.includes(id) })),
      sweep: g.sweep,
      sweepWarning: warn ? { stormAt: r.startedAt + g.stormAt, floating: warn.floating, extra: warn.extra, overweight: warn.overweight } : null,
      provides: powered ? providers(g) : null,
      weight: ev.weight,
      cap: ev.cap,
      overweight: ev.overweight,
      needs: showNeeds ? NEEDS.map((id) => ({ id, lit: ev.served.includes(id) })) : null,
      stars: showNeeds ? ev.stars : null,
      reasons: shownReasons.map((x) => reasonText(x, ev.overweight)),
      reasonCodes: shownReasons,
      advice: shownReasons.map((x) => this.advice(x, pid, elapsed, ev)),
      locked: g.locked,
      used: g.used
        ? { id: g.used.use, item: g.used.item, at: r.startedAt + g.used.at, by: this.nick(useActor?.playerId), mine: useActor?.playerId === pid }
        : null,
      dawnAt: dawn !== null ? r.startedAt + dawn : null,
      // 背包的乾果在吃飯時出場（docs/17 v2）：「美玲 把帶來的乾果也分給大家」
      nutsBy: (() => {
        const p = this.players.find((x) => r.participants.includes(x.id) && x.pref === 'nuts');
        return p ? p.nickname : null;
      })(),
      lastRejection: g.lastRejection
        ? { at: r.startedAt + g.lastRejection.at, action: g.lastRejection.action, reasons: g.lastRejection.reasons.map((x) => reasonText(x, ev.overweight)) }
        : null,
    };
    // 上船時角色卡上就寫「現在要做的一件事」：用開局（認識隊友）那一條
    const taskPhase = phase === 'boarding' ? 'intro' : phase;
    v.myTask = this.myTask(pid, taskPhase);
    v.nextSteps = this.nextSteps(pid);
    v.task = this.taskOf(pid, taskPhase, v.myTask, v.nextSteps);
    v.roleCard = this.roleCard(pid);
    v.can.items = editable && this.operatorOf('supply') === pid;
    v.can.lock = g.phase === 'planning' && !g.locked && this.operatorOf('nav') === pid;
    v.can.depart = g.phase === 'replanning' && this.operatorOf('nav') === pid;
    // 用掉：按鈕只出現在今晚真的做得到、而且輪到自己的人手上；全隊用掉一件後就收起來
    if (g.phase === 'replanning' && !g.used) {
      const ready = usesNow(g);
      const prov = providers(g);
      v.can.uses = usesTonight(g)
        .filter((u) => this.operatorOf(USE_TEXT[u].role) === pid)
        .map((u) => ({ id: u, label: USE_TEXT[u].label, icon: USE_TEXT[u].icon, ref: USE_TEXT[u].ref, need: USES[u].need, item: prov[USES[u].need], ready: ready.includes(u) }));
    }
    // 表決：我負責、已經 2 次沒通過的動作，再按就強制
    v.can.force = [...r.fails.entries()].filter(([k, n]) => n >= FORCE_AFTER && this.operatorOf(k === 'lock' || k === 'depart' ? 'nav' : USE_TEXT[k.slice(4) as UseId].role) === pid).map(([k]) => k);
    const prop = r.proposal;
    if (prop && !finished) {
      v.vote = {
        id: prop.id,
        label: Room.voteLabel(prop.key),
        by: this.nick(prop.by),
        mine: prop.by === pid,
        deadline: r.startedAt + prop.deadline,
        total: prop.voters.filter((x) => this.online(x)).length,
        agreed: [...prop.votes.values()].filter((x) => x === 'yes').length,
        myVote: prop.votes.get(pid) ?? null,
        canVote: prop.voters.includes(pid) && !prop.votes.has(pid),
        attempt: prop.attempt,
      };
    }
    const lv = r.lastVote;
    // 換階段就清掉上一階段的表決結果（docs/17 3.4：夜裡不該還掛著白天的「沒通過」）
    if (lv && !finished && elapsed - lv.at <= VOTE_RESULT_SHOW_MS && (!lv.phase || lv.phase === g.phase)) {
      v.voteResult = { label: Room.voteLabel(lv.key), by: this.nick(lv.by), outcome: lv.outcome, wait: lv.wait, info: lv.info, at: r.startedAt + lv.at, tries: lv.tries };
    }
    v.can.next = finished && this.hostId === pid;
    // 登記上榜：只有房主看得到；練習房、已登記過都不顯示按鈕
    v.can.submit = finished && this.hostId === pid && !this.practice && !r.submitted;

    // 見聞：只在拿的人手機上（可以互看）
    v.tonight = DIALS.filter((d) => r.tonightHolders.get(d) === pid).map((d) => {
      const t = (TONIGHT_TEXT[d] as Record<string, { title: string; text: string; ref?: string; verse?: string; item?: ItemId; use?: UseId }>)[g.tonight[d]];
      return { dial: d, value: g.tonight[d], title: t.title, text: t.text, ref: t.ref ?? null, verse: t.verse ?? null, tag: t.ref ? null : '遊戲設定', item: t.item ?? null, use: t.use ?? null };
    });

    // 線索：自己的職能，加上不在場的拆分職能
    const present = new Set(r.participants.flatMap((p) => r.roles.get(p)!));
    const mine = new Set<RoleId>(myRoles);
    for (const [split, parent] of Object.entries(SPLIT_FROM) as [RoleId, RoleId][]) {
      if (!present.has(split) && mine.has(parent)) mine.add(split);
    }
    const roleLabel = (role: RoleId) => (present.has(role) ? ROLES[role].name : ROLES[SPLIT_FROM[role] ?? role].name);
    const publicFirst = activeCards(g).some((c) => CARDS[c].publicClue);
    v.clues = CLUES.filter((c) => {
      if (c.breakthrough) return r.btHolders.get(c.breakthrough) === pid || (c.breakthrough === 1 && publicFirst);
      if (c.onlyPresent && !myRoles.includes(c.role)) return false;
      return mine.has(c.role);
    })
      .filter((c) => c.when === 'start' || (c.when === 'power' && powered))
      .filter((c) => !(c.untilPower && powered))
      .map((c) => {
        const holder = c.breakthrough ? r.btHolders.get(c.breakthrough) : null;
        const shared = !!c.breakthrough && holder !== pid;
        const moved = !!c.breakthrough && !shared && !mine.has(c.role);
        return {
          title: c.title,
          text: this.fillRoles(c.text),
          role: shared ? `${ROLES[c.role].name}・大家都聽到了` : moved ? `${roleLabel(c.role)}・由你保管` : roleLabel(c.role),
          when: c.when,
          item: c.item,
          need: c.need,
          breakthrough: c.breakthrough,
          shared,
        };
      });

    if (g.hint.shown && g.phase === 'planning' && this.holderOf(HINT_ROLE) === pid) v.hint = this.fillRoles(HINT_TEXT);

    const prefHolder = this.effectivePrefHolder();
    if (!finished && prefHolder) {
      const own = r.prefByItem && prefHolder === r.prefHolderId;
      if (prefHolder === pid) v.preferenceHint = own ? '你帶了油燈：黑暗中可以照亮面板一次，幫木匠灰掉兩個錯誤選項。' : '倉庫配給你一盞油燈：黑暗中可以照亮面板一次，幫木匠灰掉兩個錯誤選項。';
      else v.preferenceHint = own ? `帶油燈的 ${this.nick(prefHolder)} 可以照亮面板一次。` : `倉庫配給 ${this.nick(prefHolder)} 一盞油燈，可以照亮面板一次。`;
    }

    if (g.crisisAt !== null) {
      // 揭曉：風暴變大前，你們的方案原本顧好幾件
      const before = g.planAtCrisis ? evaluatePlan(seed, g.planAtCrisis, { crisis: false, powerOn: true, cards: [g.cards.a], tonight: g.tonight, used: null }).stars : 0;
      v.crisis = { at: r.startedAt + g.crisisAt, cause: g.crisisCause!, starsBefore: before };
    }

    if (g.repair) {
      const rep = g.repair;
      const engOp = this.operatorOf('eng');
      const holders = rep.slots.map((_, i) => this.effectiveSlotHolder(i));
      v.repair = {
        startedAt: r.startedAt + rep.startedAt,
        limitMs: rep.limitMs,
        assistAt: r.startedAt + rep.assistAt,
        assistLevel: rep.assistLevel,
        progress: rep.progress,
        done: rep.doneAt !== null,
        panel:
          engOp === pid && g.phase === 'blackout'
            ? {
                slots: rep.slots.map((s, i) => ({
                  index: i,
                  askNickname: this.nick(holders[i]),
                  options: s.options.map((o) => ({ id: o, desc: describeSymbol(parseSymbol(o)), grayed: rep.grayed[i].includes(o) })),
                  done: i < rep.progress,
                })),
              }
            : null,
        mySymbols:
          g.phase === 'blackout'
            ? rep.slots.flatMap((s, i) => (holders[i] === pid ? [{ slot: i, id: s.answer, desc: describeSymbol(parseSymbol(s.answer)), rot: r.slotRots?.[i] ?? 0 }] : []))
            : [],
        myEliminationClue: g.phase === 'blackout' ? r.clueHolders.get(pid) ?? null : null,
        engineerNickname: this.nick(engOp),
        order: holders.map((h, i) => ({ slot: i, nickname: this.nick(h) })),
        wrongFlash: rep.wrongPicks,
        lockedUntil: rep.lockedUntil > rep.startedAt ? r.startedAt + rep.lockedUntil : null,
      };
      v.can.repair = g.phase === 'blackout' && engOp === pid;
      v.can.eliminate = g.phase === 'blackout' && !rep.eliminateUsed && prefHolder === pid;
    }

    if (finished) v.result = this.resultView(pid);
    return v;
  }

  private resultView(pid: string): NonNullable<View['result']> {
    const r = this.round!;
    const g = r.game;
    const stars = g.result?.stars ?? 0;
    const served = (g.result?.served ?? []) as NeedId[];
    // DECISIONS 18：0–1 件或時間到還沒出發＝這局沒能平安上岸（遊戲結果）；經文裡 276 人都上了岸，saved 那行一定寫明
    const safe = isSafe(g) === true;
    const title = !safe ? '這一局，你們沒能平安上岸' : stars === 3 ? '全船平安上岸・一路準備周全' : '全船平安上岸・準備了大半';
    const saved = safe ? { text: '船上 276 人，全都得救上了岸', ref: '徒 27:37、44' } : { text: '經文裡，船上 276 人全都上了岸。再試一次？', ref: '徒 27:37、44' };
    const k = r.no - 1;
    return {
      stars,
      safe,
      title,
      saved,
      lit: { 力氣: served.includes('力氣'), 船身: served.includes('船身'), 天亮: served.includes('天亮') },
      cause: g.result?.cause ?? 'ended',
      moments: this.moments(),
      fireside: { verse: { ...FIRESIDE_VERSE }, lines: this.fireside() },
      bible: BIBLE_THROWS,
      tonightLine: this.tonightLine(),
      verse: g.used?.use === '吃飯' ? { ...ENDING_VERSES.fed } : { ...ENDING_VERSES.shore },
      fact: FACTS[k % FACTS.length],
      question: QUESTIONS[k % QUESTIONS.length],
      thanks: [...r.thanks.entries()].map(([from, to]) => ({ from: this.nick(from), to: this.nick(to) })),
      myThanks: r.thanks.get(pid) ?? null,
      score: this.scoreView(),
    };
  }

  private scoreView(): NonNullable<View['result']>['score'] {
    const r = this.round!;
    const sc = this.score();
    if (!sc) return null;
    const { raw, score } = sc;
    return {
      total: score.total,
      max: 1000,
      parts: [
        { id: 'mission', points: score.mission, max: 600, detail: raw.safe ? `顧好 ${raw.stars} 件` : '沒能平安上岸' },
        {
          id: 'teamwork',
          points: score.teamwork,
          max: 200,
          // 不寫協助等級數字，避免矛頭指向木匠一個人（公平性審查）
          detail: raw.repairMs === null ? '時間到還沒補好船' : `大家一起補船 ${Math.round(raw.repairMs / 1000)} 秒`,
        },
        { id: 'time', points: score.time, max: 100, detail: raw.safe ? `${Math.floor(raw.finishedAt / 60000)}:${String(Math.floor((raw.finishedAt % 60000) / 1000)).padStart(2, '0')} 上岸` : '沒能平安上岸' },
        { id: 'difficulty', points: score.difficulty, max: 100, detail: `三星解 ${raw.solutions} 種` + (raw.sweep ? '・風暴捲走' : '') },
      ],
      factor: score.factor,
      trial: true,
      formula: score.formula,
      practice: this.practice,
      submitted: r.submitted ? { ...r.submitted } : null,
    };
  }

  /** 結尾「今晚靠的是……」：只陳述這局的見聞，不指名誰沒說（docs/12 3.C 風險緩解）。 */
  private tonightLine(): string {
    const g = this.round!.game;
    const p = providers(g);
    const parts = [`力氣靠${p.力氣}`, CARDS[g.cards.a].done?.includes('船身') ? '船身早就捆好了' : `船身靠${p.船身}`, `錨住船靠錨`];
    const extra = g.tonight.水 === '淺' ? '水夠淺、拋得了錨' : '水太深，錨要留到快靠岸時再拋';
    return `今晚${parts.join('、')}；${extra}。力氣要吃了才有。`;
  }

  /**
   * 火堆旁（docs/17 v2）：只列 3–4 件剛才真的發生、有名字的事，讓大家自然聊「你剛才到底怎麼形容的？」。
   * 不虛構、不評分、不點名誰做錯；背包的外衣、一首歌在這裡出場。
   */
  fireside(): string[] {
    const r = this.round!;
    const g = r.game;
    const out: string[] = [];
    // 補得最快的一格：誰形容、誰幾秒選對
    const done = r.slotDone ?? [];
    if (done.length && g.repair) {
      let best: { slot: number; ms: number; holder: string | null; by: string } | null = null;
      done.forEach((d, i) => {
        const ms = d.at - (i === 0 ? g.repair!.startedAt : done[i - 1].at);
        if (!best || ms < best.ms) best = { slot: d.slot, ms, holder: d.holder, by: d.by };
      });
      const b = best!;
      const sec = Math.max(1, Math.round(b.ms / 1000));
      out.push(b.holder && b.holder !== b.by ? `第 ${b.slot + 1} 格：${this.nick(b.holder)} 形容，${this.nick(b.by)} ${sec} 秒就選對了。` : `第 ${b.slot + 1} 格：${this.nick(b.by)} ${sec} 秒就選對了。`);
    }
    if (g.used) {
      const doer = [...r.actors].reverse().find((a) => a.kind === 'use' && a.at === g.used!.at);
      const how = g.used.use === '吃飯' ? `召集大家吃了${g.used.item}` : g.used.use === '拋錨' ? '從船尾拋下了錨' : '捆綁了船底';
      out.push(`${this.nick(doer?.playerId)} ${how}。`);
    }
    const waits = r.voteLog.filter((x) => x.outcome === 'rejected').length;
    if (waits) out.push(`有人喊了 ${waits} 次「等一下」，大家停下來重新商量。`);
    for (const item of ['coat', 'song'] as const) {
      const p = this.players.find((x) => r.participants.includes(x.id) && x.pref === item);
      if (p) out.push(CAMEOS[item].replace('{name}', p.nickname));
    }
    return out.slice(0, 4);
  }

  /** 這局真的發生的事（系統紀錄＋故事卡＋背包物品出場），有名字。不虛構互助、不評誰最重要。 */
  moments(): MomentView[] {
    const r = this.round!;
    const g = r.game;
    const out: MomentView[] = [];
    out.push({ icon: { kind: 'card', ids: [g.cards.a] }, text: `起風時：${CARD_TEXT[g.cards.a].title}（${CARD_TEXT[g.cards.a].ref}）` });
    // 你們丟了什麼（玩家自己丟的；故事卡帶走的另外算）
    const finalPlan = g.plan.items;
    const cardGone = new Set<ItemId>();
    for (const l of g.log) if (l.kind === 'card') for (const i of l.data!.gone as ItemId[]) cardGone.add(i);
    const thrown = ITEMS.filter((i) => !finalPlan.includes(i) && !cardGone.has(i) && g.used?.item !== i && !g.swept.includes(i) && !(CARDS[g.cards.a].remove ?? []).includes(i));
    if (g.swept.length) out.push({ icon: { kind: 'item', ids: g.swept }, text: `風暴一來，漂在海上的${g.swept.join('、')}被浪捲走了。` });
    if (thrown.length) out.push({ icon: { kind: 'item', ids: thrown }, text: `你們把${thrown.join('、')}${g.swept.length ? '也' : ''}丟進了海裡。` });
    const restored = g.log.find((l) => l.kind === 'power_restored');
    if (restored) {
      const engPick = [...r.actors].reverse().find((a) => a.kind === 'repairPick');
      const eng = this.nick(engPick?.playerId ?? r.engineerId);
      const helpers = [...new Set(r.slotHolders)].map((p) => this.nick(p)).join('、');
      out.push({ icon: { kind: 'role', ids: ['eng'] }, text: `黑暗中，${eng} 靠 ${helpers} 的形容補好了船。` });
      out.push({ icon: { kind: 'card', ids: [g.cards.b] }, text: `風暴中：${CARD_TEXT[g.cards.b].title}（${CARD_TEXT[g.cards.b].ref}）` });
    }
    const elim = r.actors.find((a) => a.kind === 'useEliminate');
    if (elim) out.push({ icon: { kind: 'pref', ids: ['lamp'] }, text: `${this.nick(elim.playerId)} 用油燈照亮了面板。` });
    if (g.used) {
      const doer = [...r.actors].reverse().find((a) => a.kind === 'use' && a.at === g.used!.at);
      const scene = { 吃飯: 'meal', 拋錨: 'anchor', 捆船底: 'undergird' }[g.used.use];
      const how = g.used.use === '吃飯' ? `召集大家吃了${g.used.item}` : g.used.use === '拋錨' ? '從船尾拋下了錨' : `用${g.used.item === '纜索' ? '纜索' : g.used.item === '器具' ? '器具裡的繩具' : '小船上的拉繩'}捆綁了船底`;
      out.push({ icon: { kind: 'scene', ids: [scene] }, text: `出發前，${this.nick(doer?.playerId)} ${how}（${USE_TEXT[g.used.use].ref}）。` });
    }
    const served = (g.result?.served ?? []) as NeedId[];
    const why: Record<NeedId, string> = {
      力氣: '力氣沒顧到：大家沒吃東西，沒有力氣游。',
      船身: '船身沒顧到：船還沒靠近海灘就散開了。',
      天亮: '錨住船沒顧到：船在黑夜裡被風浪推著走。',
    };
    for (const n of NEEDS) if (!served.includes(n) && why[n]) out.push({ icon: { kind: 'need', ids: [n] }, text: why[n] });
    // 表決：只陳述次數與誰強制，不點名誰不同意
    const rejected = r.voteLog.filter((x) => x.outcome === 'rejected').length;
    if (rejected) out.push({ icon: { kind: 'role', ids: ['nav'] }, text: `有 ${rejected} 次有人喊「等一下」或「我有情報」，大家停下來重新商量。` });
    for (const f of r.voteLog.filter((x) => x.outcome === 'forced')) out.push({ icon: { kind: 'role', ids: ['nav'] }, text: `${this.nick(f.by)} 在 2 次沒通過後，強制「${Room.voteLabel(f.key)}」。` });
    // DECISIONS 18：遊戲可以失敗，但不畫、不寫有人死亡；經文的結局另外寫明
    if (isSafe(g)) out.push({ icon: { kind: 'scene', ids: ['landing'] }, text: '船擱淺了，大家有的游、有的抱著板子，都上了岸（27:41–44）。' });
    else out.push({ icon: { kind: 'scene', ids: ['landing'] }, text: g.result ? '天亮時，船卡在礁石之間撐不住——這一局沒能平安上岸。' : '時間到了，船還沒能出發——這一局沒能平安上岸。' });
    for (const item of ['coat', 'nuts', 'song'] as const) {
      const p = this.players.find((x) => r.participants.includes(x.id) && x.pref === item);
      if (p) out.push({ icon: { kind: 'pref', ids: [item] }, text: CAMEOS[item].replace('{name}', p.nickname) });
    }
    return out;
  }
}
