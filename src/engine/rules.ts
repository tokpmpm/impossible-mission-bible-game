// 「留什麼」的判定與分星：純函式，不含時間與階段。ADR-0006；2026-11-16 加入見聞與「用掉」（docs/12 第 3 節）。
import {
  CARDS,
  DECK_A,
  DECK_B,
  DIALS,
  ITEMS,
  NEEDS,
  SEEDS,
  TONIGHT_VALUES,
  USE_ENABLED,
  USES,
  providerOf,
  type CardId,
  type ItemId,
  type NeedId,
  type SeedDef,
  type SeedId,
  type Tonight,
  type UseId,
} from './seeds.ts';

export type RejectReason =
  | 'NOT_POWERED' // 還在黑暗中（補好船前）
  | 'WAIT_DAWN' // 還在等天亮（保留給往後的卡）
  | 'OVERWEIGHT'; // 超重

export const REASON_TEXT: Record<RejectReason, string> = {
  NOT_POWERED: '還在黑暗中',
  WAIT_DAWN: '還在等天亮',
  OVERWEIGHT: '超重',
};

export interface Plan {
  items: ItemId[]; // 留在船上的東西
}

export interface World {
  crisis: boolean; // 27:20 之後
  powerOn: boolean; // 補好船
  cards: CardId[]; // 這局抽到的卡；B 卡只在 crisis 時生效（與腳本相同）
  tonight: Tonight; // 這局的見聞
  used: UseId | null; // 已經用掉的那一種
  dawnOpen?: boolean; // 不傳＝可以
}

export interface Effective {
  weights: Record<ItemId, number>;
  aboard: ItemId[]; // 還可能在船上的東西（扣掉自動離船與用掉的）
  done: NeedId[]; // 不用帶東西就已顧好的事
  pinned: ItemId[]; // 現在丟不掉的東西
  eatOnly: NeedId[]; // 只能靠用掉顧好的事
  cap: number;
  provider: Record<NeedId, ItemId>; // 今晚三件事各靠哪一樣
}

export function weightsFor(seed: SeedDef, cards: CardId[]): Record<ItemId, number> {
  const w = { ...seed.weights };
  for (const id of cards) for (const [k, d] of Object.entries(CARDS[id].weight ?? {}) as [ItemId, number][]) w[k] = Math.max(0, w[k] + d);
  return w;
}

export function effective(seed: SeedDef, world: World): Effective {
  const cards = world.cards.filter((id) => CARDS[id].deck === 'A' || world.crisis);
  const weights = weightsFor(seed, cards);
  const removed = new Set<ItemId>();
  const done = new Set<NeedId>();
  const pinned = new Set<ItemId>();
  // 力氣只能靠吃飯：危機後才算（危機前還不能吃，留著今晚的食物＝準備好了）。與 tools/verify_seeds.py 相同
  const eatOnly = new Set<NeedId>(world.crisis ? seed.eatOnly : []);
  for (const id of cards) {
    const c = CARDS[id];
    for (const i of c.remove ?? []) removed.add(i);
    for (const n of c.done ?? []) done.add(n);
    if (!world.crisis) for (const i of c.pinPre ?? []) pinned.add(i);
    for (const n of c.eatOnly ?? []) eatOnly.add(n);
  }
  const provider = providerOf(world.tonight);
  if (world.used) {
    const need = USES[world.used].need;
    removed.add(provider[need]);
    done.add(need);
  }
  return {
    weights,
    aboard: ITEMS.filter((i) => !removed.has(i)),
    done: NEEDS.filter((n) => done.has(n)),
    pinned: [...pinned],
    eatOnly: [...eatOnly],
    cap: world.crisis ? seed.capPost : seed.capPre,
    provider,
  };
}

export interface Evaluation {
  weight: number;
  cap: number;
  overweight: number; // 超出多少，未超重為 0
  served: NeedId[]; // 顧好的事
  stars: 0 | 1 | 2 | 3; // 顧好幾件（不管能不能出發，與腳本相同）
  reasons: RejectReason[]; // 空陣列＝可以衝向海灘
}

export function evaluatePlan(seedOrId: SeedDef | SeedId, plan: Plan, world: World): Evaluation {
  const seed = typeof seedOrId === 'string' ? SEEDS[seedOrId] : seedOrId;
  const eff = effective(seed, world);
  const kept = plan.items.filter((i) => eff.aboard.includes(i));
  const weight = kept.reduce((sum, i) => sum + eff.weights[i], 0);
  const served = NEEDS.filter((n) => eff.done.includes(n) || (kept.includes(eff.provider[n]) && !eff.eatOnly.includes(n)));
  const reasons: RejectReason[] = [];
  if (!world.powerOn) reasons.push('NOT_POWERED');
  if (world.dawnOpen === false) reasons.push('WAIT_DAWN');
  if (weight > eff.cap) reasons.push('OVERWEIGHT');
  return { weight, cap: eff.cap, overweight: Math.max(0, weight - eff.cap), served, stars: served.length as 0 | 1 | 2 | 3, reasons };
}

/** 見聞允許這種用掉嗎（不看東西在不在船上）。 */
export function useAllowedTonight(use: UseId, t: Tonight): boolean {
  if (!USE_ENABLED.includes(use)) return false;
  const b = USES[use].blocked;
  return !(b && t[b.dial] === b.value);
}

/** 補好船後這局真的能做的用掉：見聞允許、那件事還沒被卡片顧好、那樣東西在 onShip 裡。 */
export function usesAvailable(seed: SeedDef, cards: CardId[], t: Tonight, onShip: ItemId[]): UseId[] {
  const eff = effective(seed, { crisis: true, powerOn: true, cards, tonight: t, used: null });
  return (Object.keys(USES) as UseId[]).filter(
    (u) => useAllowedTonight(u, t) && !eff.done.includes(USES[u].need) && onShip.includes(eff.provider[USES[u].need]) && eff.aboard.includes(eff.provider[USES[u].need]),
  );
}

/** 起風卡／風暴卡能不能和這組見聞同局（卡片的 fix／exclude）。 */
export function storyOk(cards: CardId[], t: Tonight): boolean {
  for (const id of cards) {
    const c = CARDS[id];
    for (const [d, v] of Object.entries(c.fix ?? {})) if (t[d as keyof Tonight] !== v) return false;
    for (const [d, v] of Object.entries(c.exclude ?? {})) if (t[d as keyof Tonight] === v) return false;
  }
  return true;
}

function subsets(items: ItemId[]): ItemId[][] {
  const xs = ITEMS.filter((i) => items.includes(i));
  const out: ItemId[][] = [];
  for (let m = 0; m < 1 << xs.length; m++) out.push(xs.filter((_, i) => (m >> i) & 1));
  return out;
}

function combos<T>(xs: T[], n: number): T[][] {
  if (n === 0) return [[]];
  if (xs.length < n) return [];
  const [h, ...t] = xs;
  return [...combos(t, n - 1).map((c) => [h, ...c]), ...combos(t, n)];
}

/** 風暴前帶著 keep 過危機（漂著的被捲走），補好船、翻開風暴卡後最高幾星。 */
export function bestAfterStorm(seed: SeedDef, a: CardId, b: CardId, t: Tonight, keep: ItemId[]): number {
  const base = effective(seed, { crisis: true, powerOn: true, cards: [a, b], tonight: t, used: null });
  const aboard = keep.filter((i) => base.aboard.includes(i));
  let best = -1;
  for (const use of [null, ...usesAvailable(seed, [a, b], t, aboard)] as (UseId | null)[]) {
    const world: World = { crisis: true, powerOn: true, cards: [a, b], tonight: t, used: use };
    const eff = effective(seed, world);
    const pool = aboard.filter((i) => eff.aboard.includes(i) && Object.values(eff.provider).includes(i));
    for (const k of subsets(pool)) {
      const ev = evaluatePlan(seed, { items: k }, world);
      if (ev.reasons.length === 0) best = Math.max(best, ev.stars);
    }
  }
  return best;
}

export interface Setup {
  a: CardId;
  tonight: Tonight;
  b: CardId[]; // 允許的風暴卡
}

/**
 * 通過的「起風卡×見聞」與允許的風暴卡（docs/12 3.5–3.6）：要有一種風暴前帶法，不管翻到哪一張允許的風暴卡都三星，
 * 且允許的至少 3 張。與 tools/verify_seeds.py 的 setups() 逐項一致（test/golden.test.ts）。房間層照這張表抽。
 */
let setupCache: Setup[] | null = null;
export function validSetups(seedId: SeedId = 'ship 001'): Setup[] {
  if (setupCache) return setupCache;
  const seed = SEEDS[seedId];
  const out: Setup[] = [];
  const vals = DIALS.map((d) => TONIGHT_VALUES[d] as string[]);
  const all: Tonight[] = [];
  const walk = (i: number, acc: string[]) => {
    if (i === DIALS.length) return void all.push(Object.fromEntries(DIALS.map((d, j) => [d, acc[j]])) as unknown as Tonight);
    for (const v of vals[i]) walk(i + 1, [...acc, v]);
  };
  walk(0, []);
  for (const a of DECK_A) {
    for (const t of all) {
      if (!storyOk([a], t)) continue;
      const pre = effective(seed, { crisis: false, powerOn: true, cards: [a], tonight: t, used: null });
      const k1s = subsets(pre.aboard).filter((k) => pre.pinned.every((p) => k.includes(p)) && k.reduce((s, i) => s + pre.weights[i], 0) <= pre.cap);
      const res = k1s.map((k) => DECK_B.map((b) => bestAfterStorm(seed, a, b, t, k)));
      const allowed = DECK_B.map((_, i) => i).filter((i) => storyOk([a, DECK_B[i]], t));
      let chosen: number[] | null = null;
      for (let n = allowed.length; n >= 3 && !chosen; n--) {
        for (const S of combos(allowed, n)) {
          if (res.some((r) => S.every((i) => r[i] === 3))) {
            chosen = S;
            break;
          }
        }
      }
      if (chosen) out.push({ a, tonight: t, b: chosen.map((i) => DECK_B[i]) });
    }
  }
  setupCache = out;
  return out;
}
