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
  seedOf,
  symbolCount,
  TIME_UP_AT,
  type GameEvent,
  type GameState,
} from '../engine/game.ts';
import { REASON_TEXT, evaluatePlan, type Evaluation, type RejectReason } from '../engine/rules.ts';
import { CARDS, DECK_A, DECK_B, ITEMS, NEEDS, type CardId, type ItemId, type NeedId, type SeedId } from '../engine/seeds.ts';
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
}

const EXTRA_REASON_TEXT: Record<string, string> = {
  WRONG_PHASE: '現在不能做這個動作',
  TOO_EARLY: '還在認識隊友的時間',
  PINNED: '船主不准丟',
  NO_FOOD: '糧食不在船上',
  ALREADY_FED: '已經吃過了',
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

function cardView(id: CardId): CardView {
  return { id, deck: CARDS[id].deck, ...CARD_TEXT[id] };
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

  constructor(code: string, opts: { now?: () => number; seed?: number; introMs?: number } = {}) {
    this.code = code;
    this.introMs = opts.introMs ?? INTRO_MS;
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
    if (!this.hostId || !this.get(this.hostId)?.connected) this.hostId = player.id;
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
    if (!this.hostId || !this.get(this.hostId)?.connected) this.hostId = p.id;
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
    const next = this.players.find((p) => p.connected && !p.left);
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

  /** 抽故事卡：同一個房間盡量不重複最近抽過的。 */
  private usedCards: CardId[] = [];
  /** 測試用：指定下一局的故事卡。 */
  forceCards: { a: CardId; b: CardId } | null = null;
  private drawCards(): { a: CardId; b: CardId } {
    if (this.forceCards) {
      const c = this.forceCards;
      this.forceCards = null;
      this.usedCards.push(c.a, c.b);
      return c;
    }
    const pick = (deck: CardId[]) => {
      const fresh = deck.filter((c) => !this.usedCards.includes(c));
      const pool = fresh.length ? fresh : deck;
      return pool[Math.floor(this.random() * pool.length)];
    };
    const a = pick(DECK_A);
    const b = pick(DECK_B);
    this.usedCards.push(a, b);
    // 一疊 5 張：抽滿一輪就重新開始，但不立刻重複上一局
    if (this.usedCards.length >= 8) this.usedCards = [a, b];
    return { a, b };
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
    const cards = this.drawCards();

    const firstRound = this.roundsPlayed === 0;
    this.roundsPlayed++;
    const btHolders = this.assignBreakthrough(participants, roles);
    this.round = {
      no: this.roundsPlayed,
      seedId: SEED_ID,
      startedAt: this.now(),
      firstRound,
      game: createGame({ seedId: SEED_ID, playerCount: n, firstRound, slots, cards, grayOrder, lockOpensAt: this.introMs }),
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
    return [g.phase, this.elapsed() >= this.introMs, g.hint.shown, g.repair?.assistLevel, g.crisisAt, g.result?.stars, open !== null && g.now >= open].join('|');
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
      case 'eat':
        return this.operatorOf('comms') === pid;
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
      case 'NO_FOOD':
        return `糧食已經丟進海裡了：請${this.whoDoes('supply', pid)}先撈回來`;
      case 'ALREADY_FED':
        return '大家已經吃過了';
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

  // ---------- 畫面資料 ----------

  private nick(pid: string | null | undefined): string {
    return (pid && this.get(pid)?.nickname) || '隊友';
  }

  /** 我這局的任務：沒有按鈕的人也知道自己在做什麼。 */
  private myTask(pid: string, phase: ViewPhase): string | null {
    const r = this.round!;
    const mine = r.roles.get(pid) ?? [];
    if (phase === 'intro' || phase === 'planning') {
      if (this.operatorOf('supply') === pid) return '你決定丟什麼：按一下東西＝丟進海裡，再按一下撈回來。';
      if (this.operatorOf('nav') === pid) return '大家講好了，就由你按「決定好了」。';
      return `把你知道的告訴 ${this.nick(this.operatorOf('supply'))}（管倉），他負責丟東西。`;
    }
    if (phase === 'replanning') {
      if (this.operatorOf('supply') === pid) return '浪更大了，船只能留 4：再決定一次丟什麼。';
      if (this.operatorOf('nav') === pid) return '大家都準備好了，就由你按「衝向海灘」。';
      if (this.operatorOf('comms') === pid) return '你管全船的飯。';
      if (mine.length) return `新線索來了：說給 ${this.nick(this.operatorOf('supply'))}（管倉）聽。`;
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
        eat: false,
        next: false,
      },
      eatNeedsFood: false,
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
    v.cards = { a: cardView(g.cards.a), b: powered ? cardView(g.cards.b) : null };

    // 船：6 樣東西的狀態
    const { aboard, pinned, weights } = aboardOf(g);
    const shownReasons = ev.reasons.filter((x) => !(g.phase === 'planning' && x === 'NOT_POWERED'));
    const showNeeds = g.crisisAt !== null;
    const fedEntry = g.log.find((l) => l.kind === 'eat');
    const fedActor = [...r.actors].reverse().find((a) => a.kind === 'eat' && fedEntry && a.at === fedEntry.at);
    const dawn = dawnOpensAt(g);
    v.ship = {
      items: ITEMS.map((id) => ({ id, weight: weights[id], onShip: g.plan.items.includes(id), gone: !aboard.includes(id), pinned: pinned.includes(id) })),
      weight: ev.weight,
      cap: ev.cap,
      overweight: ev.overweight,
      needs: showNeeds ? NEEDS.map((id) => ({ id, lit: ev.served.includes(id) })) : null,
      stars: showNeeds ? ev.stars : null,
      reasons: shownReasons.map((x) => reasonText(x, ev.overweight)),
      reasonCodes: shownReasons,
      advice: shownReasons.map((x) => this.advice(x, pid, elapsed, ev)),
      locked: g.locked,
      fed: g.fed,
      fedAt: fedEntry ? r.startedAt + fedEntry.at : null,
      fedBy: fedActor ? this.nick(fedActor.playerId) : null,
      dawnAt: dawn !== null ? r.startedAt + dawn : null,
      lastRejection: g.lastRejection
        ? { at: r.startedAt + g.lastRejection.at, action: g.lastRejection.action, reasons: g.lastRejection.reasons.map((x) => reasonText(x, ev.overweight)) }
        : null,
    };
    v.myTask = this.myTask(pid, phase);
    v.nextSteps = this.nextSteps(pid);
    v.can.items = editable && this.operatorOf('supply') === pid;
    v.can.lock = g.phase === 'planning' && this.operatorOf('nav') === pid;
    v.can.depart = g.phase === 'replanning' && this.operatorOf('nav') === pid;
    v.can.eat = g.phase === 'replanning' && !g.fed && this.operatorOf('comms') === pid;
    v.eatNeedsFood = v.can.eat && !g.plan.items.includes(seed.food);
    v.can.next = finished && this.hostId === pid;

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
          text: c.text,
          role: shared ? `${ROLES[c.role].name}・大家都聽到了` : moved ? `${roleLabel(c.role)}・由你保管` : roleLabel(c.role),
          when: c.when,
          item: c.item,
          need: c.need,
          breakthrough: c.breakthrough,
          shared,
        };
      });

    if (g.hint.shown && g.phase === 'planning' && this.holderOf(HINT_ROLE) === pid) v.hint = HINT_TEXT;

    const prefHolder = this.effectivePrefHolder();
    if (!finished && prefHolder) {
      const own = r.prefByItem && prefHolder === r.prefHolderId;
      if (prefHolder === pid) v.preferenceHint = own ? '你帶了油燈：黑暗中可以照亮面板一次，幫木匠灰掉兩個錯誤選項。' : '倉庫配給你一盞油燈：黑暗中可以照亮面板一次，幫木匠灰掉兩個錯誤選項。';
      else v.preferenceHint = own ? `帶油燈的 ${this.nick(prefHolder)} 可以照亮面板一次。` : `倉庫配給 ${this.nick(prefHolder)} 一盞油燈，可以照亮面板一次。`;
    }

    if (g.crisisAt !== null) {
      // 揭曉：風暴變大前，你們的方案原本顧好幾件
      const before = g.planAtCrisis ? evaluatePlan(seed, g.planAtCrisis, { crisis: false, powerOn: true, fed: false, cards: [g.cards.a] }).stars : 0;
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
      verse: g.fed ? { ...ENDING_VERSES.fed } : { ...ENDING_VERSES.shore },
      fact: FACTS[k % FACTS.length],
      question: QUESTIONS[k % QUESTIONS.length],
      thanks: [...r.thanks.entries()].map(([from, to]) => ({ from: this.nick(from), to: this.nick(to) })),
      myThanks: r.thanks.get(pid) ?? null,
    };
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
    const thrown = ITEMS.filter((i) => !finalPlan.includes(i) && !cardGone.has(i) && !(g.fed && i === seedOf(g).food) && !(CARDS[g.cards.a].remove ?? []).includes(i));
    if (thrown.length) out.push({ icon: { kind: 'item', ids: thrown }, text: `你們把${thrown.join('、')}丟進了海裡。` });
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
    if (g.fed) {
      const eater = r.actors.find((a) => a.kind === 'eat' && g.log.some((l) => l.kind === 'eat' && l.at === a.at));
      const names = [1, 2].map((i) => this.nick(r.btHolders.get(i)));
      out.push({ icon: { kind: 'scene', ids: ['meal'] }, text: `${names[0]} 說吃了才有力氣、${names[1]} 想到吃了船就輕，${this.nick(eater?.playerId)} 召集大家吃飯。` });
    }
    out.push({ icon: { kind: 'scene', ids: ['landing'] }, text: '船擱淺了，大家有的游、有的抱著板子，都上了岸（27:41–44）。' });
    for (const item of ['coat', 'nuts', 'song'] as const) {
      const p = this.players.find((x) => r.participants.includes(x.id) && x.pref === item);
      if (p) out.push({ icon: { kind: 'pref', ids: [item] }, text: CAMEOS[item].replace('{name}', p.nickname) });
    }
    return out;
  }
}
