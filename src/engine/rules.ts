// 出發判定與分星：純函式，不含時間與階段。ADR-0003 第 1、5 條。
import { SEEDS, VILLAGES, type RouteId, type SeedDef, type SeedId, type Village } from './seeds.ts';

export type RejectReason =
  | 'NOT_POWERED' // 尚未恢復供電
  | 'NOT_RELEASED' // 物資尚未發放
  | 'ROAD_CLOSED' // 道路封閉
  | 'TOO_LATE' // 來不及
  | 'OVERWEIGHT' // 超重
  | 'NO_NEEDS' // 沒有任何村需要的物資
  | 'NO_ROUTE'; // 尚未選擇路線

export const REASON_TEXT: Record<RejectReason, string> = {
  NOT_POWERED: '尚未恢復供電',
  NOT_RELEASED: '物資尚未發放',
  ROAD_CLOSED: '道路封閉',
  TOO_LATE: '來不及',
  OVERWEIGHT: '超重',
  NO_NEEDS: '沒有任何村需要的物資',
  NO_ROUTE: '尚未選擇路線',
};

export interface Plan {
  route: RouteId | null;
  items: string[]; // 不含工具；工具隨路線自動上車
}

export interface World {
  crisis: boolean;
  powerOn: boolean;
  floodgate: boolean; // seed 001 分洪閘門已啟動
  released: boolean; // seed 002 淨水錠已發放
}

export interface Evaluation {
  weight: number;
  cap: number;
  overweight: number; // 超出公斤數，未超重為 0
  safeWindow: number | null;
  travel: number | null;
  served: Village[];
  stars: 0 | 1 | 2 | 3;
  reasons: RejectReason[]; // 依 ADR-0003 第 5 條排序；空陣列＝可以出發
  /** 可送達村數：不考慮供電，方案合法時送到幾村，否則 0。 */
  reachable: number;
}

export function capacity(seed: SeedDef, crisis: boolean): number {
  return crisis && seed.crisis.cap !== undefined ? seed.crisis.cap : seed.cap;
}

export function planWeight(seed: SeedDef, plan: Plan): number {
  const tool = plan.route ? seed.routes[plan.route].tool : null;
  const all = tool ? [tool, ...plan.items] : plan.items;
  return all.reduce((sum, i) => sum + (seed.weights[i] ?? 0), 0);
}

export function servedVillages(seed: SeedDef, items: string[], world: World): Village[] {
  const served = VILLAGES.filter((v) => items.includes(seed.needs[v]));
  const b = seed.breakthrough;
  if (b.kind === 'query' && world.released && items.includes(b.item) && !served.includes(b.village)) {
    served.push(b.village);
  }
  return VILLAGES.filter((v) => served.includes(v));
}

export function starsFor(seed: SeedDef, served: Village[]): 0 | 1 | 2 | 3 {
  if (served.length === 0) return 0;
  if (served.length === VILLAGES.length) return 3;
  if (seed.urgent.every((v) => served.includes(v))) return 2;
  return 1;
}

export function evaluatePlan(seedOrId: SeedDef | SeedId, plan: Plan, world: World): Evaluation {
  const seed = typeof seedOrId === 'string' ? SEEDS[seedOrId] : seedOrId;
  const cap = capacity(seed, world.crisis);
  const weight = planWeight(seed, plan);
  const reasons: RejectReason[] = [];
  let safeWindow: number | null = null;
  let travel: number | null = null;

  if (!world.powerOn) reasons.push('NOT_POWERED');
  const b = seed.breakthrough;
  if (b.kind === 'query' && !world.released && plan.items.includes(b.item)) reasons.push('NOT_RELEASED');
  if (plan.route === null) {
    reasons.push('NO_ROUTE');
  } else {
    const route = seed.routes[plan.route];
    travel = route.travel;
    safeWindow = b.kind === 'floodgate' && world.floodgate && plan.route === b.route ? b.value : seed.flood;
    if (world.crisis && seed.crisis.closed === plan.route) reasons.push('ROAD_CLOSED');
    if (travel >= safeWindow) reasons.push('TOO_LATE');
  }
  if (weight > cap) reasons.push('OVERWEIGHT');
  const served = servedVillages(seed, plan.items, world);
  if (served.length === 0) reasons.push('NO_NEEDS');

  const stars = reasons.length === 0 ? starsFor(seed, served) : 0;
  const reachable = reasons.filter((r) => r !== 'NOT_POWERED').length === 0 ? served.length : 0;
  return { weight, cap, overweight: Math.max(0, weight - cap), safeWindow, travel, served, stars, reasons, reachable };
}
