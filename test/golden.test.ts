// 規則引擎與 tools/verify_seeds.py 逐筆一致（ADR-0002、ADR-0006）。
// 對照檔由 `python3 tools/verify_seeds.py --export test/fixtures/verify_seeds_golden.json` 產生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePlan, REASON_TEXT, type World } from '../src/engine/rules.ts';
import { SEEDS, type CardId, type ItemId, type SeedId } from '../src/engine/seeds.ts';

interface Row { seed: SeedId; cards: CardId[]; scenario: string; kept: ItemId[]; stars: number; reason: string | null }
const golden = JSON.parse(readFileSync(new URL('./fixtures/verify_seeds_golden.json', import.meta.url), 'utf8')) as {
  seeds: Record<string, { weights: Record<string, number>; cap_pre: number; cap_post: number }>;
  rows: Row[];
};

const worlds: Record<string, Omit<World, 'cards'>> = {
  危機前: { crisis: false, powerOn: true, fed: false },
  危機後: { crisis: true, powerOn: true, fed: false },
  '危機後＋吃飯': { crisis: true, powerOn: true, fed: true },
};

test('種子數值與腳本相同（重量、載重）', () => {
  for (const [id, s] of Object.entries(golden.seeds)) {
    const seed = SEEDS[id as SeedId];
    assert.deepEqual(seed.weights, s.weights);
    assert.equal(seed.capPre, s.cap_pre);
    assert.equal(seed.capPost, s.cap_post);
  }
});

test('每一種故事卡組合 × 情境 × 留下的東西：星等與拒絕原因都和腳本一致', () => {
  for (const row of golden.rows) {
    const ev = evaluatePlan(row.seed, { items: row.kept }, { ...worlds[row.scenario], cards: row.cards });
    const label = `${row.cards.join('+')} ${row.scenario} ${row.kept.join('+')}`;
    assert.equal(ev.stars, row.stars, label);
    assert.equal(ev.reasons[0] ? REASON_TEXT[ev.reasons[0]] : null, row.reason, label);
  }
  assert.ok(golden.rows.length > 2900, `只比對到 ${golden.rows.length} 筆`);
});
