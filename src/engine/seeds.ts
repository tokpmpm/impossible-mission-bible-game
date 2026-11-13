// 第一關兩個固定種子。數值必須與 tools/verify_seeds.py 的 SEEDS 一致（由 test/golden.test.ts 逐筆比對）。
// 物品代號沿用腳本（繩子、燈具…），顯示名稱另外對照（seed 002 叫長繩、頭燈）。

export type RouteId = '紅' | '藍' | '綠';
export type Village = '東村' | '西村' | '北村';
export type SeedId = 'seed 001' | 'seed 002';

export interface RouteDef {
  label: string;
  travel: number; // 故事分鐘
  tool: string | null;
}

export interface FloodgateBreakthrough {
  kind: 'floodgate';
  route: RouteId;
  value: number; // 啟動後該路線的安全窗（故事分鐘）
}

export interface QueryBreakthrough {
  kind: 'query';
  item: string; // 確認後才發放的物資
  village: Village; // 可滿足的村
  question: QueryQuestion; // 正確的問題
}

export type QueryQuestion = 'well' | 'road' | 'needs';

export interface SeedDef {
  id: SeedId;
  title: string;
  cap: number;
  flood: number;
  routes: Record<RouteId, RouteDef>;
  weights: Record<string, number>;
  displayNames: Record<string, string>;
  needs: Record<Village, string>;
  urgent: Village[];
  crisis: { closed?: RouteId; cap?: number; title: string; text: string };
  breakthrough: FloodgateBreakthrough | QueryBreakthrough;
  hintText: string;
}

export const VILLAGES: Village[] = ['東村', '西村', '北村'];
export const REGULAR_ROUTES: RouteId[] = ['紅', '藍'];

export const SEEDS: Record<SeedId, SeedDef> = {
  'seed 001': {
    id: 'seed 001',
    title: '吊橋與分洪閘門',
    cap: 7,
    flood: 5,
    routes: {
      紅: { label: '紅線・吊橋', travel: 3, tool: '繩子' },
      藍: { label: '藍線・隧道', travel: 4, tool: '燈具' },
      綠: { label: '綠線・山路', travel: 6, tool: null },
    },
    weights: { 繩子: 1, 燈具: 3, 藥品: 1, 飲水: 2, 毛毯: 3, 食物: 2 },
    displayNames: {},
    needs: { 東村: '藥品', 西村: '飲水', 北村: '毛毯' },
    urgent: ['東村', '西村'],
    crisis: {
      closed: '紅',
      title: '吊橋坍塌！',
      text: '暴雨沖垮了吊橋，紅線不能走了。橋斷了，但阿伯的雞沒事。',
    },
    breakthrough: { kind: 'floodgate', route: '綠', value: 7 },
    hintText: '吊橋用的繩子很輕，好像還裝得下別的。',
  },
  'seed 002': {
    id: 'seed 002',
    title: '落石與淨水錠',
    cap: 6,
    flood: 5,
    routes: {
      紅: { label: '紅線・吊橋', travel: 3, tool: '繩子' },
      藍: { label: '藍線・隧道', travel: 4, tool: '燈具' },
      綠: { label: '綠線・山路', travel: 6, tool: null },
    },
    weights: { 繩子: 3, 燈具: 1, 食物: 2, 藥品: 1, 飲水: 2, 毛毯: 3, 淨水錠: 1 },
    displayNames: { 繩子: '長繩', 燈具: '頭燈' },
    needs: { 東村: '食物', 西村: '藥品', 北村: '飲水' },
    urgent: ['東村', '西村'],
    crisis: {
      cap: 5,
      title: '落石砸中救援車！',
      text: '路都還在，但車子被砸凹了，載重上限從 6 kg 降到 5 kg。司機說：「車還能開，只是要瘦身。」',
    },
    breakthrough: { kind: 'query', item: '淨水錠', village: '北村', question: 'well' },
    hintText: '隧道只要一盞頭燈，比長繩輕多了。',
  },
};

export function displayName(seed: SeedDef, item: string): string {
  return seed.displayNames[item] ?? item;
}

export function toolItems(seed: SeedDef): string[] {
  return Object.values(seed.routes)
    .map((r) => r.tool)
    .filter((t): t is string => t !== null);
}

/** 玩家可挑選的物資（不含工具）。 */
export function cargoItems(seed: SeedDef): string[] {
  const tools = new Set(toolItems(seed));
  return Object.keys(seed.weights).filter((i) => !tools.has(i));
}
