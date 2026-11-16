// 團隊排行榜單元測試（src/server/leaderboard.ts、main.ts 的 fileLeaderboard）。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLASSIC } from '../src/engine/seeds.ts';
import type { ScoreRaw } from '../src/engine/score.ts';
import { MemoryStore, SqlStore, TEAM_NAME_MAX, TOP_N, checkTeamName, nameKey, rankBest, type LeaderRow, type LeaderboardStore, type SqlExec } from '../src/server/leaderboard.ts';
import { fileLeaderboard } from '../src/server/main.ts';

const RAW: ScoreRaw = {
  formula: 'v1-trial',
  stars: 3,
  repairMs: 20_000,
  repairLimitMs: 70_000,
  assistLevel: 0,
  slots: 4,
  firstRound: false,
  wrongPicks: 0,
  finishedAt: 200_000,
  cards: { a: 'A5', b: 'B4' },
  tonight: CLASSIC,
  sweep: false,
  solutions: 1,
  difficultyPoints: 80,
  playerCount: 6,
};

let seq = 0;
function row(name: string, score: number, at: number, roundId = `R${++seq}`): Omit<LeaderRow, 'id'> {
  return { roundId, name, key: nameKey(name), score, players: 6, at, formula: 'v1-trial', raw: RAW };
}

/** node:sqlite 的 SqlExec 轉接：select／insert…returning 回傳列，其他只執行。 */
function adapter(db: DatabaseSync): SqlExec {
  return (sql, ...p) => {
    const st = db.prepare(sql);
    if (/^\s*(select|insert[\s\S]*returning)/i.test(sql)) return st.all(...p) as Record<string, unknown>[];
    st.run(...p);
    return [];
  };
}

function memorySql(): { store: SqlStore; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return { store: new SqlStore(adapter(db)), db };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lb-test-'));
}

// ---------- 隊名檢查 ----------

test('隊名：空白、全空白、只有標點或控制字元＝EMPTY', () => {
  for (const x of ['', '   ', '　　', '...', '\u0000​', null, undefined]) {
    const r = checkTeamName(x);
    assert.equal(r.ok, false, JSON.stringify(x));
    if (!r.ok) assert.equal(r.reason, 'EMPTY');
  }
});

test('隊名：最多 12 個字（以字元計），13 個字＝TOO_LONG', () => {
  assert.equal(TEAM_NAME_MAX, 12);
  assert.equal(checkTeamName('一二三四五六七八九十甲乙').ok, true);
  const r = checkTeamName('一二三四五六七八九十甲乙丙');
  assert.deepEqual(r, { ok: false, reason: 'TOO_LONG' });
  assert.equal(checkTeamName('隊' + '😀'.repeat(11)).ok, true, '表情符號每個算一個字');
  assert.equal(checkTeamName('隊' + '😀'.repeat(12)).ok, false);
  const emo = checkTeamName('😀😀');
  assert.ok(emo.ok, '只有表情符號也可以當隊名');
});

test('隊名：正常中文與英數隊名通過，並去掉前後空白、合併連續空白', () => {
  for (const n of ['保羅船長隊', '勇敢的小隊', '第 3 小隊', 'Team Alpha']) assert.equal(checkTeamName(n).ok, true, n);
  const r = checkTeamName('  保羅   船長  ');
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.name, '保羅 船長');
});

test('隊名：控制字元與零寬字元會被去掉', () => {
  const r = checkTeamName('保\u0000羅​船\u0007長‮隊');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.name, '保羅船長隊');
    assert.equal(r.key, nameKey('保羅船長隊'));
  }
});

test('隊名：不雅字詞被擋（中文、英文、大小寫）', () => {
  for (const n of ['幹你娘', '去死隊', 'Fuck Team', 'SHIT', 'bitch隊', '白痴', '靠北']) {
    const r = checkTeamName(n);
    assert.deepEqual(r, { ok: false, reason: 'BLOCKED' }, n);
  }
});

test('隊名：不雅字詞夾空白、標點、全形、leet 變形也被擋', () => {
  for (const n of ['f u c k', 'f.u.c.k', 'f-u-c-k', 'ＦＵＣＫ', 'Ｓｈｉｔ', '幹 你', '幹．你', '幹、你', 'sh1t', '5h1t', 'b1tch', 'fvck'.replace('v', 'u'), 'p0rn', 'a55hole']) {
    const r = checkTeamName(n);
    assert.equal(r.ok, false, n);
  }
});

// 已知缺口：nameKey 先把標點／符號（含 $、@）刪掉，才做 leet 還原，所以用 $ 代 s 的變形漏掉。
test('隊名：用 $ 或 @ 取代字母的不雅變形也要被擋', () => {
  for (const n of ['$hit', 'a$$hole', '$lut']) assert.equal(checkTeamName(n).ok, false, n);
});

test('nameKey：全形半形、大小寫、空白標點統一', () => {
  assert.equal(nameKey('ＡＢＣ'), 'abc');
  assert.equal(nameKey('A b-C'), 'abc');
  assert.equal(nameKey('保羅 船長!'), '保羅船長');
});

// ---------- rankBest ----------

function fakeRow(id: number, name: string, score: number, at: number): LeaderRow {
  return { ...row(name, score, at), id };
}

test('rankBest：同隊只留最高分；同分取較早；分數高→低、同分較早在前', () => {
  const ranked = rankBest([fakeRow(1, 'A隊', 500, 10), fakeRow(2, 'A隊', 700, 20), fakeRow(3, 'B隊', 700, 5), fakeRow(4, 'C隊', 300, 1), fakeRow(5, 'A隊', 700, 1)]);
  assert.deepEqual(ranked.map((r) => [r.name, r.score, r.at]), [['A隊', 700, 1], ['B隊', 700, 5], ['C隊', 300, 1]]);
});

test('rankBest：同一時間同分時依登記順序（id）決定', () => {
  const ranked = rankBest([fakeRow(2, 'B隊', 500, 7), fakeRow(1, 'A隊', 500, 7)]);
  assert.deepEqual(ranked.map((r) => r.name), ['A隊', 'B隊']);
});

// ---------- MemoryStore 行為（SqlStore 共用同一套） ----------

const makers: [string, () => LeaderboardStore][] = [
  ['MemoryStore', () => new MemoryStore()],
  ['SqlStore（node:sqlite 記憶體資料庫）', () => memorySql().store],
];

for (const [label, make] of makers) {
  test(`${label}：同隊名（大小寫、全形差異）只保留最高分`, () => {
    const s = make();
    s.add(row('Alpha', 500, 1));
    s.add(row('ＡＬＰＨＡ', 800, 2));
    s.add(row('alpha ', 600, 3));
    const top = s.top();
    assert.equal(top.length, 1);
    assert.equal(top[0].score, 800);
    assert.equal(top[0].name, 'ＡＬＰＨＡ');
  });

  test(`${label}：同隊同分，較早的那筆留著；隊與隊同分，較早者在前`, () => {
    const s = make();
    s.add(row('乙隊', 600, 10));
    s.add(row('甲隊', 600, 5));
    s.add(row('甲隊', 600, 99));
    s.add(row('丙隊', 600, 20));
    assert.deepEqual(s.top().map((e) => [e.name, e.at]), [['甲隊', 5], ['乙隊', 10], ['丙隊', 20]]);
    assert.deepEqual(s.top().map((e) => e.rank), [1, 2, 3]);
  });

  test(`${label}：top 只回前 10 名，可指定較少名次`, () => {
    const s = make();
    for (let i = 0; i < 15; i++) s.add(row(`隊${i}`, 100 + i, i));
    assert.equal(TOP_N, 10);
    assert.equal(s.top().length, 10);
    assert.equal(s.top()[0].score, 114);
    assert.equal(s.top()[9].score, 105);
    assert.equal(s.top(3).length, 3);
    assert.deepEqual(s.top(3).map((e) => e.rank), [1, 2, 3]);
  });

  test(`${label}：add 回傳這隊的名次、是否最好成績、最好分數`, () => {
    const s = make();
    assert.deepEqual(s.add(row('甲', 500, 1)), { rank: 1, best: true, bestScore: 500 });
    assert.deepEqual(s.add(row('乙', 700, 2)), { rank: 1, best: true, bestScore: 700 });
    assert.deepEqual(s.add(row('甲', 400, 3)), { rank: 2, best: false, bestScore: 500 });
    assert.deepEqual(s.add(row('甲', 900, 4)), { rank: 1, best: true, bestScore: 900 });
    assert.deepEqual(s.add(row('丙', 700, 5)), { rank: 3, best: true, bestScore: 700 });
    assert.deepEqual(s.add(row('甲', 900, 6)), { rank: 1, best: false, bestScore: 900 }, '同分重複登記不算最好');
  });

  test(`${label}：同一 roundId 第二次 add 丟錯，且 hasRound 為真`, () => {
    const s = make();
    assert.equal(s.hasRound('X1'), false);
    s.add(row('甲', 500, 1, 'X1'));
    assert.equal(s.hasRound('X1'), true);
    assert.throws(() => s.add(row('乙', 900, 2, 'X1')), /已經登記過/);
    assert.equal(s.all().length, 1);
    assert.equal(s.top().length, 1);
  });

  test(`${label}：all 回傳每筆登記（含原始資料與公式版本），用 id 排序`, () => {
    const s = make();
    s.add(row('甲', 500, 1));
    s.add(row('甲', 600, 2));
    const all = s.all();
    assert.deepEqual(all.map((r) => r.id), [1, 2]);
    assert.deepEqual(all[0].raw, RAW);
    assert.equal(all[0].formula, 'v1-trial');
    assert.equal(all[1].players, 6);
  });

  test(`${label}：setHidden 隱藏後那隊從榜上消失、恢復後回來；資料不刪`, () => {
    const s = make();
    s.add(row('甲', 800, 1));
    s.add(row('乙', 600, 2));
    s.add(row('丙', 400, 3));
    const id = s.all().find((r) => r.name === '乙')!.id;
    s.setHidden(id, true);
    assert.deepEqual(s.top().map((e) => [e.rank, e.name]), [[1, '甲'], [2, '丙']]);
    assert.equal(s.all().length, 3, '資料還在');
    assert.equal(s.all().find((r) => r.id === id)!.hidden, true);
    s.setHidden(id, false);
    assert.deepEqual(s.top().map((e) => [e.rank, e.name]), [[1, '甲'], [2, '乙'], [3, '丙']]);
    s.setHidden(9999, true); // 不存在的 id 不丟錯
    assert.equal(s.top().length, 3);
  });

  test(`${label}：隱藏某隊最高那筆 → 改顯示該隊次高；全部隱藏 → 該隊消失；roundId 仍算已登記`, () => {
    const s = make();
    s.add(row('甲', 900, 1, 'H1'));
    s.add(row('甲', 500, 2, 'H2'));
    s.add(row('乙', 700, 3, 'H3'));
    const top = s.all().find((r) => r.roundId === 'H1')!.id;
    const second = s.all().find((r) => r.roundId === 'H2')!.id;
    s.setHidden(top, true);
    assert.deepEqual(s.top().map((e) => [e.name, e.score]), [['乙', 700], ['甲', 500]]);
    s.setHidden(second, true);
    assert.deepEqual(s.top().map((e) => e.name), ['乙']);
    assert.equal(s.hasRound('H1'), true);
    assert.throws(() => s.add(row('甲', 100, 4, 'H1')), /已經登記過/);
  });
}

test('MemoryStore 與 SqlStore：同一組資料，每步 add 結果與 top／all 完全一致', () => {
  const mem = new MemoryStore();
  const { store: sql } = memorySql();
  const data: [string, number, number][] = [];
  for (let i = 0; i < 40; i++) data.push([`隊${i % 14}`, 100 + ((i * 37) % 9) * 50, i % 5 === 0 ? 3 : i]);
  data.push(['ＡＢＣ', 500, 100], ['abc', 500, 101], ['A B C', 650, 102]);
  data.forEach(([name, score, at], i) => {
    const r = row(name, score, at, `ROUND-${i}`);
    assert.deepEqual(sql.add(r), mem.add(r), `第 ${i} 筆`);
  });
  assert.deepEqual(sql.top(), mem.top());
  assert.deepEqual(sql.top(4), mem.top(4));
  // SqlStore 一定有 hidden 欄（false）；MemoryStore 未隱藏時可能沒有這欄，所以先補成 false 再比
  const norm = (rows: LeaderRow[]) => rows.map((r) => ({ ...r, hidden: r.hidden ?? false }));
  assert.deepEqual(norm(sql.all()), norm(mem.all()));
});

// ---------- 重開後仍在 ----------

test('SqlStore：同一個資料庫檔關掉再開，排行榜與登記過的 roundId 都還在', () => {
  const dir = tmpDir();
  const file = join(dir, 'lb.sqlite');
  try {
    let db = new DatabaseSync(file);
    let s = new SqlStore(adapter(db));
    s.add(row('保羅隊', 800, 1, 'R-A'));
    s.add(row('船長隊', 600, 2, 'R-B'));
    db.close();

    db = new DatabaseSync(file);
    s = new SqlStore(adapter(db));
    assert.deepEqual(s.top().map((e) => [e.rank, e.name, e.score]), [[1, '保羅隊', 800], [2, '船長隊', 600]]);
    assert.equal(s.hasRound('R-A'), true);
    assert.throws(() => s.add(row('保羅隊', 999, 3, 'R-A')), /已經登記過/);
    assert.deepEqual(s.add(row('船長隊', 900, 4, 'R-C')), { rank: 1, best: true, bestScore: 900 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- fileLeaderboard ----------

test('fileLeaderboard：不給檔名＝只在記憶體，不會寫檔', () => {
  const s = fileLeaderboard(null);
  s.add(row('甲', 500, 1));
  assert.equal(s.top().length, 1);
  assert.equal(fileLeaderboard(undefined).top().length, 0);
});

test('fileLeaderboard：檔案不存在時是空榜；寫入後（含自動建資料夾）新建一個仍讀得到', () => {
  const dir = tmpDir();
  const file = join(dir, 'data', 'nested', 'leaderboard.json');
  try {
    const a = fileLeaderboard(file);
    assert.equal(a.top().length, 0);
    assert.equal(existsSync(file), false, '還沒登記就不寫檔');
    a.add(row('甲隊', 700, 1, 'F1'));
    a.add(row('乙隊', 900, 2, 'F2'));
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.tmp`), false, '暫存檔已改名，不留殘檔');
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { rows: unknown[] }).rows.length, 2);

    const b = fileLeaderboard(file);
    assert.deepEqual(b.top().map((e) => [e.name, e.score]), [['乙隊', 900], ['甲隊', 700]]);
    assert.equal(b.hasRound('F1'), true);
    assert.throws(() => b.add(row('丙隊', 100, 3, 'F1')), /已經登記過/);
    b.add(row('丙隊', 800, 4, 'F3'));
    assert.deepEqual(fileLeaderboard(file).top().map((e) => e.name), ['乙隊', '丙隊', '甲隊']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
