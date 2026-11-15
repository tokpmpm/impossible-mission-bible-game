// 「留什麼」的判定與分星：純函式，不含時間與階段。ADR-0006。
import { CARDS, ITEMS, NEEDS, SEEDS, type CardId, type ItemId, type NeedId, type SeedDef, type SeedId } from './seeds.ts';

export type RejectReason =
  | 'NOT_POWERED' // 還在黑暗中（補好船前）
  | 'WAIT_DAWN' // 還在等天亮（故事卡 B5）
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
  fed: boolean; // 吃過飯
  cards: CardId[]; // 這局抽到的卡；B 卡只在 crisis 時生效（與腳本相同）
  dawnOpen?: boolean; // 不傳＝可以（B5 的等待由狀態機算）
}

export interface Effective {
  weights: Record<ItemId, number>;
  aboard: ItemId[]; // 還可能在船上的東西（扣掉自動離船與吃掉的）
  done: NeedId[]; // 不用帶東西就已顧好的事
  pinned: ItemId[]; // 現在丟不掉的東西
  cap: number;
}

export function effective(seed: SeedDef, world: World): Effective {
  const weights = { ...seed.weights };
  const removed = new Set<ItemId>();
  const done = new Set<NeedId>();
  const pinned = new Set<ItemId>();
  for (const id of world.cards) {
    const c = CARDS[id];
    if (c.deck === 'B' && !world.crisis) continue;
    for (const [k, d] of Object.entries(c.weight ?? {}) as [ItemId, number][]) weights[k] += d;
    for (const i of c.remove ?? []) removed.add(i);
    for (const n of c.done ?? []) done.add(n);
    if (!world.crisis) for (const i of c.pinPre ?? []) pinned.add(i);
  }
  if (world.fed) {
    removed.add(seed.food);
    done.add('力氣');
  }
  return {
    weights,
    aboard: ITEMS.filter((i) => !removed.has(i)),
    done: NEEDS.filter((n) => done.has(n)),
    pinned: [...pinned],
    cap: world.crisis ? seed.capPost : seed.capPre,
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
  const served = NEEDS.filter((n) => eff.done.includes(n) || kept.includes(seed.needs[n]));
  const reasons: RejectReason[] = [];
  if (!world.powerOn) reasons.push('NOT_POWERED');
  if (world.dawnOpen === false) reasons.push('WAIT_DAWN');
  if (weight > eff.cap) reasons.push('OVERWEIGHT');
  return {
    weight,
    cap: eff.cap,
    overweight: Math.max(0, weight - eff.cap),
    served,
    stars: served.length as 0 | 1 | 2 | 3,
    reasons,
  };
}
