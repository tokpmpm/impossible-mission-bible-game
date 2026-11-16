// 一局的規則狀態機（ADR-0001、0002、0003、0006、0007）。
// 純函式：apply(狀態, 事件) → 新狀態。不讀時鐘、不認識玩家；時間由事件的 at（房間倒數已過毫秒）帶入。
// 2026-11-16：見聞（今晚靠哪一樣）、風暴捲走（第二局起）、三種用掉只來得及一件（docs/12 第 3 節）。
import { effective, evaluatePlan, storyOk, usesAvailable, type Evaluation, type Plan, type RejectReason, type World } from './rules.ts';
import { CARDS, CLASSIC, ITEMS, SEEDS, USES, providerOf, type CardId, type ItemId, type SeedDef, type SeedId, type Tonight, type UseId } from './seeds.ts';

export const HINT_AT = 135_000; // 2:15
export const CRISIS_AT = 165_000; // 2:45
export const TIME_UP_AT = 480_000; // 8:00
export const FIRST_ROUND_EXTRA = 15_000;
export const SECOND_ASSIST_AFTER = 15_000; // 逾時再 15 秒，只留正確＋1 個錯誤選項
export const LOCK_OPENS_AT = 60_000; // 前 60 秒可以丟東西但不能「決定好了」，先認識隊友
export const SWEEP_WARNING_MS = 10_000; // 風暴捲走前 10 秒提醒（DECISIONS 16）
export const UNDO_USE_MS = 3_000; // 用掉後 3 秒內本人可以取消（docs/12 3.C）

export type Phase = 'planning' | 'blackout' | 'replanning' | 'settled' | 'ended';

export interface RepairSlotInput {
  options: string[]; // 9 個選項代號
  answer: string; // 正確選項代號（必須在 options 裡）
}

export interface GameConfig {
  seedId: SeedId;
  playerCount: number; // 3–10
  firstRound: boolean;
  slots: RepairSlotInput[]; // 長度須等於 symbolCount(playerCount)
  /** 這局的故事卡：起風（A）與風暴（B）各一張。 */
  cards: { a: CardId; b: CardId };
  /** 這局的見聞；不給＝經典配置。 */
  tonight?: Tonight;
  /** 風暴捲走：危機前丟下海的東西，危機一來就撈不回來。不給＝第二局起啟用（首局不啟用）。 */
  sweep?: boolean;
  /** 協助模式要灰掉哪些錯誤選項的順序（每格一份）；未提供則按 options 順序。 */
  grayOrder?: string[][];
  /** 幾毫秒後才能「決定好了」；預設 LOCK_OPENS_AT。測試可設 0。 */
  lockOpensAt?: number;
}

export interface RepairState {
  slots: RepairSlotInput[];
  progress: number;
  startedAt: number;
  limitMs: number;
  assistAt: number;
  secondAssistAt: number;
  assistLevel: 0 | 1 | 2;
  grayed: string[][];
  eliminateUsed: boolean;
  wrongPicks: number;
  doneAt: number | null;
}

export interface LogEntry {
  at: number;
  kind: 'hint' | 'storm_warning' | 'crisis' | 'swept' | 'assist' | 'eliminate' | 'power_restored' | 'card' | 'throw' | 'rescue' | 'use' | 'undo_use' | 'rejected' | 'settled' | 'time_up';
  data?: Record<string, unknown>;
}

export type ExtraReason =
  | 'WRONG_PHASE'
  | 'TOO_EARLY'
  | 'PINNED'
  | 'SWEPT' // 已經被浪捲走，撈不回來
  | 'NO_ITEM' // 要用掉的東西不在船上
  | 'CANNOT_TONIGHT' // 今晚做不到（吃不下、水太深）或那件事已經顧好
  | 'ALREADY_USED' // 天亮前只來得及做一件
  | 'UNDO_EXPIRED'; // 超過 3 秒不能取消

export interface GameState {
  seedId: SeedId;
  cards: { a: CardId; b: CardId };
  tonight: Tonight;
  sweep: boolean;
  playerCount: number;
  firstRound: boolean;
  phase: Phase;
  now: number;
  plan: Plan;
  locked: boolean;
  /** 風暴（危機）預定什麼時候來：2:45（A2 提早），船長「決定好了」後若有風暴捲走則改為 10 秒後。 */
  stormAt: number;
  warned: boolean; // 已發出 10 秒提醒
  swept: ItemId[]; // 被浪捲走、撈不回來的東西
  crisisAt: number | null;
  crisisCause: 'lock' | 'timeout' | null;
  planAtCrisis: Plan | null;
  hint: { evaluated: boolean; shown: boolean };
  repair: RepairState | null;
  pendingSlots: RepairSlotInput[];
  grayOrder: string[][] | null;
  powerAt: number | null; // 補好船的時間（第十四天夜裡，風暴卡翻開）
  used: { use: UseId; item: ItemId; at: number } | null; // 天亮前用掉的那一件
  lockOpensAt: number;
  lastRejection: { at: number; action: Exclude<GameEvent['type'], 'tick'>; reasons: (RejectReason | ExtraReason)[] } | null;
  rejections: number;
  result: { stars: 0 | 1 | 2 | 3; served: string[]; weight: number; at: number; cause: 'depart' | 'time_up' } | null;
  log: LogEntry[];
}

export type GameEvent =
  | { type: 'tick'; at: number }
  | { type: 'setItem'; at: number; item: ItemId; on: boolean }
  | { type: 'lock'; at: number }
  | { type: 'repairPick'; at: number; option: string }
  | { type: 'useEliminate'; at: number }
  | { type: 'use'; at: number; use: UseId }
  | { type: 'undoUse'; at: number }
  | { type: 'depart'; at: number };

export function symbolCount(playerCount: number): 2 | 3 | 4 {
  if (playerCount <= 3) return 2;
  if (playerCount === 4) return 3;
  return 4;
}

/** 排除線索名額：非木匠中沒拿到記號的人數。 */
export function eliminationClueCount(playerCount: number): number {
  return Math.max(0, playerCount - 1 - symbolCount(playerCount));
}

export function repairLimitMs(playerCount: number, firstRound: boolean, bonusMs = 0): number {
  const base = symbolCount(playerCount) === 4 ? 60_000 : 45_000;
  return base + (firstRound ? FIRST_ROUND_EXTRA : 0) + bonusMs;
}

export function crisisAtFor(cards: { a: CardId; b: CardId }): number {
  return CRISIS_AT + (CARDS[cards.a].crisisShiftMs ?? 0);
}

export function createGame(config: GameConfig): GameState {
  const { playerCount } = config;
  if (!Number.isInteger(playerCount) || playerCount < 3 || playerCount > 10) throw new Error('人數必須是 3–10');
  if (config.slots.length !== symbolCount(playerCount)) throw new Error('補船格數與人數不符');
  for (const s of config.slots) {
    if (s.options.length !== 9 || !s.options.includes(s.answer)) throw new Error('每格需 9 個選項且含正確答案');
  }
  if (CARDS[config.cards.a]?.deck !== 'A' || CARDS[config.cards.b]?.deck !== 'B') throw new Error('故事卡要起風、風暴各一張');
  const tonight = { ...(config.tonight ?? CLASSIC) };
  if (!storyOk([config.cards.a, config.cards.b], tonight)) throw new Error('故事卡和見聞不能同局');
  const seed = SEEDS[config.seedId];
  const start = effective(seed, { crisis: false, powerOn: false, cards: [config.cards.a], tonight, used: null });
  return {
    seedId: config.seedId,
    cards: { ...config.cards },
    tonight,
    sweep: config.sweep ?? !config.firstRound,
    playerCount,
    firstRound: config.firstRound,
    phase: 'planning',
    now: 0,
    plan: { items: [...start.aboard] }, // 一開始全部東西都在船上
    locked: false,
    stormAt: crisisAtFor(config.cards),
    warned: false,
    swept: [],
    crisisAt: null,
    crisisCause: null,
    planAtCrisis: null,
    hint: { evaluated: false, shown: false },
    repair: null,
    pendingSlots: config.slots,
    grayOrder: config.grayOrder ?? null,
    powerAt: null,
    used: null,
    lockOpensAt: config.lockOpensAt ?? LOCK_OPENS_AT,
    lastRejection: null,
    rejections: 0,
    result: null,
    log: [],
  };
}

export function seedOf(state: GameState): SeedDef {
  return SEEDS[state.seedId];
}

/** 這局目前生效的卡：起風卡一開始就有；風暴卡在補好船時翻開。 */
export function activeCards(state: GameState): CardId[] {
  return state.powerAt !== null ? [state.cards.a, state.cards.b] : [state.cards.a];
}

export function dawnOpensAt(state: GameState): number | null {
  if (state.powerAt === null) return null;
  return state.powerAt + (CARDS[state.cards.b].departDelayMs ?? 0);
}

export function worldOf(state: GameState): World {
  const open = dawnOpensAt(state);
  return {
    crisis: state.crisisAt !== null,
    powerOn: state.powerAt !== null,
    tonight: state.tonight,
    used: state.used?.use ?? null,
    cards: activeCards(state),
    dawnOpen: open === null ? undefined : state.now >= open,
  };
}

/** 目前方案的即時評估。規劃期不把「還在黑暗中」當成問題。 */
export function evaluate(state: GameState): Evaluation {
  const world = worldOf(state);
  if (state.phase === 'planning') world.powerOn = true;
  return evaluatePlan(seedOf(state), state.plan, world);
}

/** 現在船上可選的東西（扣掉被浪捲走的）與丟不掉的東西。 */
export function aboardOf(state: GameState): { aboard: ItemId[]; pinned: ItemId[]; weights: Record<ItemId, number> } {
  const eff = effective(seedOf(state), worldOf(state));
  return { aboard: eff.aboard.filter((i) => !state.swept.includes(i)), pinned: eff.pinned, weights: eff.weights };
}

/** 今晚上岸三件事各靠哪一樣。 */
export function providers(state: GameState) {
  return providerOf(state.tonight);
}

/** 補好船後這局真的能做的用掉（東西要還留在船上）；已經用掉一件就沒有了。 */
export function usesNow(state: GameState): UseId[] {
  if (state.phase !== 'replanning' || state.used) return [];
  return usesAvailable(seedOf(state), activeCards(state), state.tonight, state.plan.items);
}

/** 今晚「原則上」能做的用掉（不看東西在不在船上）：決定誰手機上出現按鈕。 */
export function usesTonight(state: GameState): UseId[] {
  if (state.powerAt === null) return [];
  const all = ITEMS.filter((i) => !state.swept.includes(i));
  return usesAvailable(seedOf(state), activeCards(state), state.tonight, all);
}

/** 規劃期：漂著的東西還有幾毫秒被捲走（沒有風暴捲走或不在提醒時段＝null）。 */
export function sweepWarning(state: GameState): { inMs: number; floating: ItemId[] } | null {
  if (!state.sweep || state.phase !== 'planning' || !state.warned) return null;
  const aboard = aboardOf(state).aboard;
  return { inMs: Math.max(0, state.stormAt - state.now), floating: aboard.filter((i) => !state.plan.items.includes(i)) };
}

function clone(state: GameState): GameState {
  return structuredClone(state);
}

function startCrisis(s: GameState, at: number, cause: 'lock' | 'timeout'): void {
  if (s.crisisAt !== null) return; // 一局只發生一次
  if (s.sweep) {
    // 風暴捲走：漂著的東西撈不回來；還超重就從最重的開始捲走（同重由畫面右邊開始），直到不超重
    const seed = seedOf(s);
    const eff = effective(seed, worldOf(s));
    const gone = eff.aboard.filter((i) => !s.plan.items.includes(i));
    const keep = eff.aboard.filter((i) => s.plan.items.includes(i));
    let weight = keep.reduce((n, i) => n + eff.weights[i], 0);
    const order = [...keep].sort((x, y) => eff.weights[y] - eff.weights[x] || ITEMS.indexOf(y) - ITEMS.indexOf(x));
    for (const i of order) {
      if (weight <= eff.cap) break;
      gone.push(i);
      weight -= eff.weights[i];
    }
    s.swept = ITEMS.filter((i) => gone.includes(i));
    s.plan.items = s.plan.items.filter((i) => !gone.includes(i));
    if (s.swept.length) s.log.push({ at, kind: 'swept', data: { items: s.swept } });
  }
  s.crisisAt = at;
  s.crisisCause = cause;
  s.planAtCrisis = structuredClone(s.plan);
  s.phase = 'blackout';
  const bonus = CARDS[s.cards.a].repairBonusMs ?? 0;
  const limitMs = repairLimitMs(s.playerCount, s.firstRound, bonus);
  const base = limitMs - (s.firstRound ? FIRST_ROUND_EXTRA : 0);
  // 首局：協助模式提早 15 秒出現，限時也多 15 秒（ADR-0003 第 12 條）
  const assistAt = at + (s.firstRound ? base - FIRST_ROUND_EXTRA : base);
  s.repair = {
    slots: s.pendingSlots,
    progress: 0,
    startedAt: at,
    limitMs,
    assistAt,
    secondAssistAt: at + limitMs + SECOND_ASSIST_AFTER,
    assistLevel: 0,
    grayed: s.pendingSlots.map(() => []),
    eliminateUsed: false,
    wrongPicks: 0,
    doneAt: null,
  };
  s.log.push({ at, kind: 'crisis', data: { cause } });
}

function grayMore(s: GameState, slotIndex: number, count: number): void {
  const r = s.repair!;
  const slot = r.slots[slotIndex];
  const order = s.grayOrder?.[slotIndex] ?? slot.options;
  for (const opt of order) {
    if (count <= 0) break;
    if (opt === slot.answer || r.grayed[slotIndex].includes(opt)) continue;
    r.grayed[slotIndex].push(opt);
    count--;
  }
}

function applyAssist(s: GameState, level: 1 | 2): void {
  const r = s.repair!;
  if (r.assistLevel >= level) return;
  r.assistLevel = level;
  r.slots.forEach((slot, i) => {
    const wrong = slot.options.length - 1;
    const target = level === 1 ? Math.floor(wrong / 2) : wrong - 1;
    grayMore(s, i, target - r.grayed[i].length);
  });
}

/** 補好船：第十四天夜裡，翻開風暴卡；自動離船的東西從方案中拿掉。 */
function restorePower(s: GameState, at: number): void {
  const r = s.repair!;
  r.doneAt = at;
  s.powerAt = at;
  s.phase = 'replanning';
  const aboard = effective(seedOf(s), worldOf(s)).aboard;
  const gone = s.plan.items.filter((i) => !aboard.includes(i));
  s.plan.items = s.plan.items.filter((i) => aboard.includes(i));
  s.log.push({
    at,
    kind: 'power_restored',
    data: { durationMs: at - r.startedAt, assistLevel: r.assistLevel, eliminateUsed: r.eliminateUsed, wrongPicks: r.wrongPicks },
  });
  s.log.push({ at, kind: 'card', data: { card: s.cards.b, gone } });
}

function advanceTime(s: GameState, at: number): void {
  if (at < s.now) at = s.now; // 時間不倒流
  s.now = at;
  if (s.phase === 'planning' && !s.hint.evaluated && at >= HINT_AT) {
    s.hint.evaluated = true;
    const ev = evaluate(s);
    // 通過的起風卡×見聞危機前一定排得到三件（validSetups），所以不必再排除 A1
    s.hint.shown = ev.stars < 3 || ev.overweight > 0;
    if (s.hint.shown) s.log.push({ at: HINT_AT, kind: 'hint' });
  }
  if (s.phase === 'planning' && s.sweep && !s.warned && at >= s.stormAt - SWEEP_WARNING_MS) {
    s.warned = true;
    s.log.push({ at: Math.max(0, s.stormAt - SWEEP_WARNING_MS), kind: 'storm_warning' });
  }
  if (s.phase === 'planning' && at >= s.stormAt) startCrisis(s, s.stormAt, s.locked ? 'lock' : 'timeout');
  if (s.phase === 'blackout' && s.repair) {
    if (at >= s.repair.assistAt && s.repair.assistLevel < 1) {
      applyAssist(s, 1);
      s.log.push({ at: s.repair.assistAt, kind: 'assist', data: { level: 1 } });
    }
    if (at >= s.repair.secondAssistAt && s.repair.assistLevel < 2) {
      applyAssist(s, 2);
      s.log.push({ at: s.repair.secondAssistAt, kind: 'assist', data: { level: 2 } });
    }
  }
  if (at >= TIME_UP_AT && (s.phase === 'planning' || s.phase === 'blackout' || s.phase === 'replanning')) {
    const ev = evaluatePlan(seedOf(s), s.plan, worldOf(s));
    if (s.phase === 'replanning' && ev.reasons.length === 0) {
      settle(s, TIME_UP_AT, ev, 'time_up');
    } else {
      s.phase = 'ended';
      s.log.push({ at: TIME_UP_AT, kind: 'time_up' });
    }
  }
}

function settle(s: GameState, at: number, ev: Evaluation, cause: 'depart' | 'time_up'): void {
  s.phase = 'settled';
  s.result = { stars: ev.stars, served: ev.served, weight: ev.weight, at, cause };
  s.log.push({ at, kind: 'settled', data: { stars: ev.stars, served: ev.served, cause } });
}

function reject(s: GameState, action: Exclude<GameEvent['type'], 'tick'>, at: number, reasons: NonNullable<GameState['lastRejection']>['reasons']): GameState {
  s.lastRejection = { at, action, reasons };
  s.rejections++;
  return s;
}

const EDITABLE: Phase[] = ['planning', 'replanning'];

export function apply(prev: GameState, event: GameEvent): GameState {
  const s = clone(prev);
  advanceTime(s, event.at);
  const at = s.now;
  const seed = seedOf(s);

  switch (event.type) {
    case 'tick':
      return s;

    case 'setItem': {
      if (!EDITABLE.includes(s.phase)) return reject(s, event.type, at, ['WRONG_PHASE']);
      if (event.on && s.swept.includes(event.item)) return reject(s, event.type, at, ['SWEPT']);
      const { aboard, pinned } = aboardOf(s);
      if (!aboard.includes(event.item)) return s;
      if (!event.on && pinned.includes(event.item)) return reject(s, event.type, at, ['PINNED']);
      const has = s.plan.items.includes(event.item);
      if (event.on && !has) {
        s.plan.items = aboard.filter((i) => i === event.item || s.plan.items.includes(i));
        s.log.push({ at, kind: 'rescue', data: { item: event.item } });
      }
      if (!event.on && has) {
        s.plan.items = s.plan.items.filter((i) => i !== event.item);
        s.log.push({ at, kind: 'throw', data: { item: event.item } });
      }
      return s;
    }

    case 'lock': {
      if (s.phase !== 'planning' || s.locked) return reject(s, event.type, at, ['WRONG_PHASE']);
      if (at < s.lockOpensAt) return reject(s, event.type, at, ['TOO_EARLY']);
      const ev = evaluate(s);
      if (ev.reasons.length > 0) return reject(s, event.type, at, ev.reasons);
      s.locked = true;
      s.lastRejection = null;
      if (s.sweep) {
        // 決定好了：風暴 10 秒後來，先提醒「漂著的東西快被捲走了」，這 10 秒內還可以撈回
        s.stormAt = Math.min(s.stormAt, at + SWEEP_WARNING_MS);
        advanceTime(s, at);
      } else startCrisis(s, at, 'lock');
      return s;
    }

    case 'repairPick': {
      if (s.phase !== 'blackout' || !s.repair) return reject(s, event.type, at, ['WRONG_PHASE']);
      const r = s.repair;
      const slot = r.slots[r.progress];
      if (event.option === slot.answer) {
        r.progress++;
        if (r.progress === r.slots.length) restorePower(s, at);
      } else if (slot.options.includes(event.option)) {
        r.wrongPicks++;
      }
      return s;
    }

    case 'useEliminate': {
      if (s.phase !== 'blackout' || !s.repair || s.repair.eliminateUsed) return reject(s, event.type, at, ['WRONG_PHASE']);
      s.repair.eliminateUsed = true;
      grayMore(s, s.repair.progress, 2);
      s.log.push({ at, kind: 'eliminate', data: { slot: s.repair.progress } });
      return s;
    }

    case 'use': {
      if (s.phase !== 'replanning') return reject(s, event.type, at, [s.phase === 'blackout' ? 'NOT_POWERED' : 'WRONG_PHASE']);
      if (s.used) return reject(s, event.type, at, ['ALREADY_USED']);
      if (!usesTonight(s).includes(event.use)) return reject(s, event.type, at, ['CANNOT_TONIGHT']);
      const item = providers(s)[USES[event.use].need];
      if (!usesNow(s).includes(event.use)) return reject(s, event.type, at, ['NO_ITEM']);
      s.used = { use: event.use, item, at };
      s.plan.items = s.plan.items.filter((i) => i !== item);
      s.lastRejection = null;
      s.log.push({ at, kind: 'use', data: { use: event.use, item } });
      return s;
    }

    case 'undoUse': {
      if (s.phase !== 'replanning' || !s.used) return reject(s, event.type, at, ['WRONG_PHASE']);
      if (at - s.used.at > UNDO_USE_MS) return reject(s, event.type, at, ['UNDO_EXPIRED']);
      const { item, use } = s.used;
      s.used = null;
      s.plan.items = ITEMS.filter((i) => i === item || s.plan.items.includes(i));
      s.log.push({ at, kind: 'undo_use', data: { use, item } });
      return s;
    }

    case 'depart': {
      if (s.phase === 'settled' || s.phase === 'ended') return s; // 只結算一次
      if (s.phase === 'planning') return reject(s, event.type, at, ['WRONG_PHASE']);
      const ev = evaluatePlan(seed, s.plan, worldOf(s));
      if (ev.reasons.length > 0) {
        s.log.push({ at, kind: 'rejected', data: { reasons: ev.reasons } });
        return reject(s, event.type, at, ev.reasons);
      }
      s.lastRejection = null;
      settle(s, at, ev, 'depart');
      return s;
    }
  }
}

export function applyAll(state: GameState, events: GameEvent[]): GameState {
  return events.reduce(apply, state);
}
