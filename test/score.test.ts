// 團隊計分單元測試（src/engine/score.ts）＋難度表與驗證腳本一致（golden）。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { apply, createGame, crisisAtFor, repairLimitMs, symbolCount, FIRST_ROUND_EXTRA, SECOND_ASSIST_AFTER, TIME_UP_AT, type GameState } from '../src/engine/game.ts';
import { makeSlots } from '../src/engine/symbols.ts';
import { CLASSIC, type CardId } from '../src/engine/seeds.ts';
import { validSetups } from '../src/engine/rules.ts';
import { DIFFICULTY, DIFF_MAX, SWEEP_BONUS } from '../src/engine/difficulty.ts';
import { PLAYER_FACTOR, REPAIR_MS_PER_SLOT, SCORE_MAX, computeScore, difficultyKey, rawOf, scoredAssist, scoreOf, standardRepairMs, type ScoreRaw } from '../src/engine/score.ts';

/** 一份「中等」的原始資料，各測試只改要測的欄位。 */
function raw(over: Partial<ScoreRaw> = {}): ScoreRaw {
  return {
    formula: 'v3-trial',
    stars: 3,
    safe: true,
    repairMs: 30_000,
    repairLimitMs: 60_000,
    assistLevel: 0,
    slots: 4,
    firstRound: false,
    wrongPicks: 0,
    finishedAt: 240_000,
    cards: { a: 'A5', b: 'B4' },
    tonight: CLASSIC,
    sweep: false,
    solutions: 1,
    difficultyPoints: 40,
    playerCount: 6,
    ...over,
  };
}

function newGame(players = 6, sweep = false, a: CardId = 'A5', b: CardId = 'B4'): GameState {
  return createGame({ seedId: 'ship 001', playerCount: players, firstRound: false, slots: makeSlots(symbolCount(players), 42), cards: { a, b }, tonight: CLASSIC, sweep });
}

/** 真的跑一局到三星上岸：丟掉三件用不到的 → 風暴 → 補好船 → 吃飯 → 衝向海灘。 */
function playToShore(repairAfterMs: number, departAt: number): GameState {
  let s = newGame();
  for (const i of ['麥子', '器具', '小船'] as const) s = apply(s, { type: 'setItem', at: 1000, item: i, on: false });
  const crisis = crisisAtFor(s.cards);
  s = apply(s, { type: 'tick', at: crisis });
  for (const slot of s.repair!.slots) s = apply(s, { type: 'repairPick', at: crisis + repairAfterMs, option: slot.answer });
  s = apply(s, { type: 'use', at: crisis + repairAfterMs + 100, use: '吃飯' });
  return apply(s, { type: 'depart', at: departAt });
}

// ---------- computeScore ----------

test('計分：任務成果每星 200；沒能平安上岸（0–1 件或時間到）任務、時間、難度都是 0，只留合作（DECISIONS 18）', () => {
  for (const stars of [2, 3] as const) assert.equal(computeScore(raw({ stars })).mission, 200 * stars);
  for (const stars of [0, 1] as const) {
    const b = computeScore(raw({ stars, safe: false }));
    assert.deepEqual([b.mission, b.time, b.difficulty], [0, 0, 0]);
    assert.equal(b.teamwork, computeScore(raw()).teamwork, '補船的合作分照算');
  }
  // 舊紀錄沒有 safe：重算時依星數判斷
  const old = raw({ stars: 1 });
  delete old.safe;
  assert.equal(computeScore(old).mission, 0);
  const oldOk = raw({ stars: 2 });
  delete oldOk.safe;
  assert.equal(computeScore(oldOk).mission, 400);
});

test('計分：合作順暢＝補船速度 140×(1−用時/標準時間) 四捨五入＋協助分 60/30/0', () => {
  // 預設 4 格、非首局：標準時間 60 秒，限時 60 秒
  assert.equal(computeScore(raw({ repairMs: 0 })).teamwork, 140 + 60);
  assert.equal(computeScore(raw({ repairMs: 30_000 })).teamwork, 70 + 60);
  // 四捨五入：140×(1−10000/60000)＝116.67 → 117
  assert.equal(computeScore(raw({ repairMs: 10_000 })).teamwork, 117 + 60);
  // 140×(1−5000/15000)＝93.33 → 93（1 格 15 秒）
  assert.equal(computeScore(raw({ slots: 1, repairLimitMs: 15_000, repairMs: 5_000 })).teamwork, 93 + 60);
});

test('計分：逾時才補好，速度分為 0，協助分依逾時多久（scoredAssist）', () => {
  assert.equal(computeScore(raw({ repairMs: 70_000, assistLevel: 1 })).teamwork, 30, '逾時 10 秒＝協助 1');
  assert.equal(computeScore(raw({ repairMs: 80_000, assistLevel: 2 })).teamwork, 0, '逾時超過 15 秒＝協助 2');
  assert.equal(computeScore(raw({ repairMs: 60_000 })).teamwork, 60, '剛好限時＝速度 0、協助分 60');
  assert.equal(computeScore(raw({ repairMs: null, assistLevel: 2 })).teamwork, 0);
  assert.equal(computeScore(raw({ repairMs: null, assistLevel: 0 })).teamwork, 0);
  assert.equal(computeScore(raw({ repairLimitMs: 0 })).teamwork, 0);
});

test('standardRepairMs：3 人 2 格 30 秒、4 人 3 格 45 秒、5–10 人 4 格 60 秒、首局 +15 秒', () => {
  assert.equal(REPAIR_MS_PER_SLOT, 15_000);
  const expected: Record<number, number> = { 3: 30_000, 4: 45_000, 5: 60_000, 6: 60_000, 7: 60_000, 8: 60_000, 9: 60_000, 10: 60_000 };
  for (const [n, ms] of Object.entries(expected)) {
    const slots = symbolCount(Number(n));
    assert.equal(standardRepairMs({ slots, firstRound: false }), ms, `${n} 人`);
    assert.equal(standardRepairMs({ slots, firstRound: true }), ms + FIRST_ROUND_EXTRA, `${n} 人首局`);
  }
});

test('計分：同一每格秒數下，3／4／6／10 人速度分相同（每格 7.5 秒 → 140×0.5＝70）', () => {
  const teamworkFor = (n: number) => {
    const slots = symbolCount(n);
    return computeScore(raw({ playerCount: n, slots, repairLimitMs: repairLimitMs(n, false), repairMs: slots * 7_500 })).teamwork;
  };
  for (const n of [3, 4, 6, 10]) assert.equal(teamworkFor(n), 70 + 60, `${n} 人`);
});

test('計分：A5 的 +10 秒只放寬限時，不進速度分母', () => {
  const base = computeScore(raw({ repairMs: 30_000, repairLimitMs: 60_000 })).teamwork;
  const a5 = computeScore(raw({ repairMs: 30_000, repairLimitMs: 70_000 })).teamwork;
  assert.equal(a5, base, '同樣用 30 秒，限時 +10 秒不改變分數');
  assert.equal(standardRepairMs({ slots: 4, firstRound: false }), 60_000);
  assert.equal(computeScore(raw({ repairMs: 65_000, repairLimitMs: 70_000 })).teamwork, 60, '有 A5 寬限內補好＝協助分 60、速度 0');
});

test('scoredAssist：剛好等於限時＝0、限時＋15 秒＝1、再多 1 毫秒＝2、沒補好＝2', () => {
  const L = 60_000;
  assert.equal(scoredAssist({ repairMs: L, repairLimitMs: L }), 0);
  assert.equal(scoredAssist({ repairMs: L - 1, repairLimitMs: L }), 0);
  assert.equal(scoredAssist({ repairMs: L + 1, repairLimitMs: L }), 1);
  assert.equal(scoredAssist({ repairMs: L + SECOND_ASSIST_AFTER, repairLimitMs: L }), 1);
  assert.equal(scoredAssist({ repairMs: L + SECOND_ASSIST_AFTER + 1, repairLimitMs: L }), 2);
  assert.equal(scoredAssist({ repairMs: null, repairLimitMs: L }), 2);
});

test('計分：首局協助已出現但還沒逾時（assistLevel 1、用時 < 限時）協助分仍為 60', () => {
  // 首局 4 格：限時 75 秒，協助 60 秒就出現；用 65 秒補好 → 畫面 assistLevel 1，但計分看 repairMs ≤ 限時
  const b = computeScore(raw({ firstRound: true, repairLimitMs: 75_000, repairMs: 65_000, assistLevel: 1 }));
  const speed = Math.round(140 * (1 - 65_000 / 75_000));
  assert.equal(b.teamwork, speed + 60);
});

test('計分（v3）：時間 3:30 前滿分、8:00 為 0、中間線性', () => {
  assert.equal(computeScore(raw({ finishedAt: 0 })).time, 100);
  assert.equal(computeScore(raw({ finishedAt: 120_000 })).time, 100);
  assert.equal(computeScore(raw({ finishedAt: 210_000 })).time, 100);
  assert.equal(computeScore(raw({ finishedAt: 345_000 })).time, 50);
  assert.equal(computeScore(raw({ finishedAt: TIME_UP_AT })).time, 0);
  assert.equal(computeScore(raw({ finishedAt: TIME_UP_AT + 60_000 })).time, 0);
});

test('計分：難度＝min(100, 難度分＋風暴捲走 20)×星數/3，難度分上限 80', () => {
  assert.equal(computeScore(raw({ difficultyPoints: 40, sweep: false, stars: 3 })).difficulty, 40);
  assert.equal(computeScore(raw({ difficultyPoints: 40, sweep: true, stars: 3 })).difficulty, 60);
  assert.equal(computeScore(raw({ difficultyPoints: 80, sweep: true, stars: 3 })).difficulty, 100);
  assert.equal(computeScore(raw({ difficultyPoints: 500, sweep: true, stars: 3 })).difficulty, 100, '難度分超過 80 也只算 80');
  assert.equal(computeScore(raw({ difficultyPoints: 60, sweep: false, stars: 2 })).difficulty, 40);
  assert.equal(computeScore(raw({ difficultyPoints: 60, sweep: false, stars: 1, safe: false })).difficulty, 0, '沒能平安上岸拿不到難度分');
  assert.equal(computeScore(raw({ difficultyPoints: 80, sweep: true, stars: 0, safe: false })).difficulty, 0);
});

test('計分：總分是四項相加×人數係數，且回傳公式版本與試行標記', () => {
  const b = computeScore(raw());
  assert.equal(b.total, b.mission + b.teamwork + b.time + b.difficulty);
  assert.equal(b.factor, 1);
  assert.equal(b.trial, true);
  assert.equal(b.formula, 'v3-trial');
});

test('計分：滿分情境剛好 1000，不會超過', () => {
  const b = computeScore(raw({ stars: 3, repairMs: 0, assistLevel: 0, finishedAt: 0, difficultyPoints: 80, sweep: true }));
  assert.deepEqual([b.mission, b.teamwork, b.time, b.difficulty], [600, 200, 100, 100]);
  assert.equal(b.total, SCORE_MAX);
});

test('計分：極端輸入（負數、超大）各項與總分仍在範圍內', () => {
  const extremes: Partial<ScoreRaw>[] = [
    { repairMs: -1e9, finishedAt: -1e9, difficultyPoints: 1e9, sweep: true },
    { repairMs: 1e12, finishedAt: 1e12, difficultyPoints: -1e9 },
    { repairLimitMs: 1e12, repairMs: 0, finishedAt: -5 },
    { difficultyPoints: -50, sweep: false },
    { playerCount: 999 },
    { playerCount: -3 },
  ];
  for (const e of extremes) {
    const b = computeScore(raw(e));
    assert.ok(b.total >= 0 && b.total <= SCORE_MAX, `total=${b.total}`);
    assert.ok(b.teamwork >= 0 && b.teamwork <= 200, `teamwork=${b.teamwork}`);
    assert.ok(b.time >= 0 && b.time <= 100, `time=${b.time}`);
    assert.ok(b.difficulty >= 0 && b.difficulty <= 100, `difficulty=${b.difficulty}`);
  }
});

test('人數校正表涵蓋 3–10 人且試行期全為 1.0；人數不在表內視為 1', () => {
  for (let n = 3; n <= 10; n++) assert.equal(PLAYER_FACTOR[n], 1.0, `${n} 人`);
  assert.deepEqual(Object.keys(PLAYER_FACTOR).map(Number).sort((x, y) => x - y), [3, 4, 5, 6, 7, 8, 9, 10]);
  for (let n = 3; n <= 10; n++) assert.equal(computeScore(raw({ playerCount: n })).total, computeScore(raw({ playerCount: 6 })).total);
  assert.equal(computeScore(raw({ playerCount: 12 })).factor, 1);
});

test('人數係數會影響總分，但總分仍不超過 1000（暫時改表後還原）', () => {
  const full = raw({ repairMs: 0, assistLevel: 0, finishedAt: 0, difficultyPoints: 80, sweep: true });
  const mid = raw();
  const old = PLAYER_FACTOR[4];
  try {
    PLAYER_FACTOR[4] = 1.2;
    assert.equal(computeScore({ ...full, playerCount: 4 }).total, SCORE_MAX, '滿分乘 1.2 也夾在 1000');
    const base = computeScore({ ...mid, playerCount: 6 });
    const boosted = computeScore({ ...mid, playerCount: 4 });
    assert.equal(boosted.factor, 1.2);
    assert.equal(boosted.total, Math.min(SCORE_MAX, Math.round((base.mission + base.teamwork + base.time + base.difficulty) * 1.2)));
    assert.ok(boosted.total > base.total);
    PLAYER_FACTOR[4] = 0.5;
    assert.ok(computeScore({ ...mid, playerCount: 4 }).total < base.total);
    PLAYER_FACTOR[4] = -2;
    assert.equal(computeScore({ ...mid, playerCount: 4 }).total, 0, '負係數也不會低於 0');
  } finally {
    PLAYER_FACTOR[4] = old;
  }
  assert.equal(PLAYER_FACTOR[4], 1.0);
});

// ---------- rawOf / scoreOf ----------

test('rawOf／scoreOf：還沒結束（規劃中、停電中）回傳 null', () => {
  const s = newGame();
  assert.equal(rawOf(s), null);
  assert.equal(scoreOf(s), null);
  const dark = apply(s, { type: 'tick', at: crisisAtFor(s.cards) });
  assert.equal(dark.phase, 'blackout');
  assert.equal(rawOf(dark), null);
  assert.equal(scoreOf(dark), null);
});

test('rawOf：真的跑完一局三星上岸，原始資料各欄位正確', () => {
  const s = playToShore(5_000, 200_000);
  assert.equal(s.phase, 'settled');
  const r = rawOf(s)!;
  assert.equal(r.formula, 'v3-trial');
  assert.equal(r.stars, 3);
  assert.equal(r.safe, true);
  assert.equal(r.repairMs, 5_000);
  assert.equal(r.repairLimitMs, s.repair!.limitMs);
  assert.equal(r.assistLevel, 0);
  assert.equal(r.slots, 4, '6 人＝4 格');
  assert.equal(r.firstRound, false);
  assert.equal(r.wrongPicks, 0);
  assert.equal(r.finishedAt, s.result!.at);
  assert.equal(r.sweep, false);
  assert.equal(r.playerCount, 6);
  assert.deepEqual(r.cards, { a: 'A5', b: 'B4' });
  assert.deepEqual(r.tonight, CLASSIC);
  const d = DIFFICULTY[difficultyKey(s.cards, s.tonight)];
  assert.equal(r.solutions, d.solutions);
  assert.equal(r.difficultyPoints, d.points);
  // rawOf 回傳的是複本，改它不會動到規則狀態
  r.cards.a = 'A1';
  assert.equal(s.cards.a, 'A5');
});

test('scoreOf：快速補好船的三星局＝raw 與 computeScore 一致，且各項合理', () => {
  const s = playToShore(5_000, 200_000);
  const { raw: r, score } = scoreOf(s)!;
  assert.deepEqual(score, computeScore(r));
  assert.equal(score.mission, 600);
  assert.equal(score.teamwork, Math.round(140 * (1 - 5_000 / standardRepairMs(r))) + 60);
  assert.equal(score.total, score.mission + score.teamwork + score.time + score.difficulty);
  assert.ok(score.total <= SCORE_MAX);
});

test('rawOf：補船逾時進協助 → assistLevel 1、repairMs 超過限時，速度分為 0', () => {
  const s = playToShore(80_000, 300_000);
  const r = rawOf(s)!;
  assert.equal(r.assistLevel, 1);
  assert.equal(r.repairMs, 80_000);
  assert.ok(r.repairMs! > r.repairLimitMs);
  assert.equal(computeScore(r).teamwork, 30);
});

test('rawOf：記下 slots／firstRound／wrongPicks；選錯不計分但存下來', () => {
  // 3 人首局：2 格、首局
  let s = createGame({ seedId: 'ship 001', playerCount: 3, firstRound: true, slots: makeSlots(symbolCount(3), 7), cards: { a: 'A5', b: 'B4' }, tonight: CLASSIC, sweep: false });
  for (const i of ['麥子', '器具', '小船'] as const) s = apply(s, { type: 'setItem', at: 1000, item: i, on: false });
  const crisis = crisisAtFor(s.cards);
  s = apply(s, { type: 'tick', at: crisis });
  const slot = s.repair!.slots[0];
  const bad = slot.options.find((o) => o !== slot.answer)!;
  s = apply(s, { type: 'repairPick', at: crisis + 3_000, option: bad });
  s = apply(s, { type: 'repairPick', at: crisis + 6_000, option: bad }); // 選錯後面板鎖 2.5 秒，過了才算第二次
  for (const sl of s.repair!.slots) s = apply(s, { type: 'repairPick', at: crisis + 10_000, option: sl.answer });
  s = apply(s, { type: 'use', at: crisis + 10_100, use: '吃飯' });
  s = apply(s, { type: 'depart', at: 200_000 });
  const r = rawOf(s)!;
  assert.equal(r.slots, 2);
  assert.equal(r.firstRound, true);
  assert.equal(r.wrongPicks, 2);
  assert.equal(standardRepairMs(r), 45_000);
  const noWrong = computeScore({ ...r, wrongPicks: 0 });
  assert.deepEqual(computeScore(r), noWrong, '選錯次數目前不影響分數');
});

test('rawOf：風暴捲走局 sweep 為 true，難度加 20', () => {
  const g = newGame(6, true);
  const settled = { ...g, phase: 'ended' as const, repair: null, result: null };
  const r = rawOf(settled)!;
  assert.equal(r.sweep, true);
  assert.equal(r.safe, false, '時間到還沒出發＝沒能平安上岸');
  assert.equal(computeScore({ ...r, stars: 3, safe: true }).difficulty, Math.min(100, Math.min(DIFF_MAX, r.difficultyPoints) + SWEEP_BONUS));
});

test('rawOf：時間到還在黑暗中 → repairMs null、assistLevel 2、finishedAt 8:00，總分 0', () => {
  let s = newGame();
  s = apply(s, { type: 'tick', at: crisisAtFor(s.cards) });
  s = apply(s, { type: 'tick', at: TIME_UP_AT });
  assert.equal(s.phase, 'ended');
  const sc = scoreOf(s)!;
  assert.equal(sc.raw.repairMs, null);
  assert.equal(sc.raw.assistLevel, 2);
  assert.equal(sc.raw.finishedAt, TIME_UP_AT);
  assert.equal(sc.raw.stars, 0);
  assert.equal(sc.score.teamwork, 0);
  assert.equal(sc.score.time, 0);
  assert.equal(sc.score.total, 0);
});

test('rawOf：從沒進入黑暗就時間到（repair 為 null）也不會丟錯', () => {
  let s = newGame();
  s = { ...s, phase: 'ended' };
  const r = rawOf(s)!;
  assert.equal(r.repairMs, null);
  assert.equal(r.repairLimitMs, 0);
  assert.equal(computeScore(r).teamwork, 0);
});

// ---------- 難度表與驗證腳本一致（golden） ----------

interface DiffJson {
  max: number;
  sweep_bonus: number;
  games: Record<string, { solutions: number; points: number }>;
}

test('難度表：src/engine/difficulty.ts 與 verify_seeds.py --difficulty 逐筆相等', () => {
  const out = execFileSync('python3', ['tools/verify_seeds.py', '--difficulty'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const py = JSON.parse(out) as DiffJson;
  assert.equal(DIFF_MAX, py.max);
  assert.equal(SWEEP_BONUS, py.sweep_bonus);
  assert.deepEqual(Object.keys(DIFFICULTY).sort(), Object.keys(py.games).sort());
  for (const [k, v] of Object.entries(py.games)) assert.deepEqual(DIFFICULTY[k], v, k);
});

test('難度表：與 test/fixtures/verify_seeds_golden.json 的 difficulty 欄位相等', () => {
  const g = JSON.parse(readFileSync(new URL('./fixtures/verify_seeds_golden.json', import.meta.url), 'utf8')) as { difficulty: DiffJson };
  assert.equal(g.difficulty.max, DIFF_MAX);
  assert.equal(g.difficulty.sweep_bonus, SWEEP_BONUS);
  assert.deepEqual(DIFFICULTY, g.difficulty.games);
});

test('難度表：validSetups() 的每一種局面（起風卡×見聞×允許的風暴卡）都查得到，且難度分在範圍內', () => {
  let n = 0;
  for (const setup of validSetups()) {
    for (const b of setup.b) {
      const d = DIFFICULTY[difficultyKey({ a: setup.a, b }, setup.tonight)];
      assert.ok(d, `${setup.a}|${JSON.stringify(setup.tonight)}|${b} 不在難度表裡`);
      assert.ok(d.solutions >= 1);
      assert.ok(d.points >= 0 && d.points <= DIFF_MAX);
      n++;
    }
  }
  assert.ok(n > 0);
});

// ---------- docs/13 的範例（916／753／607／130）與公平性對照 ----------

test('docs/13 範例 A／B／C 與公平性對照：逐項與文件一致', () => {
  const ex = (a: CardId, b: CardId, tonight: ScoreRaw['tonight'], over: Partial<ScoreRaw>) => {
    const d = DIFFICULTY[difficultyKey({ a, b }, tonight)];
    return computeScore(raw({ cards: { a, b }, tonight, solutions: d.solutions, difficultyPoints: d.points, ...over }));
  };
  const shallow = { ...CLASSIC, 水: '淺' as const };
  const A = ex('A3', 'B1', CLASSIC, { firstRound: true, repairLimitMs: 75_000, repairMs: 30_000, finishedAt: 150_000 });
  assert.deepEqual([A.mission, A.teamwork, A.time, A.difficulty, A.total], [600, 144, 100, 80, 924]);
  const B = ex('A4', 'B5', shallow, { repairMs: 50_000, finishedAt: 300_000, sweep: true });
  assert.deepEqual([B.mission, B.teamwork, B.time, B.difficulty, B.total], [600, 83, 67, 20, 770]);
  const B2 = ex('A4', 'B5', shallow, { repairMs: 70_000, assistLevel: 1, finishedAt: 300_000, sweep: true });
  assert.deepEqual([B2.teamwork, B2.total], [30, 717]);
  const C = ex('A2', 'B2', CLASSIC, { playerCount: 3, slots: 2, repairLimitMs: 45_000, repairMs: 20_000, stars: 2, finishedAt: 360_000, sweep: true });
  assert.deepEqual([C.mission, C.teamwork, C.time, C.difficulty, C.total], [400, 107, 44, 67, 618]);
  const c3 = ex('A2', 'B2', CLASSIC, { playerCount: 3, slots: 2, repairLimitMs: 45_000, repairMs: 15_000, finishedAt: 360_000, sweep: true });
  const c6 = ex('A2', 'B2', CLASSIC, { playerCount: 6, slots: 4, repairLimitMs: 60_000, repairMs: 30_000, finishedAt: 360_000, sweep: true });
  assert.equal(c3.total, 874);
  assert.equal(c6.total, 874);
  const D = ex('A2', 'B2', CLASSIC, { repairMs: 30_000, stars: 1, safe: false, finishedAt: 360_000, sweep: true });
  assert.deepEqual([D.mission, D.teamwork, D.time, D.difficulty, D.total], [0, 130, 0, 0, 130]);
});
