// 團隊計分單元測試（src/engine/score.ts）＋難度表與驗證腳本一致（golden）。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { apply, createGame, crisisAtFor, symbolCount, TIME_UP_AT, type GameState } from '../src/engine/game.ts';
import { makeSlots } from '../src/engine/symbols.ts';
import { CLASSIC, type CardId } from '../src/engine/seeds.ts';
import { validSetups } from '../src/engine/rules.ts';
import { DIFFICULTY, DIFF_MAX, SWEEP_BONUS } from '../src/engine/difficulty.ts';
import { PLAYER_FACTOR, SCORE_MAX, computeScore, difficultyKey, rawOf, scoreOf, type ScoreRaw } from '../src/engine/score.ts';

/** 一份「中等」的原始資料，各測試只改要測的欄位。 */
function raw(over: Partial<ScoreRaw> = {}): ScoreRaw {
  return {
    formula: 'v1-trial',
    stars: 3,
    repairMs: 35_000,
    repairLimitMs: 70_000,
    assistLevel: 0,
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

test('計分：任務成果每星 200', () => {
  for (const stars of [0, 1, 2, 3] as const) assert.equal(computeScore(raw({ stars })).mission, 200 * stars);
});

test('計分：合作順暢＝補船速度 140×(1−用時/限時) 四捨五入＋協助分 60/30/0', () => {
  assert.equal(computeScore(raw({ repairMs: 0, assistLevel: 0 })).teamwork, 140 + 60);
  assert.equal(computeScore(raw({ repairMs: 35_000, assistLevel: 0 })).teamwork, 70 + 60);
  assert.equal(computeScore(raw({ repairMs: 35_000, assistLevel: 1 })).teamwork, 70 + 30);
  assert.equal(computeScore(raw({ repairMs: 35_000, assistLevel: 2 })).teamwork, 70 + 0);
  // 四捨五入：140×(1−10000/70000)＝120
  assert.equal(computeScore(raw({ repairMs: 10_000, assistLevel: 2 })).teamwork, 120);
  // 140×(1−1/3)＝93.33 → 93
  assert.equal(computeScore(raw({ repairMs: 10_000, repairLimitMs: 15_000, assistLevel: 2 })).teamwork, 47);
  assert.equal(computeScore(raw({ repairMs: 5_000, repairLimitMs: 15_000, assistLevel: 2 })).teamwork, 93);
});

test('計分：逾時才補好，速度分為 0，只剩協助分；沒補好＝合作 0 分', () => {
  assert.equal(computeScore(raw({ repairMs: 80_000, assistLevel: 1 })).teamwork, 30);
  assert.equal(computeScore(raw({ repairMs: 70_000, assistLevel: 0 })).teamwork, 60);
  assert.equal(computeScore(raw({ repairMs: null, assistLevel: 2 })).teamwork, 0);
  assert.equal(computeScore(raw({ repairMs: null, assistLevel: 0 })).teamwork, 0);
  assert.equal(computeScore(raw({ repairLimitMs: 0 })).teamwork, 0);
});

test('計分：時間 2:00 前滿分、8:00 為 0、中間線性', () => {
  assert.equal(computeScore(raw({ finishedAt: 0 })).time, 100);
  assert.equal(computeScore(raw({ finishedAt: 120_000 })).time, 100);
  assert.equal(computeScore(raw({ finishedAt: 300_000 })).time, 50);
  assert.equal(computeScore(raw({ finishedAt: TIME_UP_AT })).time, 0);
  assert.equal(computeScore(raw({ finishedAt: TIME_UP_AT + 60_000 })).time, 0);
});

test('計分：難度＝min(100, 難度分＋風暴捲走 20)×星數/3，難度分上限 80', () => {
  assert.equal(computeScore(raw({ difficultyPoints: 40, sweep: false, stars: 3 })).difficulty, 40);
  assert.equal(computeScore(raw({ difficultyPoints: 40, sweep: true, stars: 3 })).difficulty, 60);
  assert.equal(computeScore(raw({ difficultyPoints: 80, sweep: true, stars: 3 })).difficulty, 100);
  assert.equal(computeScore(raw({ difficultyPoints: 500, sweep: true, stars: 3 })).difficulty, 100, '難度分超過 80 也只算 80');
  assert.equal(computeScore(raw({ difficultyPoints: 60, sweep: false, stars: 2 })).difficulty, 40);
  assert.equal(computeScore(raw({ difficultyPoints: 60, sweep: false, stars: 1 })).difficulty, 20);
  assert.equal(computeScore(raw({ difficultyPoints: 80, sweep: true, stars: 0 })).difficulty, 0, '一件都沒顧好拿不到難度分');
});

test('計分：總分是四項相加×人數係數，且回傳公式版本與試行標記', () => {
  const b = computeScore(raw());
  assert.equal(b.total, b.mission + b.teamwork + b.time + b.difficulty);
  assert.equal(b.factor, 1);
  assert.equal(b.trial, true);
  assert.equal(b.formula, 'v1-trial');
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
  assert.equal(r.formula, 'v1-trial');
  assert.equal(r.stars, 3);
  assert.equal(r.repairMs, 5_000);
  assert.equal(r.repairLimitMs, s.repair!.limitMs);
  assert.equal(r.assistLevel, 0);
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
  assert.equal(score.teamwork, Math.round(140 * (1 - 5_000 / r.repairLimitMs)) + 60);
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

test('rawOf：風暴捲走局 sweep 為 true，難度加 20', () => {
  const g = newGame(6, true);
  const settled = { ...g, phase: 'ended' as const, repair: null, result: null };
  const r = rawOf(settled)!;
  assert.equal(r.sweep, true);
  assert.equal(computeScore({ ...r, stars: 3 }).difficulty, Math.min(100, Math.min(DIFF_MAX, r.difficultyPoints) + SWEEP_BONUS));
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
