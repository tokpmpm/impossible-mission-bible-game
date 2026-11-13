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
import { REASON_TEXT, type RejectReason } from '../engine/rules.ts';
import { SEEDS, VILLAGES, cargoItems, displayName, type RouteId, type SeedId } from '../engine/seeds.ts';
import { describeSymbol, makeEliminationClues, makeSlots, parseSymbol, rng } from '../engine/symbols.ts';
import {
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
import type { Action, View, ViewPhase } from './view.ts';

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
}

const EXTRA_REASON_TEXT: Record<string, string> = {
  GREEN_NOT_LOCKABLE: '故事安全窗不足：綠線山路 6 分鐘，洪水第 5 分鐘就到',
  WRONG_PHASE: '現在不能做這個動作',
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
  private now: () => number;
  private random: () => number;

  constructor(code: string, opts: { now?: () => number; seed?: number } = {}) {
    this.code = code;
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
    this.round = {
      no: this.roundsPlayed,
      seedId,
      startedAt: this.now(),
      firstRound,
      game: createGame({ seedId, playerCount: n, firstRound, slots, channel, grayOrder }),
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
    };
    this.touch();
  }

  // ---------- 操作 ----------

  elapsed(): number {
    return this.round ? this.now() - this.round.startedAt : 0;
  }

  /** 定時呼叫；回傳狀態是否有需要廣播的變化。 */
  tick(): boolean {
    const r = this.round;
    if (!r || r.game.phase === 'settled' || r.game.phase === 'ended') return false;
    const before = this.signature();
    r.game = apply(r.game, { type: 'tick', at: this.elapsed() });
    return this.signature() !== before;
  }

  private signature(): string {
    const g = this.round?.game;
    if (!g) return '';
    return [g.phase, g.hint.shown, g.repair?.assistLevel, g.crisisAt, g.result?.stars].join('|');
  }

  private online(pid: string): boolean {
    const p = this.get(pid);
    return !!p && p.connected && !p.left;
  }

  private holderOf(role: RoleId): string | null {
    const r = this.round!;
    for (const pid of r.participants) if (r.roles.get(pid)!.includes(role)) return pid;
    const parent = SPLIT_FROM[role];
    return parent ? this.holderOf(parent) : null;
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

  /** 回傳 true 表示是新動作（已執行或被規則拒絕），false 表示重複送出被忽略。 */
  act(pid: string, actId: string, a: Action): boolean {
    const p = this.get(pid);
    if (!p) throw new Error('找不到玩家');
    if (p.seenActs.includes(actId)) return false;
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
    return true;
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
      phase = g.phase === 'planning' && elapsed < INTRO_MS ? 'intro' : g.phase;
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
    };
    if (!r || !g || !participant) return v;

    const seed = seedOf(g);
    const ev = evaluate(g);
    const editable = g.phase === 'planning' || g.phase === 'replanning';
    v.round = {
      no: r.no,
      seedId: r.seedId,
      seedTitle: seed.title,
      firstRound: r.firstRound,
      startedAt: r.startedAt,
      elapsedMs: elapsed,
      timeLimitMs: TIME_UP_AT,
      introMs: INTRO_MS,
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
      reasons: ev.reasons.filter((x) => !(g.phase === 'planning' && x === 'NOT_POWERED')).map((x) => reasonText(x, ev.overweight)),
      locked: g.locked,
      lastRejection: g.lastRejection ? { at: g.lastRejection.at, reasons: g.lastRejection.reasons.map((x) => reasonText(x, ev.overweight)) } : null,
    };
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
    v.clues = CLUES[r.seedId]
      .filter((c) => mine.has(c.role))
      .filter((c) => c.when === 'start' || (c.when === 'crisis' && g.crisisAt !== null) || (c.when === 'power' && powered))
      .map((c) => ({ title: c.title, text: c.text.replace('{channel}', g.channel), role: ROLES[c.role].name, breakthrough: c.breakthrough }));

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
