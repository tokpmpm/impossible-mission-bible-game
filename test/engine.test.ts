// docs/06-TEST_PLAN 的引擎層自動測試（第一關保羅海難）。只測對外行為：createGame / apply / evaluate。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  WRONG_PICK_LOCK_MS,
  applyAll,
  createGame,
  eliminationClueCount,
  evaluate,
  symbolCount,
  crisisAtFor,
  sweepWarning,
  usesNow,
  usesTonight,
  CRISIS_AT,
  HINT_AT,
  SWEEP_WARNING_MS,
  SAFE_MIN_STARS,
  isSafe,
  LOCK_OPENS_AT,
  TIME_UP_AT,
  type GameEvent,
  type GameState,
} from '../src/engine/game.ts';
import { makeSlots, makeEliminationClues, parseSymbol } from '../src/engine/symbols.ts';
import { CLASSIC, type CardId, type ItemId, type Tonight } from '../src/engine/seeds.ts';

const ALL: ItemId[] = ['糧食', '纜索', '錨', '麥子', '器具', '小船'];

function newGame(opts: { players?: number; firstRound?: boolean; a?: CardId; b?: CardId; tonight?: Partial<Tonight>; sweep?: boolean } = {}): GameState {
  const players = opts.players ?? 6;
  return createGame({
    seedId: 'ship 001',
    playerCount: players,
    firstRound: opts.firstRound ?? false,
    slots: makeSlots(symbolCount(players), 42),
    cards: { a: opts.a ?? 'A5', b: opts.b ?? 'B4' },
    tonight: { ...CLASSIC, ...opts.tonight },
    sweep: opts.sweep,
  });
}

/** 只留下 keep，其餘丟進海裡。 */
function keep(s: GameState, items: ItemId[], at = s.now): GameState {
  const evs: GameEvent[] = [];
  for (const i of ALL) evs.push({ type: 'setItem', at, item: i, on: items.includes(i) });
  return applyAll(s, evs);
}

function repairAll(s: GameState): GameState {
  for (const slot of s.repair!.slots) s = apply(s, { type: 'repairPick', at: s.now + 1000, option: slot.answer });
  return s;
}

/** 風暴前只留 pre（不給＝全部留著，首局式不捲走），然後起風暴、補好船。 */
function afterCrisis(opts: Parameters<typeof newGame>[0] = {}, pre?: ItemId[]): GameState {
  let s = newGame({ sweep: false, ...opts });
  if (pre) s = keep(s, pre, 1000);
  s = apply(s, { type: 'tick', at: crisisAtFor(s.cards) });
  return repairAll(s);
}

test('開局：6 樣東西全在船上、總重 15、超重 7；危機前就能看到超重', () => {
  const s = newGame();
  assert.deepEqual(s.plan.items, ALL);
  const ev = evaluate(s);
  assert.equal(ev.weight, 15);
  assert.equal(ev.cap, 8);
  assert.equal(ev.overweight, 7);
  assert.deepEqual(ev.reasons, ['OVERWEIGHT']);
});

test('經典配置危機前：糧食＋纜索＋錨＝8，三件都顧好；首局「決定好了」立刻起風暴；載重變 5', () => {
  let s = keep(newGame({ firstRound: true }), ['糧食', '纜索', '錨'], 70_000);
  const ev = evaluate(s);
  assert.equal(ev.weight, 8);
  assert.equal(ev.stars, 3);
  s = apply(s, { type: 'lock', at: 70_000 });
  assert.equal(s.phase, 'blackout');
  assert.equal(s.crisisCause, 'lock');
  assert.equal(evaluate(s).cap, 5);
  assert.equal(evaluate(s).overweight, 3);
});

test('前 60 秒不能決定；超重不能決定；拒絕次數會累計', () => {
  let s = keep(newGame(), ['糧食', '纜索', '錨'], 1000);
  s = apply(s, { type: 'lock', at: LOCK_OPENS_AT - 1 });
  assert.deepEqual(s.lastRejection?.reasons, ['TOO_EARLY']);
  assert.equal(s.phase, 'planning');
  s = keep(s, ['糧食', '纜索', '錨', '麥子'], LOCK_OPENS_AT);
  s = apply(s, { type: 'lock', at: LOCK_OPENS_AT });
  assert.deepEqual(s.lastRejection?.reasons, ['OVERWEIGHT']);
  assert.equal(s.rejections, 2);
});

test('2:45 沒決定也會起風暴，一局只一次；起風卡 A2 提早到 2:30', () => {
  let s = apply(newGame(), { type: 'tick', at: CRISIS_AT });
  assert.equal(s.phase, 'blackout');
  assert.equal(s.crisisCause, 'timeout');
  s = apply(s, { type: 'tick', at: CRISIS_AT + 5000 });
  assert.equal(s.log.filter((l) => l.kind === 'crisis').length, 1);
  const early = apply(newGame({ a: 'A2' }), { type: 'tick', at: CRISIS_AT - 15_000 });
  assert.equal(early.phase, 'blackout');
});

// ---------- 風暴捲走（DECISIONS 16）----------

test('首局不捲走：危機前丟的東西，補好船後還能撈回來', () => {
  let s = afterCrisis({ firstRound: true }, ['纜索', '錨']);
  assert.equal(s.sweep, false);
  assert.deepEqual(s.swept, []);
  s = apply(s, { type: 'setItem', at: s.now, item: '糧食', on: true });
  assert.ok(s.plan.items.includes('糧食'));
});

test('第二局起捲走：危機前丟的東西被浪捲走，撈不回來；危機後丟的到出發前都能撈回', () => {
  let s = newGame({ firstRound: false });
  assert.equal(s.sweep, true);
  s = keep(s, ['糧食', '纜索', '錨'], 1000);
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  assert.deepEqual(s.swept, ['麥子', '器具', '小船']);
  assert.ok(s.log.some((l) => l.kind === 'swept'));
  s = repairAll(s);
  s = apply(s, { type: 'setItem', at: s.now, item: '麥子', on: true });
  assert.deepEqual(s.lastRejection?.reasons, ['SWEPT']);
  assert.ok(!s.plan.items.includes('麥子'));
  s = apply(s, { type: 'setItem', at: s.now + 10, item: '糧食', on: false });
  s = apply(s, { type: 'setItem', at: s.now + 10, item: '糧食', on: true });
  assert.ok(s.plan.items.includes('糧食'));
});

test('捲走前 10 秒提醒：到時（2:35）才出現，列出漂著的東西；首局沒有提醒', () => {
  let s = keep(newGame(), ['糧食', '纜索', '錨'], 1000);
  s = apply(s, { type: 'tick', at: CRISIS_AT - SWEEP_WARNING_MS - 1 });
  assert.equal(sweepWarning(s), null);
  s = apply(s, { type: 'tick', at: CRISIS_AT - SWEEP_WARNING_MS });
  assert.deepEqual(sweepWarning(s), { inMs: SWEEP_WARNING_MS, floating: ['麥子', '器具', '小船'], extra: [], overweight: 0 });
  assert.ok(s.log.some((l) => l.kind === 'storm_warning' && l.at === CRISIS_AT - SWEEP_WARNING_MS));
  // 提醒期間撈回來的不會被捲走
  s = apply(s, { type: 'setItem', at: CRISIS_AT - 3000, item: '器具', on: true });
  assert.deepEqual(evaluate(s).reasons, ['OVERWEIGHT']);
  s = apply(s, { type: 'setItem', at: CRISIS_AT - 2000, item: '糧食', on: false });
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  assert.deepEqual(s.swept, ['糧食', '麥子', '小船']);
  const first = apply(newGame({ firstRound: true }), { type: 'tick', at: CRISIS_AT - 1000 });
  assert.equal(sweepWarning(first), null);
  assert.ok(!first.log.some((l) => l.kind === 'storm_warning'));
});

test('捲走預警（docs/15 H1）：還超重時，預警列出的（漂著的＋超重先捲走的）＝實際捲走的', () => {
  // 第二局只丟小船：留 13、限 8，超重 5
  let s = keep(newGame(), ['糧食', '纜索', '錨', '麥子', '器具'], 1000);
  s = apply(s, { type: 'tick', at: CRISIS_AT - SWEEP_WARNING_MS });
  const w = sweepWarning(s)!;
  assert.deepEqual(w.floating, ['小船']);
  assert.equal(w.overweight, 5);
  assert.ok(w.extra.length > 0, '超重時要列出會先被捲走的東西');
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  assert.deepEqual([...s.swept].sort(), [...w.floating, ...w.extra].sort());
  // 不同組合都一致：窮舉 6 樣東西的留法
  const items = ['糧食', '纜索', '錨', '麥子', '器具', '小船'] as const;
  for (let mask = 0; mask < 64; mask++) {
    const kept = items.filter((_, i) => mask & (1 << i));
    let g = keep(newGame(), [...kept], 1000);
    g = apply(g, { type: 'tick', at: CRISIS_AT - 1 });
    const p = sweepWarning(g)!;
    g = apply(g, { type: 'tick', at: CRISIS_AT });
    assert.deepEqual([...g.swept].sort(), [...p.floating, ...p.extra].sort(), `留 ${kept.join('、')}`);
  }
});

test('補船選錯：面板鎖 2.5 秒（按了不算、不多記選錯），之後照常', () => {
  let s = keep(newGame({ firstRound: true }), ['糧食', '纜索', '錨'], 1000);
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  const slot = s.repair!.slots[0];
  const bad = slot.options.find((o) => o !== slot.answer)!;
  s = apply(s, { type: 'repairPick', at: CRISIS_AT + 1000, option: bad });
  assert.equal(s.repair!.wrongPicks, 1);
  assert.equal(s.repair!.lockedUntil, CRISIS_AT + 1000 + WRONG_PICK_LOCK_MS);
  s = apply(s, { type: 'repairPick', at: CRISIS_AT + 2000, option: slot.answer });
  assert.equal(s.repair!.progress, 0, '鎖住時選對也不算');
  assert.deepEqual(s.lastRejection?.reasons, ['PANEL_LOCKED']);
  assert.equal(s.repair!.wrongPicks, 1);
  s = apply(s, { type: 'repairPick', at: CRISIS_AT + 1000 + WRONG_PICK_LOCK_MS, option: slot.answer });
  assert.equal(s.repair!.progress, 1);
});

test('第二局起「決定好了」：先提醒 10 秒（還能撈回），10 秒後才起風暴', () => {
  let s = keep(newGame(), ['糧食', '纜索', '錨'], 70_000);
  s = apply(s, { type: 'lock', at: 70_000 });
  assert.equal(s.phase, 'planning');
  assert.equal(s.locked, true);
  assert.equal(sweepWarning(s)?.inMs, SWEEP_WARNING_MS);
  s = apply(s, { type: 'lock', at: 71_000 });
  assert.deepEqual(s.lastRejection?.reasons, ['WRONG_PHASE']);
  s = apply(s, { type: 'tick', at: 80_000 });
  assert.equal(s.phase, 'blackout');
  assert.equal(s.crisisCause, 'lock');
  assert.equal(s.crisisAt, 80_000);
});

test('起風暴時還超重：浪從最重的開始捲走，同重從畫面右邊開始，直到不超重', () => {
  let s = apply(newGame(), { type: 'tick', at: CRISIS_AT }); // 全部留著＝15，載重 8
  // 3 重：麥子、錨、糧食（右到左）；先捲走麥子（12）、錨（9）、糧食（6）
  assert.deepEqual(s.swept, ['糧食', '錨', '麥子']);
  assert.deepEqual(s.plan.items, ['纜索', '器具', '小船']);
});

// ---------- 見聞與三種用掉 ----------

test('經典配置危機後：不用掉最高兩星；吃飯後糧食離船、力氣顧好，纜索＋錨（5）三星', () => {
  let s = afterCrisis({}, ['糧食', '纜索', '錨']);
  assert.equal(s.phase, 'replanning');
  assert.deepEqual(evaluate(s).reasons, ['OVERWEIGHT']);
  assert.equal(evaluate(keep(s, ['纜索', '錨'])).stars, 2);
  assert.deepEqual(usesNow(s), ['吃飯', '捆船底']); // 水深：不能拋錨
  s = apply(s, { type: 'use', at: s.now + 1000, use: '吃飯' });
  assert.deepEqual(s.used, { use: '吃飯', item: '糧食', at: s.now });
  assert.deepEqual(s.plan.items, ['纜索', '錨']);
  const ev = evaluate(s);
  assert.equal(ev.weight, 5);
  assert.equal(ev.stars, 3);
  s = apply(s, { type: 'depart', at: s.now + 1000 });
  assert.equal(s.result!.stars, 3);
});

test('今晚靠麥子：糧食不顧力氣，麥子才顧；吃飯吃掉的是麥子', () => {
  let s = afterCrisis({ tonight: { 食: '麥子' } }, ['纜索', '錨', '麥子']);
  assert.equal(evaluate(keep(s, ['糧食', '纜索'])).served.includes('力氣'), false);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '吃飯' });
  assert.equal(s.used?.item, '麥子');
  assert.equal(evaluate(s).stars, 3);
});

test('今晚靠器具的繩子：捆船底用掉器具，船身顧好；纜索今晚沒用', () => {
  let s = afterCrisis({ tonight: { 繩: '器具' } }, ['糧食', '錨', '器具']);
  assert.equal(evaluate(keep(s, ['纜索', '錨'])).served.includes('船身'), false);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '捆船底' });
  assert.equal(s.used?.item, '器具');
  s = keep(s, ['錨'], s.now);
  s = apply(s, { type: 'setItem', at: s.now, item: '糧食', on: false });
  assert.deepEqual(evaluate(s).served, ['船身', '天亮']);
});

test('水淺可以拋錨（錨離船、天亮顧好）；水深不能拋；吃飯每局都能做（沒有「吃不下」）', () => {
  let s = afterCrisis({ tonight: { 水: '淺' } }, ['糧食', '纜索', '錨']);
  assert.deepEqual(usesNow(s), ['吃飯', '捆船底', '拋錨']);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '拋錨' });
  assert.deepEqual(s.plan.items, ['糧食', '纜索']);
  // 拋了錨就不能吃飯：糧食留著不算力氣，只剩二星
  assert.deepEqual(evaluate(s).served, ['船身', '天亮']);
  let deep = afterCrisis({}, ['糧食', '纜索', '錨']);
  assert.deepEqual(usesTonight(deep), ['吃飯', '捆船底']);
  deep = apply(deep, { type: 'use', at: deep.now + 1000, use: '拋錨' });
  assert.deepEqual(deep.lastRejection?.reasons, ['CANNOT_TONIGHT']);
});

test('力氣只能靠吃飯（DECISIONS 18）：糧食留在船上不算力氣，吃了才算', () => {
  let s = afterCrisis({}, ['糧食', '纜索', '錨']);
  assert.deepEqual(evaluate(keep(s, ['糧食', '纜索'])).served, ['船身']);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '吃飯' });
  assert.equal(s.used?.item, '糧食');
  assert.deepEqual(evaluate(s).served, ['力氣', '船身', '天亮']);
});

test('天亮前只來得及做一件（吃飯也算）；東西不在船上不能用掉；沒有取消', () => {
  let s = afterCrisis({ tonight: { 水: '淺' } }, ['糧食', '纜索', '錨']);
  s = keep(s, ['纜索', '錨']);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '吃飯' });
  assert.deepEqual(s.lastRejection?.reasons, ['NO_ITEM']);
  s = keep(s, ['糧食', '纜索', '錨']);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '吃飯' });
  s = apply(s, { type: 'use', at: s.now + 500, use: '拋錨' });
  assert.deepEqual(s.lastRejection?.reasons, ['ALREADY_USED']);
  assert.equal(s.used?.use, '吃飯');
});

test('顧好 0–1 件＝沒能平安上岸；2 件以上平安；時間到還沒出發也算沒能平安上岸', () => {
  assert.equal(SAFE_MIN_STARS, 2);
  let one = keep(afterCrisis(), ['纜索']);
  one = apply(one, { type: 'depart', at: one.now + 1000 });
  assert.equal(one.result!.stars, 1);
  assert.equal(one.result!.safe, false);
  assert.equal(isSafe(one), false);
  let two = keep(afterCrisis(), ['纜索', '錨']);
  two = apply(two, { type: 'depart', at: two.now + 1000 });
  assert.equal(two.result!.safe, true);
  assert.equal(isSafe(two), true);
  let late = apply(newGame({ sweep: false }), { type: 'tick', at: CRISIS_AT });
  late = apply(late, { type: 'tick', at: TIME_UP_AT });
  assert.equal(late.phase, 'ended');
  assert.equal(isSafe(late), false);
  assert.equal(isSafe(newGame()), null);
});

test('黑暗中不能用掉、不能衝向海灘；結算只一次', () => {
  let s = apply(newGame({ sweep: false }), { type: 'tick', at: CRISIS_AT });
  s = apply(s, { type: 'use', at: CRISIS_AT + 1000, use: '吃飯' });
  assert.deepEqual(s.lastRejection?.reasons, ['NOT_POWERED']);
  s = apply(s, { type: 'depart', at: CRISIS_AT + 2000 });
  assert.ok(s.lastRejection?.reasons.includes('NOT_POWERED'));
  s = keep(repairAll(s), ['纜索']);
  s = apply(s, { type: 'depart', at: s.now + 1000 });
  assert.equal(s.result!.stars, 1);
  const again = apply(keep(s, ['纜索', '錨']), { type: 'depart', at: s.now + 2000 });
  assert.equal(again.result!.stars, 1);
});

test('零件也能衝向海灘（但這局沒能平安上岸）', () => {
  let s = keep(afterCrisis(), []);
  s = apply(s, { type: 'depart', at: s.now + 1000 });
  assert.equal(s.phase, 'settled');
  assert.equal(s.result!.stars, 0);
  assert.equal(s.result!.safe, false);
});

test('故事卡和見聞不能同局時拒絕開局（A4 只配繩＝纜索、B3 不配今晚靠麥子）', () => {
  assert.throws(() => newGame({ a: 'A4', tonight: { 繩: '器具' } }));
  assert.throws(() => newGame({ b: 'B3', tonight: { 食: '麥子' } }));
});

test('故事卡 A1：危機前麥子丟不掉；風暴變大後就能丟', () => {
  let s = newGame({ a: 'A1', tonight: { 食: '麥子' }, sweep: false });
  s = apply(s, { type: 'setItem', at: 1000, item: '麥子', on: false });
  assert.deepEqual(s.lastRejection?.reasons, ['PINNED']);
  assert.ok(s.plan.items.includes('麥子'));
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  s = repairAll(s);
  s = apply(s, { type: 'setItem', at: s.now, item: '麥子', on: false });
  assert.ok(!s.plan.items.includes('麥子'));
});

test('故事卡 A3／A4：糧食變輕（3→2）；纜索綁好後船身已顧好、纜索不在船上', () => {
  const a3 = keep(newGame({ a: 'A3' }), ['糧食']);
  assert.equal(evaluate(a3).weight, 2);
  const a4 = newGame({ a: 'A4' });
  assert.ok(!a4.plan.items.includes('纜索'));
  const k = keep(a4, ['糧食', '錨']);
  assert.equal(evaluate(k).stars, 3);
  assert.equal(evaluate(k).weight, 6);
});

test('故事卡 A5：補船多 10 秒', () => {
  const plain = apply(newGame({ a: 'A2' }), { type: 'tick', at: CRISIS_AT });
  const helped = apply(newGame({ a: 'A5' }), { type: 'tick', at: CRISIS_AT });
  assert.equal(helped.repair!.limitMs - plain.repair!.limitMs, 10_000);
});

test('風暴卡 B1／B2／B3：補好船時器具、小船、麥子自動離船，B1 麥子變輕', () => {
  const b1 = afterCrisis({ b: 'B1' });
  assert.ok(!b1.plan.items.includes('器具'));
  assert.ok(b1.log.some((l) => l.kind === 'card' && (l.data!.gone as string[]).includes('器具')));
  assert.equal(evaluate(keep(b1, ['麥子'])).weight, 1);
  const b2 = afterCrisis({ b: 'B2' });
  assert.ok(!b2.plan.items.includes('小船'));
  const b3 = afterCrisis({ b: 'B3' });
  assert.ok(!b3.plan.items.includes('麥子'));
  assert.equal(evaluate(keep(b3, ['糧食'])).weight, 3);
  // 黑暗中還沒翻開風暴卡
  const dark = apply(newGame({ b: 'B2' }), { type: 'tick', at: CRISIS_AT });
  assert.ok(dark.plan.items.includes('小船') || dark.swept.includes('小船'));
});

test('風暴卡 B5：錨已拋下（等天亮顧好、錨離船、不能再拋）；力氣一樣要真的吃', () => {
  let s = afterCrisis({ b: 'B5', tonight: { 水: '淺' } });
  assert.ok(!s.plan.items.includes('錨'));
  assert.ok(!usesTonight(s).includes('拋錨'));
  s = keep(s, ['糧食', '纜索']);
  let ev = evaluate(s);
  assert.deepEqual(ev.served, ['船身', '天亮']);
  assert.equal(ev.stars, 2);
  s = apply(s, { type: 'use', at: s.now + 1000, use: '吃飯' });
  ev = evaluate(s);
  assert.equal(ev.stars, 3);
  assert.equal(ev.weight, 2);
});

test('2:15 方向提示：還沒排到三件才出現一次（看的是這局的見聞）', () => {
  const s = apply(newGame(), { type: 'tick', at: HINT_AT });
  assert.equal(s.hint.shown, true);
  const good = apply(keep(newGame(), ['糧食', '纜索', '錨'], 1000), { type: 'tick', at: HINT_AT });
  assert.equal(good.hint.shown, false);
  const wheat = apply(keep(newGame({ tonight: { 食: '麥子' } }), ['糧食', '纜索', '錨'], 1000), { type: 'tick', at: HINT_AT });
  assert.equal(wheat.hint.shown, true);
});

test('8:00 時間到：補好且不超重自動衝向海灘，否則友善結束', () => {
  let s = keep(afterCrisis(), ['纜索', '錨']);
  s = apply(s, { type: 'tick', at: TIME_UP_AT });
  assert.equal(s.phase, 'settled');
  assert.equal(s.result!.cause, 'time_up');
  let t = keep(afterCrisis(), ALL);
  t = apply(t, { type: 'tick', at: TIME_UP_AT });
  assert.equal(t.phase, 'ended');
  const dark = apply(apply(newGame({ sweep: false }), { type: 'tick', at: CRISIS_AT }), { type: 'tick', at: TIME_UP_AT });
  assert.equal(dark.phase, 'ended');
});

test('撈回：丟進海裡的東西可以撈回，順序維持固定', () => {
  let s = keep(newGame(), ['錨'], 500);
  s = apply(s, { type: 'setItem', at: 1000, item: '糧食', on: true });
  assert.deepEqual(s.plan.items, ['糧食', '錨']);
});

test('補船記號數與排除線索名額：3／4／5／10 人', () => {
  assert.deepEqual([3, 4, 5, 10].map(symbolCount), [2, 3, 4, 4]);
  assert.deepEqual([3, 4, 5, 6, 10].map(eliminationClueCount), [0, 0, 0, 1, 5]);
  const slots = makeSlots(4, 7);
  const clues = makeEliminationClues(slots, 5, 7);
  assert.equal(new Set(clues).size, 5);
  for (const clue of clues) {
    const n = Number(clue.match(/第 (\d) 格/)![1]) - 1;
    const ans = parseSymbol(slots[n].answer);
    if (clue.includes('缺口')) assert.ok(!clue.includes(`沒有 ${ans.gaps} 個`));
    if (clue.includes('開口')) assert.ok(!clue.endsWith(`朝${ans.dir}。`));
  }
});

test('補船 45／60 秒逾時進入協助模式，仍修得好；選錯不扣時間；首局多 15 秒', () => {
  for (const [players, limit] of [[3, 45_000], [6, 60_000]] as const) {
    let s = apply(newGame({ players, a: 'A2' }), { type: 'tick', at: CRISIS_AT });
    assert.equal(s.repair!.limitMs, limit);
    const start = s.crisisAt!;
    const wrong = s.repair!.slots[0].options.find((o) => o !== s.repair!.slots[0].answer)!;
    s = apply(s, { type: 'repairPick', at: start + 1000, option: wrong });
    assert.equal(s.repair!.progress, 0);
    s = apply(s, { type: 'tick', at: start + limit });
    assert.equal(s.repair!.assistLevel, 1);
    s = apply(s, { type: 'tick', at: start + limit + 15_000 });
    assert.equal(s.repair!.assistLevel, 2);
    for (const g of s.repair!.grayed) assert.equal(g.length, 7);
    assert.equal(repairAll(s).phase, 'replanning');
  }
  const first = apply(newGame({ firstRound: true, a: 'A2' }), { type: 'tick', at: CRISIS_AT });
  assert.equal(first.repair!.limitMs, 75_000);
});

test('油燈（排除能力）只能用一次，灰掉目前那格 2 個錯誤選項', () => {
  let s = apply(newGame(), { type: 'tick', at: CRISIS_AT });
  s = apply(s, { type: 'useEliminate', at: CRISIS_AT + 1000 });
  assert.equal(s.repair!.grayed[0].length, 2);
  assert.ok(!s.repair!.grayed[0].includes(s.repair!.slots[0].answer));
  s = apply(s, { type: 'useEliminate', at: CRISIS_AT + 2000 });
  assert.deepEqual(s.lastRejection?.reasons, ['WRONG_PHASE']);
});
