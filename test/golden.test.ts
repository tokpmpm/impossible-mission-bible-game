// 規則引擎與 tools/verify_seeds.py 逐筆一致（ADR-0002、ADR-0006、ADR-0007）。
// 對照檔由 `npm run golden`（python3 tools/verify_seeds.py --export test/fixtures/verify_seeds_golden.json）產生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { apply, createGame, symbolCount, type GameEvent, type GameState } from '../src/engine/game.ts';
import { evaluatePlan, usesAvailable, validSetups, REASON_TEXT, type World } from '../src/engine/rules.ts';
import { CLASSIC, ITEMS, SEEDS, USE_ENABLED, type CardId, type ItemId, type Tonight, type UseId } from '../src/engine/seeds.ts';
import { makeSlots } from '../src/engine/symbols.ts';

interface Game { b: CardId; post: Record<string, string>; line: { keep: ItemId[]; use: UseId | null; land: ItemId[] } }
interface SetupRow { a: CardId; tonight: Tonight; b: CardId[]; pre: string; robust: ItemId[][]; games: Game[] }
const golden = JSON.parse(readFileSync(new URL('./fixtures/verify_seeds_golden.json', import.meta.url), 'utf8')) as {
  items: ItemId[];
  weights: Record<ItemId, number>;
  cap_pre: number;
  cap_post: number;
  uses: number;
  use_enabled: UseId[];
  classic: Tonight;
  metrics: Record<string, number | boolean>;
  setups: SetupRow[];
};
const seed = SEEDS['ship 001'];
const masks = (m: number) => ITEMS.filter((_, i) => (m >> i) & 1);

/** 64 種留法各一個字元：'0'–'3'＝可出發的星數；'a'–'d'＝超重時的星數（與腳本 encode() 相同）。 */
function encode(world: World): string {
  let out = '';
  for (let m = 0; m < 64; m++) {
    const ev = evaluatePlan(seed, { items: masks(m) }, world);
    const over = ev.reasons[0] ? REASON_TEXT[ev.reasons[0]] === '超重' : false;
    out += over ? 'abcd'[ev.stars] : String(ev.stars);
  }
  return out;
}

test('種子數值與腳本相同（東西順序、重量、載重、只來得及用掉幾件、經典配置）', () => {
  assert.deepEqual(golden.items, ITEMS);
  assert.deepEqual(seed.weights, golden.weights);
  assert.equal(seed.capPre, golden.cap_pre);
  assert.equal(seed.capPost, golden.cap_post);
  assert.equal(seed.uses, golden.uses);
  assert.deepEqual(USE_ENABLED, golden.use_enabled);
  assert.deepEqual(CLASSIC, golden.classic);
});

test('通過的起風卡×見聞與允許的風暴卡：引擎算出的表和腳本完全一樣（64 種、262 局面）', () => {
  const mine = validSetups().map((s) => ({ a: s.a, tonight: s.tonight, b: s.b }));
  const theirs = golden.setups.map((s) => ({ a: s.a, tonight: s.tonight, b: s.b }));
  assert.deepEqual(mine, theirs);
  assert.equal(mine.length, 64);
  assert.equal(mine.reduce((n, s) => n + s.b.length, 0), 262);
});

test('每一種局面 × 危機前／補好船後（不用掉、三種用掉）× 64 種留法：星等與超重都和腳本一致', () => {
  let rows = 0;
  for (const s of golden.setups) {
    const pre: World = { crisis: false, powerOn: true, cards: [s.a], tonight: s.tonight, used: null };
    assert.equal(encode(pre), s.pre, `${s.a} ${JSON.stringify(s.tonight)} 危機前`);
    rows += 64;
    for (const g of s.games) {
      const avail = usesAvailable(seed, [s.a, g.b], s.tonight, ITEMS);
      assert.deepEqual(['無', ...avail], Object.keys(g.post), `${s.a}+${g.b} 能用掉的`);
      for (const [use, code] of Object.entries(g.post)) {
        const world: World = { crisis: true, powerOn: true, cards: [s.a, g.b], tonight: s.tonight, used: use === '無' ? null : (use as UseId) };
        assert.equal(encode(world), code, `${s.a}+${g.b} ${JSON.stringify(s.tonight)} ${use}`);
        rows += 64;
      }
    }
  }
  assert.equal(rows, 57_408, `只比對到 ${rows} 筆`);
});

/** 用狀態機把腳本給的三星打法整局走一遍（第二局起：風暴捲走）。 */
function play(s: SetupRow, g: Game, line: Game['line']): GameState {
  const players = 6;
  let st = createGame({ seedId: 'ship 001', playerCount: players, firstRound: false, slots: makeSlots(symbolCount(players), 7), cards: { a: s.a, b: g.b }, tonight: s.tonight, lockOpensAt: 0 });
  let t = 1000;
  const ev = (e: GameEvent) => (st = apply(st, e));
  for (const i of ITEMS) ev({ type: 'setItem', at: t, item: i, on: line.keep.includes(i) });
  ev({ type: 'lock', at: (t += 1000) });
  assert.equal(st.phase, 'planning', '決定好了以後還有 10 秒提醒');
  ev({ type: 'tick', at: (t += 10_000) });
  assert.equal(st.phase, 'blackout');
  for (const slot of st.repair!.slots) ev({ type: 'repairPick', at: (t += 500), option: slot.answer });
  assert.equal(st.phase, 'replanning');
  if (line.use) ev({ type: 'use', at: (t += 500), use: line.use });
  for (const i of ITEMS) ev({ type: 'setItem', at: (t += 10), item: i, on: line.land.includes(i) });
  ev({ type: 'depart', at: (t += 4000) });
  return st;
}

test('262 種局面：腳本給的三星打法在狀態機裡整局走完都是三星', () => {
  let n = 0;
  for (const s of golden.setups) {
    for (const g of s.games) {
      const st = play(s, g, g.line);
      assert.equal(st.result?.stars, 3, `${s.a}+${g.b} ${JSON.stringify(s.tonight)} ${JSON.stringify(g.line)}`);
      n++;
    }
  }
  assert.equal(n, 262);
});

test('docs/12 第 3 節的重玩性指標與腳本現在算出來的一致', () => {
  const live = JSON.parse(execFileSync('python3', ['tools/verify_seeds.py', '--metrics'], { encoding: 'utf8' })) as {
    tried: number; setups: number; games: number; three: number; two_floor: boolean; copy_best: number; copy_avg: number; fixed: number; blind: number; signatures: number;
  };
  assert.deepEqual(live, golden.metrics, '對照檔過期：請跑 npm run golden');
  const doc = readFileSync(new URL('../docs/12-REPLAYABILITY.md', import.meta.url), 'utf8');
  const sec3 = doc.slice(doc.indexOf('## 3.'), doc.indexOf('## 4.'));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const [label, text] of [
    ['通過組合', `**${live.setups} 種通過**`],
    ['試過組合', `${live.tried} 種中`],
    ['局面', `**${live.games}**`],
    ['三星有解', `${live.three}／${live.games}`],
    ['照抄成功率', `**${pct(live.copy_best)}**`],
    ['隨機三星打法', pct(live.copy_avg)],
    ['最強固定打法', pct(live.fixed)],
    ['不問隊友', pct(live.blind)],
    ['必帶組合', `${live.signatures} 種`],
  ] as const) assert.ok(sec3.includes(text), `docs/12 第 3 節找不到 ${label}「${text}」`);
  assert.equal(live.two_floor, true);
  assert.ok(live.copy_best < 0.2);
});

test('docs/appendix 設計試算與正式腳本列出的通過組合相同', () => {
  const out = execFileSync('python3', ['docs/appendix/replayability_sim.py', '--table'], { encoding: 'utf8' });
  const rows = out.split('\n').filter((l) => /^ {2}A[1-5] /.test(l)).map((l) => l.trim().split('｜').slice(0, 2).join('｜'));
  const mine = golden.setups.map((s) => `${s.a} ${Object.values(s.tonight).join('/')}｜${s.b.join('')}`);
  assert.deepEqual(rows, mine);
});
