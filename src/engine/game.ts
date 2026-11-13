// 一局的規則狀態機（ADR-0001、0002、0003）。
// 純函式：apply(狀態, 事件) → 新狀態。不讀時鐘、不認識玩家；時間由事件的 at（房間倒數已過毫秒）帶入。
import { evaluatePlan, type Evaluation, type Plan, type RejectReason, type World } from './rules.ts';
import { SEEDS, cargoItems, type QueryQuestion, type RouteId, type SeedDef, type SeedId, type Village } from './seeds.ts';

export const HINT_AT = 135_000; // 2:15
export const CRISIS_AT = 165_000; // 2:45
export const TIME_UP_AT = 480_000; // 8:00
export const FIRST_ROUND_EXTRA = 15_000;
export const SECOND_ASSIST_AFTER = 15_000; // 逾時再 15 秒，只留正確＋1 個錯誤選項

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
  channel?: string; // seed 001 授權頻道
  /** 協助模式要灰掉哪些錯誤選項的順序（每格一份，引擎依序取用）；未提供則按 options 順序。 */
  grayOrder?: string[][];
}

export interface RepairState {
  slots: RepairSlotInput[];
  progress: number; // 已填對幾格
  startedAt: number;
  limitMs: number; // 顯示給玩家的限時
  assistAt: number; // 協助模式開始（房間倒數毫秒）
  secondAssistAt: number;
  assistLevel: 0 | 1 | 2;
  grayed: string[][]; // 每格被灰掉的選項
  eliminateUsed: boolean;
  wrongPicks: number;
  doneAt: number | null;
}

export interface LogEntry {
  at: number;
  kind:
    | 'hint'
    | 'crisis'
    | 'assist'
    | 'eliminate'
    | 'power_restored'
    | 'floodgate'
    | 'floodgate_wrong'
    | 'query'
    | 'rejected'
    | 'settled'
    | 'time_up';
  data?: Record<string, unknown>;
}

export interface GameState {
  seedId: SeedId;
  playerCount: number;
  firstRound: boolean;
  phase: Phase;
  now: number;
  plan: Plan;
  locked: boolean;
  crisisAt: number | null;
  crisisCause: 'lock' | 'timeout' | null;
  planAtCrisis: Plan | null;
  hint: { evaluated: boolean; shown: boolean };
  repair: RepairState | null;
  pendingSlots: RepairSlotInput[];
  grayOrder: string[][] | null;
  channel: string;
  floodgate: boolean;
  released: boolean;
  query: { used: boolean; village: Village | null; question: QueryQuestion | null; success: boolean };
  lastRejection: { at: number; reasons: (RejectReason | 'GREEN_NOT_LOCKABLE' | 'WRONG_PHASE')[] } | null;
  result: { stars: 0 | 1 | 2 | 3; served: Village[]; weight: number; at: number; cause: 'depart' | 'time_up' } | null;
  log: LogEntry[];
}

export type GameEvent =
  | { type: 'tick'; at: number }
  | { type: 'selectRoute'; at: number; route: RouteId }
  | { type: 'setItem'; at: number; item: string; on: boolean }
  | { type: 'lock'; at: number }
  | { type: 'repairPick'; at: number; option: string }
  | { type: 'useEliminate'; at: number }
  | { type: 'floodgate'; at: number; channel: string }
  | { type: 'query'; at: number; village: Village; question: QueryQuestion }
  | { type: 'depart'; at: number };

export function symbolCount(playerCount: number): 2 | 3 | 4 {
  if (playerCount <= 3) return 2;
  if (playerCount === 4) return 3;
  return 4;
}

/** 排除線索名額：非工程師中沒拿到符號的人數。 */
export function eliminationClueCount(playerCount: number): number {
  return Math.max(0, playerCount - 1 - symbolCount(playerCount));
}

export function repairLimitMs(playerCount: number, firstRound: boolean): number {
  const base = symbolCount(playerCount) === 4 ? 60_000 : 45_000;
  return base + (firstRound ? FIRST_ROUND_EXTRA : 0);
}

export function createGame(config: GameConfig): GameState {
  const { playerCount } = config;
  if (!Number.isInteger(playerCount) || playerCount < 3 || playerCount > 10) throw new Error('人數必須是 3–10');
  if (config.slots.length !== symbolCount(playerCount)) throw new Error('修復格數與人數不符');
  for (const s of config.slots) {
    if (s.options.length !== 9 || !s.options.includes(s.answer)) throw new Error('每格需 9 個選項且含正確答案');
  }
  return {
    seedId: config.seedId,
    playerCount,
    firstRound: config.firstRound,
    phase: 'planning',
    now: 0,
    plan: { route: null, items: [] },
    locked: false,
    crisisAt: null,
    crisisCause: null,
    planAtCrisis: null,
    hint: { evaluated: false, shown: false },
    repair: null,
    pendingSlots: config.slots,
    grayOrder: config.grayOrder ?? null,
    channel: config.channel ?? '472',
    floodgate: false,
    released: false,
    query: { used: false, village: null, question: null, success: false },
    lastRejection: null,
    result: null,
    log: [],
  };
}

export function seedOf(state: GameState): SeedDef {
  return SEEDS[state.seedId];
}

export function worldOf(state: GameState): World {
  return {
    crisis: state.crisisAt !== null,
    powerOn: state.phase === 'replanning' || state.phase === 'settled',
    floodgate: state.floodgate,
    released: state.released,
  };
}

/** 目前方案的即時評估（可送達村數、超重公斤數、拒絕原因）。 */
export function evaluate(state: GameState): Evaluation {
  const world = worldOf(state);
  // 危機前規劃中，不把「尚未恢復供電」當成方案問題
  if (state.phase === 'planning') world.powerOn = true;
  return evaluatePlan(seedOf(state), state.plan, world);
}

function clone(state: GameState): GameState {
  return structuredClone(state);
}

function startCrisis(s: GameState, at: number, cause: 'lock' | 'timeout'): void {
  if (s.crisisAt !== null) return; // 一局只發生一次
  s.crisisAt = at;
  s.crisisCause = cause;
  s.planAtCrisis = structuredClone(s.plan);
  s.phase = 'blackout';
  const limitMs = repairLimitMs(s.playerCount, s.firstRound);
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
    const wrong = slot.options.length - 1; // 8
    const target = level === 1 ? Math.floor(wrong / 2) : wrong - 1; // 4 或 7
    grayMore(s, i, target - r.grayed[i].length);
  });
}

function advanceTime(s: GameState, at: number): void {
  if (at < s.now) at = s.now; // 時間不倒流
  s.now = at;
  if (s.phase === 'planning' && !s.hint.evaluated && at >= HINT_AT) {
    s.hint.evaluated = true;
    s.hint.shown = evaluate(s).reachable < 3;
    if (s.hint.shown) s.log.push({ at: HINT_AT, kind: 'hint' });
  }
  if (s.phase === 'planning' && at >= CRISIS_AT) startCrisis(s, CRISIS_AT, 'timeout');
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
    const ev = evaluate(s);
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

function reject(s: GameState, at: number, reasons: NonNullable<GameState['lastRejection']>['reasons']): GameState {
  s.lastRejection = { at, reasons };
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

    case 'selectRoute': {
      if (!EDITABLE.includes(s.phase)) return reject(s, at, ['WRONG_PHASE']);
      if (!(event.route in seed.routes)) return s;
      s.plan.route = event.route;
      return s;
    }

    case 'setItem': {
      if (!EDITABLE.includes(s.phase)) return reject(s, at, ['WRONG_PHASE']);
      if (!cargoItems(seed).includes(event.item)) return s;
      const b = seed.breakthrough;
      if (event.on && b.kind === 'query' && b.item === event.item && !s.released) {
        return reject(s, at, ['NOT_RELEASED']);
      }
      const has = s.plan.items.includes(event.item);
      if (event.on && !has) s.plan.items = [...s.plan.items, event.item];
      if (!event.on && has) s.plan.items = s.plan.items.filter((i) => i !== event.item);
      return s;
    }

    case 'lock': {
      if (s.phase !== 'planning') return reject(s, at, ['WRONG_PHASE']);
      if (s.plan.route === '綠') return reject(s, at, ['GREEN_NOT_LOCKABLE']);
      const ev = evaluate(s);
      if (ev.reasons.length > 0) return reject(s, at, ev.reasons);
      s.locked = true;
      s.lastRejection = null;
      startCrisis(s, at, 'lock');
      return s;
    }

    case 'repairPick': {
      if (s.phase !== 'blackout' || !s.repair) return reject(s, at, ['WRONG_PHASE']);
      const r = s.repair;
      const slot = r.slots[r.progress];
      if (event.option === slot.answer) {
        r.progress++;
        if (r.progress === r.slots.length) {
          r.doneAt = at;
          s.phase = 'replanning';
          s.log.push({
            at,
            kind: 'power_restored',
            data: { durationMs: at - r.startedAt, assistLevel: r.assistLevel, eliminateUsed: r.eliminateUsed, wrongPicks: r.wrongPicks },
          });
        }
      } else if (slot.options.includes(event.option)) {
        r.wrongPicks++;
      }
      return s;
    }

    case 'useEliminate': {
      if (s.phase !== 'blackout' || !s.repair || s.repair.eliminateUsed) return reject(s, at, ['WRONG_PHASE']);
      s.repair.eliminateUsed = true;
      grayMore(s, s.repair.progress, 2);
      s.log.push({ at, kind: 'eliminate', data: { slot: s.repair.progress } });
      return s;
    }

    case 'floodgate': {
      if (seed.breakthrough.kind !== 'floodgate') return s;
      if (s.phase !== 'replanning') return reject(s, at, ['NOT_POWERED']);
      if (s.floodgate) return s;
      if (event.channel.trim() === s.channel) {
        s.floodgate = true;
        s.log.push({ at, kind: 'floodgate' });
      } else {
        s.log.push({ at, kind: 'floodgate_wrong' });
      }
      return s;
    }

    case 'query': {
      const b = seed.breakthrough;
      if (b.kind !== 'query') return s;
      if (s.phase !== 'replanning') return reject(s, at, ['NOT_POWERED']);
      if (s.query.used) return s;
      const success = event.village === b.village && event.question === b.question;
      s.query = { used: true, village: event.village, question: event.question, success };
      if (success) s.released = true;
      s.log.push({ at, kind: 'query', data: { village: event.village, question: event.question, success } });
      return s;
    }

    case 'depart': {
      if (s.phase === 'settled' || s.phase === 'ended') return s; // 只結算一次
      const ev = evaluatePlan(seed, s.plan, worldOf(s));
      if (ev.reasons.length > 0) {
        s.log.push({ at, kind: 'rejected', data: { reasons: ev.reasons } });
        return reject(s, at, ev.reasons);
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
