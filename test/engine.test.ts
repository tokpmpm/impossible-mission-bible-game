// docs/06-TEST_PLAN 的引擎層自動測試（F04–F15、F21–F28）。只測對外行為：createGame / apply / evaluate。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  applyAll,
  createGame,
  eliminationClueCount,
  evaluate,
  repairLimitMs,
  symbolCount,
  CRISIS_AT,
  HINT_AT,
  LOCK_OPENS_AT,
  TIME_UP_AT,
  type GameEvent,
  type GameState,
} from '../src/engine/game.ts';
import { makeSlots, makeEliminationClues, parseSymbol } from '../src/engine/symbols.ts';
import type { SeedId } from '../src/engine/seeds.ts';

function newGame(seedId: SeedId, playerCount = 6, firstRound = false): GameState {
  return createGame({ seedId, playerCount, firstRound, slots: makeSlots(symbolCount(playerCount), 42), channel: '472' });
}

function plan(route: '紅' | '藍' | '綠', items: string[], at = 70_000): GameEvent[] {
  return [{ type: 'selectRoute', at, route }, ...items.map((item) => ({ type: 'setItem' as const, at, item, on: true }))];
}

function repairAll(s: GameState): GameState {
  for (const slot of s.repair!.slots) s = apply(s, { type: 'repairPick', at: s.now + 1000, option: slot.answer });
  return s;
}

function setPlan(s: GameState, route: '紅' | '藍' | '綠', items: string[]): GameState {
  for (const i of [...s.plan.items]) s = apply(s, { type: 'setItem', at: s.now, item: i, on: false });
  return applyAll(s, plan(route, items, s.now));
}

function afterCrisis(seedId: SeedId, playerCount = 6, firstRound = false): GameState {
  let s = newGame(seedId, playerCount, firstRound);
  s = apply(s, { type: 'tick', at: CRISIS_AT });
  return repairAll(s);
}

test('F04 seed 001：紅線＋藥水毯 7 kg 可鎖定；危機後紅線封閉，藍線二星、綠線開閘後三星', () => {
  let s = applyAll(newGame('seed 001'), plan('紅', ['藥品', '飲水', '毛毯']));
  assert.equal(evaluate(s).weight, 7);
  assert.equal(evaluate(s).reachable, 3);
  s = apply(s, { type: 'lock', at: 80_000 });
  assert.equal(s.locked, true);
  assert.equal(s.phase, 'blackout');
  assert.equal(s.crisisCause, 'lock');
  s = repairAll(s);
  assert.equal(s.phase, 'replanning');
  assert.deepEqual(evaluate(s).reasons, ['ROAD_CLOSED']);
  const blue = setPlan(s, '藍', ['藥品', '飲水']);
  assert.equal(evaluate(blue).stars, 2);
  let green = apply(s, { type: 'floodgate', at: s.now + 1000, channel: '472' });
  green = setPlan(green, '綠', ['藥品', '飲水', '毛毯']);
  assert.equal(evaluate(green).stars, 3);
});

test('F05 seed 001：鎖藍線或 2:45 未鎖定，危機都只觸發一次，紅線封閉、藍線仍可二星', () => {
  let a = applyAll(newGame('seed 001'), plan('藍', ['藥品', '飲水']));
  a = apply(a, { type: 'lock', at: 90_000 });
  a = apply(a, { type: 'tick', at: CRISIS_AT + 5000 });
  assert.equal(a.log.filter((l) => l.kind === 'crisis').length, 1);
  assert.equal(a.crisisAt, 90_000);

  let b = newGame('seed 001');
  b = apply(b, { type: 'tick', at: CRISIS_AT - 1 });
  assert.equal(b.phase, 'planning');
  b = apply(b, { type: 'lock', at: CRISIS_AT + 10 }); // 時間先到 → 危機已發生，鎖定無效
  assert.equal(b.crisisCause, 'timeout');
  assert.equal(b.crisisAt, CRISIS_AT);
  assert.equal(b.log.filter((l) => l.kind === 'crisis').length, 1);
  b = repairAll(b);
  b = setPlan(b, '紅', ['藥品', '飲水']);
  assert.ok(evaluate(b).reasons.includes('ROAD_CLOSED'));
  b = setPlan(b, '藍', ['藥品', '飲水']);
  b = apply(b, { type: 'depart', at: b.now + 1 });
  assert.equal(b.result?.stars, 2);
});

test('F06 初始選綠線不可鎖定，提示故事安全窗不足', () => {
  let s = applyAll(newGame('seed 001'), plan('綠', ['藥品', '飲水', '毛毯']));
  s = apply(s, { type: 'lock', at: 80_000 });
  assert.equal(s.phase, 'planning');
  assert.deepEqual(s.lastRejection?.reasons, ['GREEN_NOT_LOCKABLE']);
  assert.equal(evaluate(s).reachable, 0);
  assert.ok(evaluate(s).reasons.includes('TOO_LATE'));
});

test('鎖定前方案必須合法（超重不能鎖）', () => {
  let s = applyAll(newGame('seed 001'), plan('紅', ['藥品', '飲水', '毛毯', '食物']));
  s = apply(s, { type: 'lock', at: 80_000 });
  assert.equal(s.phase, 'planning');
  assert.deepEqual(s.lastRejection?.reasons, ['OVERWEIGHT']);
  assert.equal(evaluate(s).overweight, 2);
});

test('前 60 秒可以排方案但不能鎖定（先認識隊友）；拒絕次數會累計', () => {
  let s = applyAll(newGame('seed 001'), plan('紅', ['藥品', '飲水', '毛毯'], 10_000));
  assert.equal(evaluate(s).reachable, 3); // 排方案不受限
  s = apply(s, { type: 'lock', at: LOCK_OPENS_AT - 1 });
  assert.equal(s.phase, 'planning');
  assert.deepEqual(s.lastRejection?.reasons, ['TOO_EARLY']);
  assert.equal(s.rejections, 1);
  s = apply(s, { type: 'lock', at: LOCK_OPENS_AT });
  assert.equal(s.phase, 'blackout');
  assert.equal(s.rejections, 1);
  // 測試或特殊房間可以把限制設成 0
  const t = createGame({ seedId: 'seed 001', playerCount: 3, firstRound: false, slots: makeSlots(2, 1), lockOpensAt: 0 });
  const u = apply(applyAll(t, plan('紅', ['藥品'], 0)), { type: 'lock', at: 0 });
  assert.equal(u.phase, 'blackout');
});

test('F07（引擎層）符號數與排除線索名額：3／4／5／10 人', () => {
  assert.deepEqual([3, 4, 5, 10].map(symbolCount), [2, 3, 4, 4]);
  assert.deepEqual([3, 4, 5, 6, 10].map(eliminationClueCount), [0, 0, 0, 1, 5]);
  // 文件「5–10 人：其餘非工程師各一條」→ 5 人＝工程師＋4 持符號，沒有剩下的人
  const slots = makeSlots(4, 7);
  const clues = makeEliminationClues(slots, 5, 7);
  assert.equal(clues.length, 5);
  assert.equal(new Set(clues).size, 5);
  // 每條排除線索都是真話：不會排除正確答案
  for (const clue of clues) {
    const n = Number(clue.match(/第 (\d) 格/)![1]) - 1;
    const ans = parseSymbol(slots[n].answer);
    if (clue.includes('不是')) assert.ok(!clue.includes(ans.shape === '圓' ? '圓形' : ans.shape === '方' ? '方形' : '三角形'));
    if (clue.includes('缺口')) assert.ok(!clue.includes(`沒有 ${ans.gaps} 個`));
    if (clue.includes('開口')) assert.ok(!clue.endsWith(`朝${ans.dir}。`));
  }
  // 修好後停電解除
  const s = afterCrisis('seed 001', 10);
  assert.equal(s.phase, 'replanning');
});

test('F07 每格 9 個選項彼此不同，且只差少數特徵', () => {
  for (const slot of makeSlots(4, 123)) {
    assert.equal(new Set(slot.options).size, 9);
    const a = parseSymbol(slot.answer);
    for (const o of slot.options.map(parseSymbol)) {
      const diff = Number(o.shape !== a.shape) + Number(o.gaps !== a.gaps) + Number(o.dir !== a.dir);
      assert.ok(diff <= 2);
    }
  }
});

test('F08（引擎層）45／60 秒逾時進入協助模式，仍修得好；選錯不扣時間', () => {
  for (const [players, limit] of [[3, 45_000], [6, 60_000]] as const) {
    let s = newGame('seed 001', players);
    s = apply(s, { type: 'tick', at: CRISIS_AT });
    assert.equal(s.repair!.limitMs, limit);
    const wrong = s.repair!.slots[0].options.find((o) => o !== s.repair!.slots[0].answer)!;
    s = apply(s, { type: 'repairPick', at: CRISIS_AT + 1000, option: wrong });
    assert.equal(s.repair!.progress, 0);
    assert.equal(s.repair!.wrongPicks, 1);
    s = apply(s, { type: 'tick', at: CRISIS_AT + limit });
    assert.equal(s.repair!.assistLevel, 1);
    for (const g of s.repair!.grayed) assert.equal(g.length, 4);
    s = apply(s, { type: 'tick', at: CRISIS_AT + limit + 15_000 });
    assert.equal(s.repair!.assistLevel, 2);
    for (const g of s.repair!.grayed) assert.equal(g.length, 7);
    s = repairAll(s);
    assert.equal(s.phase, 'replanning');
  }
});

test('F26（引擎層）排除能力只能用一次，灰掉目前那格 2 個錯誤選項；不用也能修好', () => {
  let s = apply(newGame('seed 002'), { type: 'tick', at: CRISIS_AT });
  s = apply(s, { type: 'useEliminate', at: CRISIS_AT + 1000 });
  assert.equal(s.repair!.grayed[0].length, 2);
  assert.ok(!s.repair!.grayed[0].includes(s.repair!.slots[0].answer));
  s = apply(s, { type: 'useEliminate', at: CRISIS_AT + 2000 });
  assert.equal(s.repair!.grayed[0].length, 2);
  assert.deepEqual(s.lastRejection?.reasons, ['WRONG_PHASE']);
  assert.equal(afterCrisis('seed 002').phase, 'replanning');
});

test('F09 seed 001 危機後：藍＋燈3＋藥1＋水2 → 6 kg ★★', () => {
  let s = setPlan(afterCrisis('seed 001'), '藍', ['藥品', '飲水']);
  assert.equal(evaluate(s).weight, 6);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result?.stars, 2);
});

test('F10 seed 001 危機後：紅＋繩＋藥水毯 → 道路封閉，拒絕出發', () => {
  let s = setPlan(afterCrisis('seed 001'), '紅', ['藥品', '飲水', '毛毯']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result, null);
  assert.equal(s.lastRejection?.reasons[0], 'ROAD_CLOSED');
});

test('F11 seed 001：藍＋燈＋藥＋毯 → 7 kg ★', () => {
  let s = setPlan(afterCrisis('seed 001'), '藍', ['藥品', '毛毯']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result?.stars, 1);
  assert.equal(s.result?.weight, 7);
});

test('F12 seed 001：藍＋燈＋水＋毯 → 8 kg 超重，拒絕出發', () => {
  let s = setPlan(afterCrisis('seed 001'), '藍', ['飲水', '毛毯']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.deepEqual(s.lastRejection?.reasons, ['OVERWEIGHT']);
  assert.equal(evaluate(s).overweight, 1);
});

test('F13 seed 001：綠＋藥水毯、未開閘 → 來不及', () => {
  let s = setPlan(afterCrisis('seed 001'), '綠', ['藥品', '飲水', '毛毯']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.deepEqual(s.lastRejection?.reasons, ['TOO_LATE']);
});

test('F14 seed 001：開閘（輸錯可重試）＋綠＋藥水毯 → ★★★；停電中不能開閘', () => {
  let s = apply(newGame('seed 001'), { type: 'tick', at: CRISIS_AT });
  s = apply(s, { type: 'floodgate', at: CRISIS_AT + 1, channel: '472' });
  assert.equal(s.floodgate, false);
  s = repairAll(s);
  s = apply(s, { type: 'floodgate', at: s.now + 1, channel: '999' });
  assert.equal(s.floodgate, false);
  s = apply(s, { type: 'floodgate', at: s.now + 1, channel: '472' });
  assert.equal(s.floodgate, true);
  s = setPlan(s, '綠', ['藥品', '飲水', '毛毯']);
  assert.equal(evaluate(s).safeWindow, 7);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result?.stars, 3);
  assert.equal(s.result?.weight, 6);
});

test('F15 合法路線與工具但沒有任何村需要的物資 → 拒絕出發', () => {
  let s = setPlan(afterCrisis('seed 001'), '藍', []);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.deepEqual(s.lastRejection?.reasons, ['NO_NEEDS']);
  let t = setPlan(afterCrisis('seed 001'), '藍', ['食物']);
  t = apply(t, { type: 'depart', at: t.now + 1 });
  assert.deepEqual(t.lastRejection?.reasons, ['NO_NEEDS']);
});

test('停電中出發 → 尚未恢復供電；拒絕可無限重送；結算只一次', () => {
  let s = applyAll(newGame('seed 001'), plan('藍', ['藥品', '飲水']));
  s = apply(s, { type: 'lock', at: 80_000 });
  s = apply(s, { type: 'depart', at: 81_000 });
  assert.equal(s.lastRejection?.reasons[0], 'NOT_POWERED');
  s = repairAll(s);
  s = apply(s, { type: 'setItem', at: s.now, item: '毛毯', on: true });
  for (let i = 0; i < 5; i++) s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result, null);
  s = apply(s, { type: 'setItem', at: s.now, item: '毛毯', on: false });
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result?.stars, 2);
  const settled = s;
  s = apply(s, { type: 'setItem', at: s.now, item: '毛毯', on: true });
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.deepEqual(s.result, settled.result);
  assert.deepEqual(s.plan, settled.plan);
  assert.equal(s.log.filter((l) => l.kind === 'settled').length, 1);
});

test('F21 seed 002：藍＋頭燈＋食藥水 6 kg 可鎖定；危機後載重 5，路線不封閉，保留物資並超重 1 kg', () => {
  let s = applyAll(newGame('seed 002'), plan('藍', ['食物', '藥品', '飲水']));
  assert.equal(evaluate(s).weight, 6);
  assert.equal(evaluate(s).reachable, 3);
  s = apply(s, { type: 'lock', at: 100_000 });
  s = repairAll(s);
  assert.deepEqual(s.plan, { route: '藍', items: ['食物', '藥品', '飲水'] });
  const ev = evaluate(s);
  assert.equal(ev.cap, 5);
  assert.equal(ev.overweight, 1);
  assert.deepEqual(ev.reasons, ['OVERWEIGHT']);
  assert.equal(evaluate(setPlan(s, '紅', ['食物'])).reasons.length, 0);
});

test('F22 seed 002 危機後：藍＋頭燈＋食＋藥 → 4 kg ★★', () => {
  let s = setPlan(afterCrisis('seed 002'), '藍', ['食物', '藥品']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result?.stars, 2);
  assert.equal(s.result?.weight, 4);
});

test('F23 seed 002 危機後：藍＋頭燈＋藥＋水、紅＋長繩＋食 → 皆 ★', () => {
  for (const [route, items] of [['藍', ['藥品', '飲水']], ['紅', ['食物']]] as const) {
    let s = setPlan(afterCrisis('seed 002'), route, [...items]);
    s = apply(s, { type: 'depart', at: s.now + 1 });
    assert.equal(s.result?.stars, 1, route);
  }
});

test('F24 seed 002 危機後：紅＋長繩＋食＋藥 → 6 kg 超重', () => {
  let s = setPlan(afterCrisis('seed 002'), '紅', ['食物', '藥品']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.deepEqual(s.lastRejection?.reasons, ['OVERWEIGHT']);
});

test('F25 seed 002：淨水錠未發放不能裝；問北村井水後 5 kg ★★★；問錯只能二星', () => {
  let s = afterCrisis('seed 002');
  s = apply(s, { type: 'setItem', at: s.now, item: '淨水錠', on: true });
  assert.deepEqual(s.lastRejection?.reasons, ['NOT_RELEASED']);
  assert.ok(!s.plan.items.includes('淨水錠'));
  s = apply(s, { type: 'query', at: s.now + 1, village: '北村', question: 'well' });
  assert.equal(s.released, true);
  s = setPlan(s, '藍', ['食物', '藥品', '淨水錠']);
  s = apply(s, { type: 'depart', at: s.now + 1 });
  assert.equal(s.result?.stars, 3);
  assert.equal(s.result?.weight, 5);

  let w = afterCrisis('seed 002');
  w = apply(w, { type: 'query', at: w.now + 1, village: '東村', question: 'well' });
  w = apply(w, { type: 'query', at: w.now + 1, village: '北村', question: 'well' });
  assert.equal(w.released, false);
  assert.equal(w.log.filter((l) => l.kind === 'query').length, 1);
  w = setPlan(w, '藍', ['食物', '藥品']);
  w = apply(w, { type: 'depart', at: w.now + 1 });
  assert.equal(w.result?.stars, 2);

  let p = apply(newGame('seed 002'), { type: 'tick', at: CRISIS_AT });
  p = apply(p, { type: 'query', at: CRISIS_AT + 1, village: '北村', question: 'well' });
  assert.equal(p.query.used, false); // 停電中不能詢問
});

test('F27（引擎層）可送達村數即時；2:15 只在未排進三村時提示一次', () => {
  let s = applyAll(newGame('seed 001'), plan('藍', ['藥品', '飲水']));
  assert.equal(evaluate(s).reachable, 2);
  s = apply(s, { type: 'tick', at: HINT_AT });
  assert.equal(s.hint.shown, true);
  assert.equal(s.log.filter((l) => l.kind === 'hint').length, 1);
  s = apply(s, { type: 'tick', at: HINT_AT + 5000 });
  assert.equal(s.log.filter((l) => l.kind === 'hint').length, 1);

  let t = applyAll(newGame('seed 001'), plan('紅', ['藥品', '飲水', '毛毯']));
  t = apply(t, { type: 'tick', at: HINT_AT });
  assert.equal(t.hint.shown, false);

  let u = applyAll(newGame('seed 002'), plan('紅', ['食物', '藥品']));
  u = apply(u, { type: 'lock', at: 90_000 });
  u = apply(u, { type: 'tick', at: HINT_AT });
  assert.equal(u.hint.shown, false);
});

test('F28（引擎層）危機後保留物資並算出超重；首局限時多 15 秒、協助提早 15 秒', () => {
  let s = applyAll(newGame('seed 001'), plan('紅', ['藥品', '飲水', '毛毯']));
  s = apply(s, { type: 'lock', at: 80_000 });
  s = repairAll(s);
  s = apply(s, { type: 'selectRoute', at: s.now, route: '藍' });
  assert.deepEqual(s.plan.items, ['藥品', '飲水', '毛毯']);
  assert.equal(evaluate(s).weight, 9);
  assert.equal(evaluate(s).overweight, 2);

  assert.equal(repairLimitMs(6, true), 75_000);
  assert.equal(repairLimitMs(3, true), 60_000);
  let f = apply(newGame('seed 001', 6, true), { type: 'tick', at: CRISIS_AT });
  assert.equal(f.repair!.limitMs, 75_000);
  assert.equal(f.repair!.assistAt, CRISIS_AT + 45_000);
  f = apply(f, { type: 'tick', at: CRISIS_AT + 45_000 });
  assert.equal(f.repair!.assistLevel, 1);
});

test('8:00 時間到：合法方案自動結算，否則友善結束', () => {
  let s = setPlan(afterCrisis('seed 001'), '藍', ['藥品', '飲水']);
  s = apply(s, { type: 'tick', at: TIME_UP_AT });
  assert.equal(s.phase, 'settled');
  assert.equal(s.result?.cause, 'time_up');
  let t = apply(afterCrisis('seed 001'), { type: 'tick', at: TIME_UP_AT });
  assert.equal(t.phase, 'ended');
  assert.equal(t.result, null);
});
