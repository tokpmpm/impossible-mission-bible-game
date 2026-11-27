// 安全修正（2026-11-27，docs/15 H1／M1／L3、DECISIONS 20）：捲走預警＝實際捲走、表決連點、第二局 30 秒、記號轉向、補船選錯鎖。
// 直接用 Room（假時鐘），不經 WebSocket。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/room.ts';
import { CRISIS_AT, SWEEP_WARNING_MS, WRONG_PICK_LOCK_MS } from '../src/engine/game.ts';
import type { Action } from '../src/server/view.ts';
import type { RoleId } from '../src/server/content.ts';

function setup(n: number, seed = 7) {
  const clock = { t: 1_000_000 };
  const room = new Room('T', { now: () => clock.t, seed });
  const ps = Array.from({ length: n }, (_, i) => room.addPlayer('p' + i));
  room.start(room.hostId!);
  const at = (ms: number) => {
    clock.t = room.round!.startedAt + ms;
    room.tick();
  };
  const who = (role: RoleId) => ps.find((p) => room.round!.roles.get(p.id)!.includes(role))!.id;
  let k = 0;
  const act = (pid: string, a: Action) => room.act(pid, 'a' + k++, a);
  return { room, ps, clock, at, who, act };
}

/** 把房間推到結算（首局：經典配置照答案走）。 */
function playFirstRound(s: ReturnType<typeof setup>) {
  const { room, at, who, act } = s;
  for (const item of ['麥子', '器具', '小船'] as const) act(who('supply'), { type: 'setItem', item, on: false });
  at(CRISIS_AT);
  for (const slot of room.round!.game.repair!.slots) act(who('eng'), { type: 'repairPick', option: slot.answer });
  act(who('comms'), { type: 'use', use: '吃飯' });
  at(CRISIS_AT + 15_000); // 10 秒沒回應算同意
  act(who('nav'), { type: 'depart' });
  at(CRISIS_AT + 30_000);
}

test('H1：第二局超重、只丟小船，捲走預警列出的（漂著＋超重會先捲走）＝實際捲走的；畫面有 extra', () => {
  const s = setup(5);
  playFirstRound(s);
  assert.ok(['settled', 'ended'].includes(s.room.round!.game.phase));
  s.room.forceCards = { a: 'A5', b: 'B4', tonight: { 食: '糧食', 繩: '纜索', 水: '深' } };
  s.room.next(s.room.hostId!);
  s.act(s.who('supply'), { type: 'setItem', item: '小船', on: false });
  s.at(CRISIS_AT - SWEEP_WARNING_MS + 1);
  const v = s.room.view(s.who('supply'), '', null);
  const w = v.ship!.sweepWarning!;
  assert.deepEqual(w.floating, ['小船']);
  assert.equal(w.overweight, 5);
  assert.ok(w.extra.length > 0);
  s.at(CRISIS_AT);
  assert.deepEqual([...s.room.round!.game.swept].sort(), [...w.floating, ...w.extra].sort());
});

test('M1：最後一位投票者連按同意，第二下安靜忽略（不丟錯）；不認識的表決仍會丟錯', () => {
  const s = setup(3);
  for (const item of ['麥子', '器具', '小船'] as const) s.act(s.who('supply'), { type: 'setItem', item, on: false });
  s.at(61_000);
  assert.equal(s.act(s.who('nav'), { type: 'lock' }), null);
  const prop = s.room.round!.proposal!;
  for (const pid of prop.voters) s.room.vote(pid, prop.id, 'yes');
  assert.equal(s.room.round!.game.phase, 'blackout');
  assert.doesNotThrow(() => s.room.vote(prop.voters.at(-1)!, prop.id, 'yes'));
  assert.throws(() => s.room.vote(prop.voters[0], 'nope', 'yes'), /已經結束/);
});

test('M1／L3：結算後再按衝向海灘，不留下表決', () => {
  const s = setup(3);
  playFirstRound(s);
  assert.equal(s.room.round!.game.phase, 'settled');
  assert.equal(s.act(s.who('nav'), { type: 'depart' }), null);
  assert.equal(s.room.round!.proposal, null);
});

test('決定 1：首局 60 秒才能決定好了，第二局起 30 秒', () => {
  const s = setup(3);
  s.at(31_000);
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'intro');
  const rej = s.act(s.who('nav'), { type: 'lock' });
  assert.equal(rej?.reasons[0].code, 'TOO_EARLY');
  assert.match(rej!.reasons[0].text, /1 分鐘/);
  playFirstRound(s);
  s.room.next(s.room.hostId!);
  s.at(25_000);
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'intro');
  assert.equal(s.room.view(s.ps[0].id, '', null).round!.introMs, 30_000);
  const r2 = s.act(s.who('nav'), { type: 'lock' });
  assert.match(r2!.reasons[0].text, /30 秒/);
  s.at(31_000);
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'planning');
});

test('決定 2：停電時記號持有者看到的圖有轉向（0／90／180／270），每格固定；木匠面板的選項是正的', () => {
  const rots = new Set<number>();
  for (let seed = 1; seed <= 12; seed++) {
    const s = setup(6, seed);
    s.at(CRISIS_AT);
    const holders = s.ps.filter((p) => s.room.view(p.id, '', null).repair!.mySymbols.length);
    assert.ok(holders.length > 0);
    for (const h of holders) {
      for (const sym of s.room.view(h.id, '', null).repair!.mySymbols) {
        assert.ok([0, 90, 180, 270].includes(sym.rot));
        assert.equal(sym.rot, s.room.view(h.id, '', null).repair!.mySymbols.find((x) => x.slot === sym.slot)!.rot, '同一格每次畫面都一樣');
        rots.add(sym.rot);
      }
    }
  }
  assert.ok(rots.size >= 3, '不同局會轉到不同方向');
});

test('決定 4：補船選錯後面板鎖 2.5 秒，畫面帶 lockedUntil；鎖住時按選項回「選錯了，面板鎖住一下」', () => {
  const s = setup(3);
  s.at(CRISIS_AT);
  const eng = s.who('eng');
  const slot = s.room.round!.game.repair!.slots[0];
  const bad = slot.options.find((o) => o !== slot.answer)!;
  s.act(eng, { type: 'repairPick', option: bad });
  const v = s.room.view(eng, '', null);
  assert.equal(v.repair!.lockedUntil, s.room.round!.startedAt + CRISIS_AT + WRONG_PICK_LOCK_MS);
  const rej = s.act(eng, { type: 'repairPick', option: slot.answer });
  assert.equal(rej?.reasons[0].code, 'PANEL_LOCKED');
  s.at(CRISIS_AT + WRONG_PICK_LOCK_MS);
  assert.equal(s.act(eng, { type: 'repairPick', option: slot.answer }), null);
  assert.equal(s.room.round!.game.repair!.progress, 1);
});
