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
  UNDO_USE_MS,
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
  HINT_ROLE,
  HINT_TEXT,
  OBSERVER_ASKS_WITH_SCOUT,
  PREFERENCES,
  QUESTIONS,
  ROLE_BUNDLES,
  ROLES,
  SPLIT_FROM,
  STORY,
  TONIGHT_ROLE,
  TONIGHT_TEXT,
  USE_TEXT,
  type Preference,
  type RoleId,
} from './content.ts';
import type { Action, CardView, MomentView, Rejection, View, ViewPhase } from './view.ts';

export const INTRO_MS = 60_000;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const SEED_ID: SeedId = 'ship 001';

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
}

const EXTRA_REASON_TEXT: Record<string, string> = {
  WRONG_PHASE: '現在不能做這個動作',
  TOO_EARLY: '還在認識隊友的時間',
  PINNED: '船主不准丟',
  SWEPT: '已經被浪捲走了',
  NO_ITEM: '那樣東西不在船上',
  CANNOT_TONIGHT: '今晚做不到',
  ALREADY_USED: '天亮前只來得及做一件',
  UNDO_EXPIRED: '已經來不及取消了',
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
  /** 開局認識隊友的時間；這段時間可以排方案但不能鎖定。 */
  introMs: number;
  private lastSig = '';
  private now: () => number;
  private random: () => number;

  /** 捲走前提醒幾毫秒（正式遊戲 10 秒；只給自動測試縮短）。 */
  sweepWarningMs: number | undefined;
  /** 練習房（單機試玩 solo.html 開的）：分數照算照顯示，但不能登記排行榜。 */
  practice: boolean;

  constructor(code: string, opts: { now?: () => number; seed?: number; introMs?: number; sweepWarningMs?: number; practice?: boolean } = {}) {
    this.code = code;
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
    this.touch();
    return p;
  }

  disconnect(id: string): void {
    const p = this.get(id);
    if (!p) return;
    p.connected = false;
    this.transferHostIfNeeded();
  }

  leave(id: string): void {
    const p = this.get(id);
    if (!p) return;
    p.connected = false;
    p.left = true;
    if (!this.round) this.players = this.players.filter((x) => x.id !== id);
    this.transferHostIfNeeded();
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
    this.roundsPlayed++;
    const btHolders = this.assignBreakthrough(participants, roles);
    const tonightHolders = new Map<DialId, string>();
    for (const d of DIALS) {
      if (CARDS[cards.a].fix?.[d] !== undefined) continue; // A4：船底已捆好，不發「繩」
      const h = Room.holderIn(participants, roles, TONIGHT_ROLE[d]);
      if (h) tonightHolders.set(d, h);
    }
    this.round = {
      id: `${this.code}-${this.roundsPlayed}-${randomId(8)}`,
      no: this.roundsPlayed,
      seedId: SEED_ID,
      startedAt: this.now(),
      firstRound,
      game: createGame({ seedId: SEED_ID, playerCount: n, firstRound, slots, cards, tonight, sweep: !firstRound, sweepWarningMs: this.sweepWarningMs, grayOrder, lockOpensAt: this.introMs }),
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
    };
    this.touch();
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
    return this.round ? this.now() - this.round.startedAt : 0;
  }

  /** 定時呼叫；回傳狀態是否有需要廣播的變化。 */
  tick(): boolean {
    const r = this.round;
    if (!r || r.game.phase === 'settled' || r.game.phase === 'ended') return false;
    r.game = apply(r.game, { type: 'tick', at: this.elapsed() });
    const sig = this.signature();
    if (sig === this.lastSig) return false;
    this.lastSig = sig;
    return true;
  }

  private signature(): string {
    const g = this.round?.game;
    if (!g) return '';
    const open = dawnOpensAt(g);
    const undoOpen = !!g.used && g.now - g.used.at <= UNDO_USE_MS;
    return [g.phase, this.elapsed() >= this.introMs, g.hint.shown, g.warned, g.repair?.assistLevel, g.crisisAt, g.result?.stars, open !== null && g.now >= open, undoOpen].join('|');
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
      case 'undoUse': {
        // 只有按下去的那個人可以取消
        const last = [...r.actors].reverse().find((x) => x.kind === 'use');
        return !!last && last.playerId === pid;
      }
    }
  }

  /**
   * 執行一個動作。重複送出（同一個 id）會被忽略並回傳 null；
   * 被規則擋下時回傳 Rejection（原因＋下一步）。
   */
  act(pid: string, actId: string, a: Action): Rejection | null {
    const p = this.get(pid);
    if (!p) throw new Error('找不到玩家');
    if (p.seenActs.includes(actId)) return null;
    p.seenActs.push(actId);
    if (p.seenActs.length > 300) p.seenActs.shift();
    const r = this.round;
    if (!r) throw new Error('還沒開始');
    if (!this.permitted(pid, a)) throw new Error('這不是你負責的操作');
    const at = this.elapsed();
    const event = { ...a, at } as GameEvent;
    const before = r.game;
    r.game = apply(r.game, event);
    r.actors.push({ kind: a.type, playerId: pid, at });
    this.touch();
    if (r.game.rejections > before.rejections && r.game.lastRejection) {
      return { action: a.type, reasons: r.game.lastRejection.reasons.map((code) => ({ code, text: this.advice(code, pid, at) })) };
    }
    return null;
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
        return `拋了錨，還在等天亮：再 ${Math.max(1, Math.ceil((open - at) / 1000))} 秒`;
      }
      case 'TOO_EARLY': {
        const sec = Math.max(1, Math.ceil((g.lockOpensAt - at) / 1000));
        return `先花 1 分鐘認識隊友、交換情報；再 ${sec} 秒就能決定。東西可以先丟`;
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
        return u ? `天亮前只來得及做一件：${USE_TEXT[u.use].done}` : '天亮前只來得及做一件';
      }
      case 'UNDO_EXPIRED':
        return '已經超過 3 秒，來不及取消了';
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
        out.push({ verb: ask.verb, nickname: this.nick(to), text: ask.text });
        break;
      }
    }
    return out.slice(0, 2);
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

  /** 線索裡的 {食}{繩}{水}{胃} 換成這局拿那張見聞的人的職能（例：{繩} → 水手長；9 人以下 → 管倉）。 */
  private fillRoles(text: string): string {
    const r = this.round!;
    return text.replace(/\{(食|繩|水|胃)\}/g, (_m, d: DialId) => {
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
      if (this.operatorOf('nav') === pid) return r.game.locked ? '你決定好了：風暴馬上就來。' : '大家講好了，就由你按「決定好了」。';
      if (this.nextSteps(pid).length) return null; // 「下一步」已經說了要找誰
      return `把你知道的告訴 ${this.nick(this.operatorOf('supply'))}（管倉），他負責丟東西。`;
    }
    if (phase === 'replanning') {
      if (this.operatorOf('supply') === pid) return '浪更大了，船只能留 5：再決定一次留什麼。';
      if (this.operatorOf('nav') === pid) return '大家都準備好了，就由你按「衝向海灘」。';
      const mineUses = usesTonight(r.game).filter((u) => this.operatorOf(USE_TEXT[u].role) === pid);
      if (mineUses.length && !r.game.used) return `天亮前全隊只來得及做一件事：要不要由你${USE_TEXT[mineUses[0]].label}，先和大家商量。`;
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
      phase = g.phase === 'planning' && elapsed < this.introMs ? 'intro' : g.phase;
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
        undo: false,
      },
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
      introMs: this.introMs,
      lockOpensAt: r.startedAt + g.lockOpensAt,
      crisisAt: r.startedAt + crisisAtFor(g.cards),
    };
    const storyKey = phase === 'intro' ? 'intro' : phase === 'planning' ? 'planning' : phase === 'blackout' ? 'blackout' : phase === 'replanning' ? 'replanning' : 'landing';
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
      sweepWarning: warn ? { stormAt: r.startedAt + g.stormAt, floating: warn.floating } : null,
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
        ? { id: g.used.use, item: g.used.item, at: r.startedAt + g.used.at, by: this.nick(useActor?.playerId), mine: useActor?.playerId === pid, undoUntil: r.startedAt + g.used.at + UNDO_USE_MS }
        : null,
      dawnAt: dawn !== null ? r.startedAt + dawn : null,
      lastRejection: g.lastRejection
        ? { at: r.startedAt + g.lastRejection.at, action: g.lastRejection.action, reasons: g.lastRejection.reasons.map((x) => reasonText(x, ev.overweight)) }
        : null,
    };
    v.myTask = this.myTask(pid, phase);
    v.nextSteps = this.nextSteps(pid);
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
    v.can.undo = g.phase === 'replanning' && !!g.used && useActor?.playerId === pid && g.now - g.used.at <= UNDO_USE_MS;
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
        mySymbols: g.phase === 'blackout' ? rep.slots.flatMap((s, i) => (holders[i] === pid ? [{ slot: i, id: s.answer, desc: describeSymbol(parseSymbol(s.answer)) }] : [])) : [],
        myEliminationClue: g.phase === 'blackout' ? r.clueHolders.get(pid) ?? null : null,
        engineerNickname: this.nick(engOp),
        order: holders.map((h, i) => ({ slot: i, nickname: this.nick(h) })),
        wrongFlash: rep.wrongPicks,
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
    const titles = { 3: '上岸很順利！', 2: '平安上岸', 1: '上岸了，有點狼狽', 0: '大家還是都上了岸' } as const;
    const k = r.no - 1;
    return {
      stars,
      title: titles[stars],
      lit: { 力氣: served.includes('力氣'), 船身: served.includes('船身'), 天亮: served.includes('天亮') },
      cause: g.result?.cause ?? 'ended',
      moments: this.moments(),
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
        { id: 'mission', points: score.mission, max: 600, detail: `顧好 ${raw.stars} 件` },
        {
          id: 'teamwork',
          points: score.teamwork,
          max: 200,
          // 不寫協助等級數字，避免矛頭指向木匠一個人（公平性審查）
          detail: raw.repairMs === null ? '天亮前沒補好船' : `大家一起補船 ${Math.round(raw.repairMs / 1000)} 秒`,
        },
        { id: 'time', points: score.time, max: 100, detail: `${Math.floor(raw.finishedAt / 60000)}:${String(Math.floor((raw.finishedAt % 60000) / 1000)).padStart(2, '0')} 上岸` },
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
    const parts = [`力氣靠${p.力氣}`, CARDS[g.cards.a].done?.includes('船身') ? '船身早就捆好了' : `船身靠${p.船身}`, `等天亮靠錨`];
    const extra = [g.tonight.水 === '淺' ? '水夠淺、拋得了錨' : '水太深、錨拋不下去', g.tonight.胃 === '吃得下' ? '大家吃得下' : '大家暈船、吃不下'];
    return `今晚${parts.join('、')}；${extra.join('，')}。`;
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
      out.push({ icon: { kind: 'scene', ids: [scene] }, text: `天亮前，${this.nick(doer?.playerId)} ${how}（${USE_TEXT[g.used.use].ref}）。` });
    }
    const served = (g.result?.served ?? []) as NeedId[];
    const why: Record<NeedId, string> = {
      力氣: '力氣沒顧到：上岸時大家游得很吃力。',
      船身: '船身沒顧到：船尾被浪打得更碎。',
      天亮: '等天亮沒顧到：夜裡差點撞上礁石。',
    };
    for (const n of NEEDS) if (!served.includes(n) && why[n]) out.push({ icon: { kind: 'need', ids: [n] }, text: why[n] });
    out.push({ icon: { kind: 'scene', ids: ['landing'] }, text: '船擱淺了，大家有的游、有的抱著板子，都上了岸（27:41–44）。' });
    for (const item of ['coat', 'nuts', 'song'] as const) {
      const p = this.players.find((x) => r.participants.includes(x.id) && x.pref === item);
      if (p) out.push({ icon: { kind: 'pref', ids: [item] }, text: CAMEOS[item].replace('{name}', p.nickname) });
    }
    return out;
  }
}
