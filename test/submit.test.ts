// 登記上排行榜流程：Hub＋假連線，從建房、開局、補船、上岸到 submitScore。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, type Conn } from '../src/server/hub.ts';
import { MemoryStore } from '../src/server/leaderboard.ts';
import type { ServerMessage, View } from '../src/server/view.ts';

/** 假的手機連線：收集伺服器送來的所有訊息。 */
class FakeConn implements Conn {
  origin = 'http://test.local';
  roomCode: string | null = null;
  playerId: string | null = null;
  msgs: ServerMessage[] = [];
  send(data: string): void {
    this.msgs.push(JSON.parse(data) as ServerMessage);
  }
  get view(): View {
    const st = [...this.msgs].reverse().find((m) => m.t === 'state');
    if (!st || st.t !== 'state') throw new Error('還沒收到畫面');
    return st.view;
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
  errors(): string[] {
    return this.msgs.flatMap((m) => (m.t === 'error' ? [m.msg] : []));
  }
}

let actN = 0;
function send(hub: Hub, c: FakeConn, msg: unknown): void {
  hub.message(c, JSON.stringify(msg));
}
function act(hub: Hub, c: FakeConn, ev: unknown): void {
  send(hub, c, { t: 'act', id: `a${++actN}`, ev });
}
/** 要表決的動作（決定好了、用掉、衝向海灘）：按下後其他人都按同意（DECISIONS 18）。 */
function actVoted(hub: Hub, c: FakeConn, ev: unknown, conns: FakeConn[]): void {
  act(hub, c, ev);
  for (const o of conns) if (o !== c && o.view.vote?.canVote) send(hub, o, { t: 'vote', id: o.view.vote.id, choice: 'yes' });
}

/** 建房（房主＋2 位隊員），開局，一路玩到三星上岸（首局經典配置 A5＋B4）。 */
function playToSettled(opts: { practice?: boolean; board?: MemoryStore; players?: number } = {}) {
  const hub = new Hub({ introMs: 0, leaderboard: opts.board ?? new MemoryStore() });
  const n = opts.players ?? 3;
  const conns = Array.from({ length: n }, () => new FakeConn());
  conns.forEach((c) => hub.open(c));
  const [host] = conns;
  send(hub, host, { t: 'create', nickname: '房主', practice: opts.practice });
  const code = host.roomCode!;
  for (let i = 1; i < n; i++) send(hub, conns[i], { t: 'join', code, nickname: `隊員${i}` });
  const room = hub.rooms.get(code)!;
  room.forceCards = { a: 'A5', b: 'B4' };
  send(hub, host, { t: 'start' });

  const find = (pred: (v: View) => boolean) => {
    const c = conns.find((x) => pred(x.view));
    assert.ok(c, '找不到符合條件的手機');
    return c;
  };
  const sup = find((v) => v.can.items);
  for (const item of ['麥子', '器具', '小船']) act(hub, sup, { type: 'setItem', item, on: false });
  actVoted(hub, find((v) => v.can.lock), { type: 'lock' }, conns);
  assert.equal(host.view.phase, 'blackout');
  const eng = find((v) => v.can.repair);
  for (const slot of room.round!.game.repair!.slots) act(hub, eng, { type: 'repairPick', option: slot.answer });
  assert.equal(host.view.phase, 'replanning');
  actVoted(hub, find((v) => v.can.uses.some((u) => u.id === '吃飯')), { type: 'use', use: '吃飯' }, conns);
  act(hub, find((v) => v.can.items), { type: 'setItem', item: '糧食', on: false });
  actVoted(hub, find((v) => v.can.depart), { type: 'depart' }, conns);
  assert.equal(host.view.phase, 'settled');
  return { hub, conns, host, room, code };
}

test('登記：局還沒結束被拒', () => {
  const hub = new Hub({ introMs: 0 });
  const [host, b, c] = [new FakeConn(), new FakeConn(), new FakeConn()];
  [host, b, c].forEach((x) => hub.open(x));
  send(hub, host, { t: 'create', nickname: '房主' });
  send(hub, b, { t: 'join', code: host.roomCode, nickname: 'B' });
  send(hub, c, { t: 'join', code: host.roomCode, nickname: 'C' });
  send(hub, host, { t: 'submitScore', name: '保羅隊' });
  assert.match(host.errors().at(-1)!, /還沒有可以登記/);
  send(hub, host, { t: 'start' });
  send(hub, host, { t: 'submitScore', name: '保羅隊' });
  assert.match(host.errors().at(-1)!, /這局還沒結束/);
  assert.equal(hub.leaderboard.top().length, 0);
});

test('登記：非房主被拒，房主的 can.submit 為 true、其他人為 false', () => {
  const { hub, conns, host } = playToSettled();
  assert.equal(host.view.can.submit, true);
  for (const c of conns.slice(1)) assert.equal(c.view.can.submit, false);
  send(hub, conns[1], { t: 'submitScore', name: '偷登記隊' });
  assert.match(conns[1].errors().at(-1)!, /只有房主/);
  assert.equal(hub.leaderboard.top().length, 0);
});

test('登記：練習房被拒，訊息是「練習模式不計入排行榜」，view 標示 practice 且不顯示登記按鈕', () => {
  const { hub, host, conns } = playToSettled({ practice: true });
  assert.equal(host.view.result!.score!.practice, true);
  assert.equal(host.view.can.submit, false);
  send(hub, host, { t: 'submitScore', name: '練習隊' });
  assert.equal(host.errors().at(-1), '練習模式不計入排行榜');
  assert.equal(hub.leaderboard.top().length, 0);
  assert.equal(host.last('submitted'), undefined);
  assert.equal(conns[1].view.result!.score!.practice, true);
});

test('登記：正式房的 view.result.score.practice 為 false', () => {
  const { host } = playToSettled();
  assert.equal(host.view.result!.score!.practice, false);
});

test('登記：房主成功登記 → 收到 submitted、view 帶 submitted、can.submit 變 false、榜上有這隊', () => {
  const { hub, host, conns } = playToSettled();
  const total = host.view.result!.score!.total;
  assert.equal(host.view.result!.score!.submitted, null);
  send(hub, host, { t: 'submitScore', name: '  保羅船長隊 ' });
  assert.deepEqual(host.errors(), []);
  const sub = host.last('submitted')!;
  assert.deepEqual(sub, { t: 'submitted', name: '保羅船長隊', rank: 1, best: true, bestScore: total });
  assert.deepEqual(host.view.result!.score!.submitted, { name: '保羅船長隊', rank: 1, best: true, bestScore: total });
  assert.equal(host.view.can.submit, false);
  // 其他隊員也看得到已登記
  assert.equal(conns[1].view.result!.score!.submitted?.name, '保羅船長隊');
  assert.equal(conns[1].last('submitted'), undefined, 'submitted 只送給房主');
  const top = hub.leaderboard.top();
  assert.equal(top.length, 1);
  assert.equal(top[0].score, total);
  assert.equal(top[0].players, 3);
  // 存的是原始計分資料與公式版本
  const saved = hub.leaderboard.all()[0];
  assert.equal(saved.formula, 'v2-trial');
  assert.equal(saved.raw.stars, 3);
  assert.equal(saved.score, total);
});

test('登記：同一局第二次被拒，榜上仍只有一筆', () => {
  const { hub, host } = playToSettled();
  send(hub, host, { t: 'submitScore', name: '第一次' });
  send(hub, host, { t: 'submitScore', name: '第二次' });
  assert.match(host.errors().at(-1)!, /這局已經登記過了/);
  assert.equal(hub.leaderboard.all().length, 1);
  assert.equal(hub.leaderboard.top()[0].name, '第一次');
});

test('登記：不雅隊名、空隊名、過長隊名被拒，且可以改名再登記', () => {
  const { hub, host } = playToSettled();
  send(hub, host, { t: 'submitScore', name: 'fuck隊' });
  assert.equal(host.errors().at(-1), '這個名稱不太適合，換一個吧');
  send(hub, host, { t: 'submitScore', name: '   ' });
  assert.equal(host.errors().at(-1), '請輸入團隊名稱');
  send(hub, host, { t: 'submitScore', name: '一二三四五六七八九十甲乙丙' });
  assert.match(host.errors().at(-1)!, /最多 12 個字/);
  assert.equal(host.errors().length, 3);
  assert.equal(hub.leaderboard.all().length, 0);
  assert.equal(host.view.can.submit, true, '被拒不算登記，按鈕還在');
  send(hub, host, { t: 'submitScore', name: '正常隊名' });
  assert.equal(hub.leaderboard.top().length, 1);
});

test('登記：result.score 的 parts 依序 mission、teamwork、time、difficulty，加總×係數＝總分', () => {
  for (const n of [3, 6, 10]) {
    const { host } = playToSettled({ players: n });
    const sc = host.view.result!.score!;
    assert.deepEqual(sc.parts.map((p) => p.id), ['mission', 'teamwork', 'time', 'difficulty']);
    assert.deepEqual(sc.parts.map((p) => p.max), [600, 200, 100, 100]);
    for (const p of sc.parts) assert.ok(p.points >= 0 && p.points <= p.max, `${n} 人 ${p.id}`);
    assert.equal(sc.parts[0].points, 600, '三星＝600');
    assert.equal(sc.total, Math.min(1000, Math.max(0, Math.round(sc.parts.reduce((s, p) => s + p.points, 0) * sc.factor))));
    assert.equal(sc.max, 1000);
    assert.equal(sc.trial, true);
    assert.equal(sc.formula, 'v2-trial');
  }
});

test('登記：同隊名多局只留最高分；第二隊的名次依分數排', () => {
  const board = new MemoryStore();
  const a = playToSettled({ board });
  send(a.hub, a.host, { t: 'submitScore', name: '保羅隊' });
  const first = a.host.last('submitted')!;
  assert.equal(first.rank, 1);
  // 另一局（另一個房間、同一個榜）用同一個隊名
  const b = playToSettled({ board });
  send(b.hub, b.host, { t: 'submitScore', name: '保羅隊' });
  assert.equal(b.host.last('submitted')!.rank, 1);
  assert.equal(board.top().length, 1, '同隊名只顯示一列');
  assert.equal(board.all().length, 2, '但兩次登記都存了');
});

test('排行榜訊息：{t:"leaderboard"} 回傳前 10 名、公式版本與試行標記；未加入房間也能查', () => {
  const board = new MemoryStore();
  for (let i = 0; i < 13; i++) {
    board.add({ roundId: `seed-${i}`, name: `隊${i}`, key: `隊${i}`, score: 100 + i * 10, players: 4, at: i, formula: 'v1-trial', raw: {} as never });
  }
  const hub = new Hub({ leaderboard: board });
  const c = new FakeConn();
  hub.open(c);
  send(hub, c, { t: 'leaderboard' });
  const m = c.last('leaderboard')!;
  assert.equal(m.entries.length, 10);
  assert.equal(m.entries[0].score, 220);
  assert.equal(m.entries[0].rank, 1);
  assert.equal(m.entries[9].score, 130);
  assert.equal(m.formula, 'v2-trial');
  assert.equal(m.trial, true);
  assert.deepEqual(hub.leaderboardJson().entries, m.entries);
});

test('登記：房主斷線後，新加入者不會搶到房主，房主轉給這局的隊員', () => {
  const { hub, conns, host, code, room } = playToSettled({ players: 4 });
  const late = new FakeConn();
  hub.open(late);
  hub.close(host); // 房主斷線
  send(hub, late, { t: 'join', code, nickname: '路人' });
  const hostId = room.hostId!;
  assert.ok(room.round!.participants.includes(hostId), '房主是這局隊員');
  assert.notEqual(hostId, late.playerId);
  assert.equal(late.view.can.submit, false);
  assert.equal(conns[1].view.can.submit, true, '轉給還在線的隊員');
  send(hub, late, { t: 'submitScore', name: '路人隊' });
  assert.equal(hub.leaderboard.all().length, 0);
});

test('登記：局後才加入的人成為房主（隊員全離線）時，登記被拒：只有這局的隊員可以登記上榜', () => {
  const { hub, conns, code, room } = playToSettled({ players: 3 });
  for (const c of conns) hub.close(c); // 三位隊員都斷線
  const late = new FakeConn();
  hub.open(late);
  send(hub, late, { t: 'join', code, nickname: '路人' });
  assert.equal(room.hostId, late.playerId, '沒有隊員在線時路人暫代房主');
  assert.equal(room.round!.participants.includes(late.playerId!), false);
  send(hub, late, { t: 'submitScore', name: '路人隊' });
  assert.match(late.errors().at(-1)!, /只有這局的隊員可以登記上榜/);
  assert.equal(hub.leaderboard.all().length, 0);
});

test('結算明細：teamwork 的說明是「大家一起補船 N 秒」，不寫協助等級', () => {
  const { host } = playToSettled();
  const tw = host.view.result!.score!.parts.find((p) => p.id === 'teamwork')!;
  assert.match(tw.detail, /^大家一起補船 \d+ 秒$/);
  assert.doesNotMatch(tw.detail, /協助/);
});
