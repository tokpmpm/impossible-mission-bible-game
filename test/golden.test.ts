// 規則引擎與 tools/verify_seeds.py 逐筆一致（ADR-0002）。
// 對照檔由 `python3 tools/verify_seeds.py --export test/fixtures/verify_seeds_golden.json` 產生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePlan, REASON_TEXT, type World } from '../src/engine/rules.ts';
import { SEEDS, toolItems, type RouteId, type SeedId } from '../src/engine/seeds.ts';

interface Row { seed: SeedId; scenario: string; route: RouteId; cargo: string[]; stars: number; reason: string | null }
const golden = JSON.parse(readFileSync(new URL('./fixtures/verify_seeds_golden.json', import.meta.url), 'utf8')) as {
  seeds: Record<string, { tools: Record<string, string | null> }>;
  rows: Row[];
};

const worlds: Record<string, World> = {
  危機前: { crisis: false, powerOn: true, floodgate: false, released: false },
  危機後: { crisis: true, powerOn: true, floodgate: false, released: false },
  '危機後＋突破口': { crisis: true, powerOn: true, floodgate: true, released: true },
};

test('種子數值與腳本相同（路線工具）', () => {
  for (const [id, { tools }] of Object.entries(golden.seeds)) {
    const seed = SEEDS[id as SeedId];
    for (const [route, tool] of Object.entries(tools)) assert.equal(seed.routes[route as RouteId].tool, tool, `${id} ${route}`);
  }
});

test('每一筆「路線＋恰好帶該路線工具＋物資」的星等與主要拒絕原因都和腳本一致', () => {
  let compared = 0;
  for (const row of golden.rows) {
    const seed = SEEDS[row.seed];
    const tools = new Set(toolItems(seed));
    const tool = seed.routes[row.route].tool;
    const carriedTools = row.cargo.filter((c) => tools.has(c));
    const expectedTools = tool ? [tool] : [];
    if (carriedTools.join() !== expectedTools.join()) continue; // 工具隨路線自動上車，其他組合不存在於引擎中
    const items = row.cargo.filter((c) => !tools.has(c));
    const ev = evaluatePlan(seed, { route: row.route, items }, worlds[row.scenario]);
    const label = `${row.seed} ${row.scenario} ${row.route}+${row.cargo.join('+')}`;
    assert.equal(ev.stars, row.stars, label);
    assert.equal(ev.reasons[0] ? REASON_TEXT[ev.reasons[0]] : null, row.reason, label);
    compared++;
  }
  assert.ok(compared > 300, `只比對到 ${compared} 筆`);
});
