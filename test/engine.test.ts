// docs/06-TEST_PLAN 的引擎層自動測試（第一關保羅海難）。只測對外行為：createGame / apply / evaluate。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  applyAll,
  createGame,
  eliminationClueCount,
  evaluate,
  symbolCount,
  CRISIS_AT,
  HINT_AT,
  LOCK_OPENS_AT,
  TIME_UP_AT,
  type GameEvent,
  type GameState,
} from '../src/engine/game.ts';
import { makeSlots, makeEliminationClues, parseSymbol } from '../src/engine/symbols.ts';
import type { CardId, ItemId } from '../src/engine/seeds.ts';

const ALL: ItemId[] = ['糧食', '纜索', '錨', '麥子', '器具', '小船'];

function newGame(opts: { players?: number; firstRound?: boolean; a?: CardId; b?: CardId } = {}): GameState {
  const players = opts.players ?? 6;
  return createGame({
    seedId: 'ship 001',
    playerCount: players,
    firstRound: opts.firstRound ?? false,
    slots: makeSlots(symbolCount(players), 42),
    cards: { a: opts.a ?? 'A5', b: opts.b ?? 'B4' },
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

function afterCrisis(opts: Parameters<typeof newGame>[0] = {}): GameState {
  let s = newGame(opts);
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  return repairAll(s);
}

test('開局：6 樣東西全在船上、總重 13、超重 7；危機前就能看到超重', () => {
  const s = newGame();
  assert.deepEqual(s.plan.items, ALL);
  const ev = evaluate(s);
  assert.equal(ev.weight, 13);
  assert.equal(ev.cap, 6);
  assert.equal(ev.overweight, 7);
  assert.deepEqual(ev.reasons, ['OVERWEIGHT']);
});

test('危機前：留糧食＋纜索＋錨＝6，三件都顧好，可以「決定好了」並觸發危機；載重變 4', () => {
  let s = keep(newGame(), ['糧食', '纜索', '錨'], 70_000);
  const ev = evaluate(s);
  assert.equal(ev.weight, 6);
  assert.equal(ev.stars, 3);
  s = apply(s, { type: 'lock', at: 70_000 });
  assert.equal(s.phase, 'blackout');
  assert.equal(s.crisisCause, 'lock');
  assert.equal(evaluate(s).cap, 4);
  assert.equal(evaluate(s).overweight, 2);
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

test('危機後未吃飯最高兩星；纜索＋錨（4）與糧食＋纜索（3）都是兩星；三樣超重', () => {
  let s = afterCrisis();
  assert.equal(s.phase, 'replanning');
  s = keep(s, ['糧食', '纜索', '錨']);
  assert.deepEqual(evaluate(s).reasons, ['OVERWEIGHT']);
  for (const k of [['纜索', '錨'], ['糧食', '纜索']] as ItemId[][]) {
    const t = keep(s, k);
    assert.deepEqual(evaluate(t).reasons, []);
    assert.equal(evaluate(t).stars, 2);
  }
});

test('突破口：吃飯要糧食在船上；吃過後糧食離船、力氣顧好，纜索＋錨三星；只能吃一次', () => {
  let s = keep(afterCrisis(), ['纜索', '錨']);
  s = apply(s, { type: 'eat', at: s.now + 1000 });
  assert.deepEqual(s.lastRejection?.reasons, ['NO_FOOD']);
  assert.equal(s.fed, false);
  s = keep(s, ['糧食', '纜索', '錨']);
  s = apply(s, { type: 'eat', at: s.now + 1000 });
  assert.equal(s.fed, true);
  assert.deepEqual(s.plan.items, ['纜索', '錨']);
  const ev = evaluate(s);
  assert.equal(ev.weight, 4);
  assert.equal(ev.stars, 3);
  s = apply(s, { type: 'eat', at: s.now + 1000 });
  assert.deepEqual(s.lastRejection?.reasons, ['ALREADY_FED']);
  s = apply(s, { type: 'depart', at: s.now + 1000 });
  assert.equal(s.phase, 'settled');
  assert.equal(s.result!.stars, 3);
});

test('黑暗中不能吃飯、不能衝向海灘；結算只一次', () => {
  let s = apply(newGame(), { type: 'tick', at: CRISIS_AT });
  s = apply(s, { type: 'eat', at: CRISIS_AT + 1000 });
  assert.deepEqual(s.lastRejection?.reasons, ['NOT_POWERED']);
  s = apply(s, { type: 'depart', at: CRISIS_AT + 2000 });
  assert.ok(s.lastRejection?.reasons.includes('NOT_POWERED'));
  s = keep(repairAll(s), ['纜索']);
  s = apply(s, { type: 'depart', at: s.now + 1000 });
  assert.equal(s.result!.stars, 1);
  const again = apply(keep(s, ['纜索', '錨']), { type: 'depart', at: s.now + 2000 });
  assert.equal(again.result!.stars, 1);
});

test('零件也能衝向海灘（大家照樣上岸）', () => {
  let s = keep(afterCrisis(), []);
  s = apply(s, { type: 'depart', at: s.now + 1000 });
  assert.equal(s.phase, 'settled');
  assert.equal(s.result!.stars, 0);
});

test('故事卡 A1：危機前麥子丟不掉；風暴變大後就能丟', () => {
  let s = newGame({ a: 'A1' });
  s = apply(s, { type: 'setItem', at: 1000, item: '麥子', on: false });
  assert.deepEqual(s.lastRejection?.reasons, ['PINNED']);
  assert.ok(s.plan.items.includes('麥子'));
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  s = repairAll(s);
  s = apply(s, { type: 'setItem', at: s.now, item: '麥子', on: false });
  assert.ok(!s.plan.items.includes('麥子'));
});

test('故事卡 A3／A4：糧食變輕；纜索綁好後船身已顧好、纜索不在船上', () => {
  const a3 = keep(newGame({ a: 'A3' }), ['糧食']);
  assert.equal(evaluate(a3).weight, 1);
  const a4 = newGame({ a: 'A4' });
  assert.ok(!a4.plan.items.includes('纜索'));
  const k = keep(a4, ['糧食', '錨']);
  assert.equal(evaluate(k).stars, 3);
  assert.equal(evaluate(k).weight, 5);
});

test('故事卡 A5：補船多 10 秒', () => {
  const plain = apply(newGame({ a: 'A2' }), { type: 'tick', at: CRISIS_AT });
  const helped = apply(newGame({ a: 'A5' }), { type: 'tick', at: CRISIS_AT });
  assert.equal(helped.repair!.limitMs - plain.repair!.limitMs, 10_000);
});

test('風暴卡 B1／B2：補好船時器具、小船自動離船，麥子變輕；B3 糧食變重', () => {
  const b1 = afterCrisis({ b: 'B1' });
  assert.ok(!b1.plan.items.includes('器具'));
  assert.ok(b1.log.some((l) => l.kind === 'card' && (l.data!.gone as string[]).includes('器具')));
  assert.equal(evaluate(keep(b1, ['麥子'])).weight, 1);
  const b2 = afterCrisis({ b: 'B2' });
  assert.ok(!b2.plan.items.includes('小船'));
  const b3 = afterCrisis({ b: 'B3' });
  assert.equal(evaluate(keep(b3, ['糧食'])).weight, 3);
  // 黑暗中還沒翻開風暴卡
  const dark = apply(newGame({ b: 'B2' }), { type: 'tick', at: CRISIS_AT });
  assert.ok(dark.plan.items.includes('小船'));
});

test('風暴卡 B5：補好船 20 秒內還在等天亮', () => {
  let s = keep(afterCrisis({ b: 'B5' }), ['纜索', '錨']);
  const t = s.powerAt!;
  s = apply(s, { type: 'depart', at: t + 10_000 });
  assert.deepEqual(s.lastRejection?.reasons, ['WAIT_DAWN']);
  s = apply(s, { type: 'depart', at: t + 20_000 });
  assert.equal(s.phase, 'settled');
});

test('2:15 方向提示：還沒排到三件才出現一次；A1（危機前不可能三星）不出現', () => {
  const s = apply(newGame(), { type: 'tick', at: HINT_AT });
  assert.equal(s.hint.shown, true);
  const good = apply(keep(newGame(), ['糧食', '纜索', '錨'], 1000), { type: 'tick', at: HINT_AT });
  assert.equal(good.hint.shown, false);
  const a1 = apply(newGame({ a: 'A1' }), { type: 'tick', at: HINT_AT });
  assert.equal(a1.hint.shown, false);
});

test('8:00 時間到：補好且不超重自動衝向海灘，否則友善結束', () => {
  let s = keep(afterCrisis(), ['纜索', '錨']);
  s = apply(s, { type: 'tick', at: TIME_UP_AT });
  assert.equal(s.phase, 'settled');
  assert.equal(s.result!.cause, 'time_up');
  let t = keep(afterCrisis(), ALL);
  t = apply(t, { type: 'tick', at: TIME_UP_AT });
  assert.equal(t.phase, 'ended');
  const dark = apply(apply(newGame(), { type: 'tick', at: CRISIS_AT }), { type: 'tick', at: TIME_UP_AT });
  assert.equal(dark.phase, 'ended');
});

test('撈回：丟進海裡的東西可以撈回，順序維持固定', () => {
  let s = keep(newGame(), ['錨']);
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
