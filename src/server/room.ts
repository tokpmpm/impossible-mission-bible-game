// 房間層：玩家、職能分派、線索、修復分派、權限、重連、結尾回顧。伺服器權威；規則交給 src/engine。
import {
  apply,
  createGame,
  eliminationClueCount,
  evaluate,
  seedOf,
  symbolCount,
  TIME_UP_AT,
  type GameEvent,
  type GameState,
} from '../engine/game.ts';
import { REASON_TEXT, type Evaluation, type RejectReason } from '../engine/rules.ts';
import { SEEDS, VILLAGES, cargoItems, displayName, type RouteId, type SeedId } from '../engine/seeds.ts';
import { describeSymbol, makeEliminationClues, makeSlots, parseSymbol, rng } from '../engine/symbols.ts';
import {
  ASKS,
  CLUES,
  HINT_ROLE,
  PREFERENCES,
  QUERY_QUESTIONS,
  QUERY_REPLIES,
  ROLE_BUNDLES,
  ROLES,
  SPLIT_FROM,
  VERSES,
  type Preference,
  type RoleId,
} from './content.ts';
import type { Action, Rejection, View, ViewPhase } from './view.ts';

export const INTRO_MS = 60_000;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;

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
  slotHolders: string[]; // 第 i 格符號在誰手上
  clueHolders: Map<string, string>; // 排除線索
  prefHolderId: string | null;
  prefByCasual: boolean;
  actors: { kind: string; playerId: string; at: number }[];
  thanks: Map<string, string>;
  queryReply: string | null;
  /** 突破口第 n 段線索在誰手上（同一支手機不會拿到兩段，ADR-0003 第 26 條）。 */
  btHolders: Map<number, string>;
}

const EXTRA_REASON_TEXT: Record<string, string> = {
  GREEN_NOT_LOCKABLE: '故事安全窗不足：綠線山路 6 分鐘，洪水第 5 分鐘就到',
  WRONG_PHASE: '現在不能做這個動作',
  TOO_EARLY: '還在認識隊友的時間',
};

function reasonText(r: string, overweight = 0): string {
  if (r === 'OVERWEIGHT' && overweight > 0) return `超重 ${overweight} kg`;
  return REASON_TEXT[r as RejectReason] ?? EXTRA_REASON_TEXT[r] ?? r;
}

function randomId(len = 16): string {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
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
    const lastSeed = this.round?.seedId;
    const seedId: SeedId = lastSeed === 'seed 001' ? 'seed 002' : 'seed 001';
    this.startRound(participants, seedId);
  }

  next(byId: string): void {
    if (byId !== this.hostId) throw new Error('只有房主可以開下一局');
    // 結束的那局刪掉離開的人
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

  private startRound(participants: string[], seedId: SeedId): void {
    const n = participants.length;
    const order = this.shuffle(participants);
    const bundles = ROLE_BUNDLES[n];
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
    nonEng.slice(k).forEach((pid, i) => clueHolders.set(pid, clueTexts[i] ?? '正確的符號都在選項裡，仔細聽隊友描述。'));

    const casual = this.shuffle(nonEng.filter((pid) => this.get(pid)?.pref === 'casual'));
    const prefHolderId = casual[0] ?? nonEng[Math.floor(this.random() * nonEng.length)] ?? null;
    const channel = String(100 + Math.floor(this.random() * 900));
    const grayOrder = slots.map((s) => this.shuffle(s.options));

    const firstRound = this.roundsPlayed === 0;
    this.roundsPlayed++;
    const btHolders = this.assignBreakthrough(seedId, participants, roles);
    this.round = {
      no: this.roundsPlayed,
      seedId,
      startedAt: this.now(),
      firstRound,
      game: createGame({ seedId, playerCount: n, firstRound, slots, channel, grayOrder, lockOpensAt: this.introMs }),
      participants,
      roles,
      engineerId,
      slotHolders,
      clueHolders,
      prefHolderId,
      prefByCasual: casual.length > 0,
      actors: [],
      thanks: new Map(),
      queryReply: null,
      btHolders,
    };
    this.touch();
  }

  /** 職能持有者（含拆分職能回到原職能）。 */
  private static holderIn(participants: string[], roles: Map<string, RoleId[]>, role: RoleId): string | null {
    for (const pid of participants) if (roles.get(pid)!.includes(role)) return pid;
    const parent = SPLIT_FROM[role];
    return parent ? Room.holderIn(participants, roles, parent) : null;
  }

  /**
   * 突破口三段線索本來依職能分給三個人；人少時兩段可能落在同一支手機（例：3 人局通訊＋工程）。
   * 這時把後面那段轉給還沒拿到突破口線索的隊友，確保三段在三支手機上，一定要開口合作。
   */
  private assignBreakthrough(seedId: SeedId, participants: string[], roles: Map<string, RoleId[]>): Map<number, string> {
    const out = new Map<number, string>();
    const taken = new Set<string>();
    for (const c of CLUES[seedId].filter((x) => x.breakthrough).sort((a, b) => a.breakthrough! - b.breakthrough!)) {
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
    // 認識隊友時間結束（intro → planning）也要廣播，手機才會換畫面
    return [g.phase, this.elapsed() >= this.introMs, g.hint.shown, g.repair?.assistLevel, g.crisisAt, g.result?.stars].join('|');
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
      case 'selectRoute':
        return this.operatorOf('nav') === pid;
      case 'setItem':
        return this.operatorOf('supply') === pid;
      case 'lock':
      case 'depart':
        return true;
      case 'repairPick':
        return this.operatorOf('eng') === pid;
      case 'useEliminate':
        return this.effectivePrefHolder() === pid;
      case 'floodgate':
      case 'query':
        return this.operatorOf('comms') === pid;
    }
  }

  /**
   * 執行一個動作。重複送出（同一個 id）會被忽略並回傳 null；
   * 被規則擋下時回傳 Rejection（原因＋下一步），讓按的那支手機知道發生什麼事。
   */
  act(pid: string, actId: string, a: Action): Rejection | null {
    const p = this.get(pid);
    if (!p) throw new Error('找不到玩家');
    if (p.seenActs.includes(actId)) return null;
    p.seenActs.push(actId);
    if (p.seenActs.length > 300) p.seenActs.shift();
    const r = this.round;
    if (!r) throw new Error('還沒開始');
    if (!this.permitted(pid, a)) throw new Error('這個操作在別的隊友手機上，請找他幫忙');
    const at = this.elapsed();
    const event = { ...a, at } as GameEvent;
    const before = r.game;
    r.game = apply(r.game, event);
    if (a.type === 'query' && !before.query.used && r.game.query.used) {
      r.queryReply = QUERY_REPLIES[`${a.village}:${a.question}`] ?? null;
    }
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
    const r = this.round!;
    const g = r.game;
    const seed = seedOf(g);
    ev ??= evaluate(g);
    const route = g.plan.route;
    const routeName = (id: RouteId) => `${id}線`;
    switch (code) {
      case 'NO_ROUTE':
        return `還沒選路線：請${this.whoDoes('nav', pid)}選一條`;
      case 'OVERWEIGHT':
        return `超重 ${ev.overweight} kg，請${this.whoDoes('supply', pid)}放下一樣`;
      case 'ROAD_CLOSED': {
        const others = (['紅', '藍', '綠'] as RouteId[]).filter((id) => id !== route && seed.crisis.closed !== id).map(routeName);
        return `${route ? seed.routes[route].label : '這條路'}斷了，請${this.whoDoes('nav', pid)}改選${others.join('或')}`;
      }
      case 'TOO_LATE': {
        const travel = ev.travel ?? 0;
        const safe = ev.safeWindow ?? seed.flood;
        const head = `${route ? routeName(route) : '這條路'}要 ${travel} 分鐘，洪水 ${safe} 分鐘就到，來不及`;
        const b = seed.breakthrough;
        if (b.kind === 'floodgate' && route === b.route && !g.floodgate && g.crisisAt !== null) {
          return `${head}：找找有沒有辦法拖住洪水，或請${this.whoDoes('nav', pid)}換一條更快的路`;
        }
        return `${head}：請${this.whoDoes('nav', pid)}換一條更快的路`;
      }
      case 'GREEN_NOT_LOCKABLE': {
        const travel = seed.routes['綠'].travel;
        return `綠線要 ${travel} 分鐘，洪水 ${seed.flood} 分鐘就到，現在還來不及：請${this.whoDoes('nav', pid)}先選一條更快的路`;
      }
      case 'NO_NEEDS':
        return `車上沒有村子需要的東西：問問${this.whoDoes('comms', pid)}各村要什麼，再請${this.whoDoes('supply', pid)}裝上`;
      case 'NOT_POWERED':
        return `還在停電：先幫工程師 ${this.nick(this.operatorOf('eng'))} 修好電力`;
      case 'NOT_RELEASED': {
        const b = seed.breakthrough;
        const item = b.kind === 'query' ? displayName(seed, b.item) : '這樣物資';
        return `${item}還沒發放，現在還不能裝上車`;
      }
      case 'TOO_EARLY': {
        const sec = Math.max(1, Math.ceil((g.lockOpensAt - at) / 1000));
        return `先花 1 分鐘認識隊友、交換情報；再 ${sec} 秒就能鎖定。方案可以先排`;
      }
      default:
        return reasonText(code);
    }
  }

  /** 開局「下一步」：去找誰、問什麼。 */
  private nextSteps(pid: string): View['nextSteps'] {
    const r = this.round!;
    const out: View['nextSteps'] = [];
    const used = new Set<string>([pid]);
    for (const role of r.roles.get(pid) ?? []) {
      for (const ask of ASKS[role]) {
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
        .map((p) => ({
          id: p.id,
          nickname: p.nickname,
          connected: p.connected,
          isHost: p.id === this.hostId,
          roles: r && r.participants.includes(p.id) ? r.roles.get(p.id)!.map((x) => ROLES[x].name) : [],
        })),
      phase,
      round: null,
      plan: null,
      can: {
        start: this.hostId === pid && (!r || finished) && this.connectedPlayers().length >= MIN_PLAYERS,
        route: false,
        items: false,
        lock: false,
        depart: false,
        repair: false,
        eliminate: false,
        floodgate: false,
        query: false,
        next: false,
      },
      clues: [],
      hint: null,
      preferenceHint: null,
      crisis: null,
      repair: null,
      breakthrough: null,
      result: null,
      operators: null,
      nextSteps: [],
    };
    if (!r || !g || !participant) return v;

    const seed = seedOf(g);
    const ev = evaluate(g);
    const shownReasons = ev.reasons.filter((x) => !(g.phase === 'planning' && x === 'NOT_POWERED'));
    const editable = g.phase === 'planning' || g.phase === 'replanning';
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
    };
    const routeView = (id: RouteId) => ({
      id,
      label: seed.routes[id].label,
      travel: seed.routes[id].travel,
      tool: seed.routes[id].tool ? displayName(seed, seed.routes[id].tool!) : null,
      closed: g.crisisAt !== null && seed.crisis.closed === id,
    });
    const b = seed.breakthrough;
    v.plan = {
      route: g.plan.route ? routeView(g.plan.route) : null,
      routes: (['紅', '藍', '綠'] as RouteId[]).map(routeView),
      items: g.plan.items.map((i) => displayName(seed, i)),
      itemChoices: cargoItems(seed).map((i) => ({
        id: i,
        name: displayName(seed, i),
        on: g.plan.items.includes(i),
        locked: b.kind === 'query' && b.item === i && !g.released,
      })),
      weight: ev.weight,
      cap: ev.cap,
      overweight: ev.overweight,
      safeWindow: ev.safeWindow,
      reachable: ev.reachable,
      reasons: shownReasons.map((x) => reasonText(x, ev.overweight)),
      reasonCodes: shownReasons,
      advice: shownReasons.map((x) => this.advice(x, pid, elapsed, ev)),
      locked: g.locked,
      // at 換成伺服器時間（原本是局內毫秒，前端拿去和時鐘比，永遠過期）
      lastRejection: g.lastRejection
        ? {
            at: r.startedAt + g.lastRejection.at,
            action: g.lastRejection.action,
            reasons: g.lastRejection.reasons.map((x) => reasonText(x, ev.overweight)),
          }
        : null,
    };
    v.operators = {
      route: this.nick(this.operatorOf('nav')),
      items: this.nick(this.operatorOf('supply')),
      comms: this.nick(this.operatorOf('comms')),
      repair: this.nick(this.operatorOf('eng')),
    };
    v.nextSteps = this.nextSteps(pid);
    v.can.route = editable && this.operatorOf('nav') === pid;
    v.can.items = editable && this.operatorOf('supply') === pid;
    v.can.lock = g.phase === 'planning';
    v.can.depart = g.phase === 'replanning';
    v.can.next = finished && this.hostId === pid;

    // 線索：自己的職能，加上不在場的拆分職能
    const present = new Set(r.participants.flatMap((p) => r.roles.get(p)!));
    const mine = new Set<RoleId>(myRoles);
    for (const [split, parent] of Object.entries(SPLIT_FROM) as [RoleId, RoleId][]) {
      if (!present.has(split) && mine.has(parent)) mine.add(split);
    }
    const powered = g.phase === 'replanning' || g.phase === 'settled' || (g.phase === 'ended' && !!g.repair?.doneAt);
    // 拆分職能不在場（例如 6 人以下的倉儲管理）時，標籤顯示原職能，不出現玩家沒聽過的職能名稱
    const roleLabel = (role: RoleId) => (present.has(role) ? ROLES[role].name : ROLES[SPLIT_FROM[role] ?? role].name);
    v.clues = CLUES[r.seedId]
      .filter((c) => (c.breakthrough ? r.btHolders.get(c.breakthrough) === pid : mine.has(c.role)))
      .filter((c) => c.when === 'start' || (c.when === 'crisis' && g.crisisAt !== null) || (c.when === 'power' && powered))
      .map((c) => {
        const moved = !!c.breakthrough && !mine.has(c.role);
        return {
          title: c.title,
          text: c.text.replace('{channel}', g.channel),
          role: moved ? `${roleLabel(c.role)}・由你保管` : roleLabel(c.role),
          breakthrough: c.breakthrough,
        };
      });

    if (g.hint.shown && g.phase === 'planning' && this.holderOf(HINT_ROLE[r.seedId]) === pid) v.hint = seed.hintText;

    const prefHolder = this.effectivePrefHolder();
    if (!finished) {
      if (prefHolder === pid) v.preferenceHint = '你持有一次「排除兩個錯誤符號」的能力。停電時可以用來幫工程師。';
      else if (r.prefByCasual && prefHolder === r.prefHolderId) v.preferenceHint = '找出隊上的「隨性派」：其中一位持有一次「排除兩個錯誤符號」的能力。';
      else if (prefHolder) v.preferenceHint = `${this.nick(prefHolder)} 持有一次「排除兩個錯誤符號」的能力。`;
    }

    if (g.crisisAt !== null) {
      let extra: string | null = null;
      if (seed.crisis.closed && g.planAtCrisis?.route !== seed.crisis.closed) extra = '吊橋斷了，原本唯一能三村全送的路沒了。';
      if (g.crisisCause === 'timeout') extra = (extra ? extra + ' ' : '') + '時間到了，危機照常發生——別擔心，還有機會。';
      v.crisis = { title: seed.crisis.title, text: seed.crisis.text, at: r.startedAt + g.crisisAt, cause: g.crisisCause!, extra };
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

    if (powered) {
      const done = b.kind === 'floodgate' ? g.floodgate : g.released;
      v.breakthrough = {
        kind: b.kind,
        done,
        queryUsed: g.query.used,
        queryReply: r.queryReply,
        floodgateWrongCount: g.log.filter((l) => l.kind === 'floodgate_wrong').length,
        questions: (Object.keys(QUERY_QUESTIONS) as (keyof typeof QUERY_QUESTIONS)[]).map((id) => ({ id, text: QUERY_QUESTIONS[id] })),
      };
      const commsOp = this.operatorOf('comms') === pid;
      v.can.floodgate = g.phase === 'replanning' && b.kind === 'floodgate' && !g.floodgate && commsOp;
      v.can.query = g.phase === 'replanning' && b.kind === 'query' && !g.query.used && commsOp;
    }

    if (finished) v.result = this.resultView(pid);
    return v;
  }

  private resultView(pid: string): NonNullable<View['result']> {
    const r = this.round!;
    const g = r.game;
    const seed = seedOf(g);
    const stars = g.result?.stars ?? 0;
    const served = g.result?.served ?? [];
    const titles = { 3: '三村都送到了！', 2: '任務成功', 1: '送出了一部分救援', 0: '這次沒來得及出發' } as const;
    const nextSeed: SeedId = r.seedId === 'seed 001' ? 'seed 002' : 'seed 001';
    const questions = ['剛剛你發現哪位隊友原來很擅長什麼？', '剛才哪一刻你最需要別人的幫忙？'];
    return {
      stars,
      title: titles[stars],
      served: [...served],
      unserved: VILLAGES.filter((v) => !served.includes(v)),
      cause: g.result?.cause ?? 'ended',
      recap: this.recap(),
      question: questions[(r.no - 1) % questions.length],
      thanks: [...r.thanks.entries()].map(([from, to]) => ({ from: this.nick(from), to: this.nick(to) })),
      myThanks: r.thanks.get(pid) ?? null,
      nextSeedTitle: SEEDS[nextSeed].title,
    };
  }

  /** 只陳述系統記錄到的事，配上經節位置（docs/05）。最多兩條。 */
  recap(): { verse: string; ref: string; event: string }[] {
    const r = this.round!;
    const g = r.game;
    const out: { verse: string; ref: string; event: string }[] = [];
    const chain = r.seedId === 'seed 001' ? ['觀測員', '通訊員', '工程師'] : ['醫護員', '補給員', '通訊員'];
    const breakthroughDone = r.seedId === 'seed 001' ? g.floodgate : g.released;
    if (breakthroughDone) {
      out.push({ ref: '林前 12:14', verse: VERSES[14], event: `這局的突破口從${chain[0]}開始，經過${chain[1]}與${chain[2]}才完成。` });
    }
    const restored = g.log.find((l) => l.kind === 'power_restored');
    if (restored) {
      const engPick = [...r.actors].reverse().find((a) => a.kind === 'repairPick');
      const eng = this.nick(engPick?.playerId ?? r.engineerId);
      out.push({ ref: '林前 12:21', verse: VERSES[21], event: `停電時，工程師 ${eng} 看不到符號，靠 ${g.repair!.slots.length} 位隊友的描述修好了電力。` });
    }
    const elim = r.actors.find((a) => a.kind === 'useEliminate');
    if (out.length < 2 && elim) {
      out.push({ ref: '林前 12:25', verse: VERSES[25], event: `${this.nick(elim.playerId)} 把自己的排除能力用來幫工程師。` });
    }
    if (out.length < 2) {
      out.push({ ref: '林前 12:27', verse: VERSES[27], event: `這局的突破口線索從${chain[0]}開始；每個人手上都有別人需要的一塊。` });
    }
    return out.slice(0, 2);
  }
}
