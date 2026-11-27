// 新手引導核心（2026-11-27，DECISIONS 20、docs/17 第 4 節 1–3）：上船（倒數前不計時）、角色卡、任務條、換階段清掉表決結果。
// 直接用 Room（假時鐘）。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARDING_LATER_MS, BOARDING_MS, Room } from '../src/server/room.ts';
import { CRISIS_AT } from '../src/engine/game.ts';
import { ROLE_BUNDLES, ROLE_CARD, ROLES, type RoleId } from '../src/server/content.ts';
import type { Action } from '../src/server/view.ts';

function setup(n: number, boardingMs = BOARDING_MS) {
  const clock = { t: 1_000_000 };
  const room = new Room('T', { now: () => clock.t, seed: 3, boardingMs });
  const ps = Array.from({ length: n }, (_, i) => room.addPlayer('p' + i));
  room.start(room.hostId!);
  const who = (role: RoleId) => ps.find((p) => room.round!.roles.get(p.id)!.includes(role))!.id;
  let k = 0;
  const act = (pid: string, a: Action) => room.act(pid, 'a' + k++, a);
  return { room, ps, clock, who, act };
}

test('上船：首局倒數前有 40 秒不計時，期間 phase＝boarding、不能操作、倒數不走；時間到進入認識隊友', () => {
  const s = setup(4);
  const v = s.room.view(s.ps[0].id, '', null);
  assert.equal(v.phase, 'boarding');
  assert.equal(v.round!.boardingMs, BOARDING_MS);
  assert.equal(v.round!.startedAt, s.clock.t + BOARDING_MS, '倒數從上船結束才開始');
  const rej = s.act(s.who('supply'), { type: 'setItem', item: '小船', on: false });
  assert.equal(rej?.reasons[0].code, 'BOARDING');
  s.clock.t += BOARDING_MS - 1;
  s.room.tick();
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'boarding');
  assert.equal(s.room.round!.game.now, 0, '規則時間不走');
  s.clock.t += 1;
  assert.ok(s.room.tick(), '上船結束要廣播');
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'intro');
  assert.equal(s.act(s.who('supply'), { type: 'setItem', item: '小船', on: false }), null);
});

test('上船：房主可以提早開船，別人不行；第二局起只有 10 秒', () => {
  const s = setup(3);
  const other = s.ps.find((p) => p.id !== s.room.hostId)!;
  assert.throws(() => s.room.skipBoarding(other.id), /房主/);
  s.clock.t += 5000;
  s.room.skipBoarding(s.room.hostId!);
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'intro');
  assert.equal(s.room.round!.startedAt, s.clock.t);
  // 走完一局
  s.room.round!.game = { ...s.room.round!.game, phase: 'ended' };
  s.room.next(s.room.hostId!);
  assert.equal(s.room.round!.boardingMs, BOARDING_LATER_MS);
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'boarding');
});

test('上船中斷線一半以上會暫停，連回來倒數照樣從上船結束開始', () => {
  const s = setup(4);
  s.clock.t += 10_000;
  s.room.disconnect(s.ps[1].id);
  s.room.disconnect(s.ps[2].id);
  assert.ok(s.room.pausedAt !== null);
  s.clock.t += 60_000;
  s.room.resume(s.ps[1].id, s.ps[1].token);
  assert.equal(s.room.pausedAt, null);
  assert.equal(s.room.view(s.ps[0].id, '', null).phase, 'boarding');
  assert.equal(s.room.round!.startedAt - s.clock.t, BOARDING_MS - 10_000);
});

test('角色卡：3–10 人每個人都有角色卡（台詞、故事裡的人、按鈕或「沒有按鈕」、只有你知道），不扮演保羅', () => {
  for (let n = 3; n <= 10; n++) {
    const s = setup(n, 0);
    for (const p of s.ps) {
      const rc = s.room.view(p.id, '', null).roleCard!;
      const mine = s.room.round!.roles.get(p.id)!;
      assert.deepEqual(rc.roles.map((r) => r.id), mine);
      for (const r of rc.roles) {
        assert.ok(r.line && r.who && r.know, `${n} 人 ${r.name}`);
        assert.ok(!/保羅|天使|百夫長/.test(r.who), '不扮演保羅、天使、百夫長');
        if (r.who !== '船上的人') assert.ok(r.ref, `${r.who} 要附出處`);
        if (r.button) assert.ok(r.when, '按鈕要寫什麼時候出現');
      }
    }
  }
  // 6 人以下沒有測水深：瞭望的角色卡寫拋錨按鈕
  const s6 = setup(6, 0);
  assert.equal(s6.room.view(s6.who('observer'), '', null).roleCard!.roles[0].button, '從船尾拋錨');
  const s7 = setup(7, 0);
  assert.equal(s7.room.view(s7.who('observer'), '', null).roleCard!.roles[0].button, null);
  // 每個職能都有角色卡文字
  for (const id of Object.keys(ROLES) as RoleId[]) assert.ok(ROLE_CARD[id]);
  assert.ok(Object.values(ROLE_BUNDLES).flat(2).every((id) => ROLE_CARD[id]));
});

test('任務條：上船時就有「現在要做的一件事」；沒有按鈕的人主句是去找誰（含對方角色）；管倉主句是自己的操作', () => {
  const s = setup(6);
  const medic = s.room.view(s.who('medic'), '', null);
  assert.equal(medic.phase, 'boarding');
  assert.ok(medic.task?.go, '醫生要去找人');
  assert.equal(medic.task!.go!.roleName, '伙房');
  assert.equal(medic.task!.go!.nickname, s.room.get(s.who('comms'))!.nickname);
  const sup = s.room.view(s.who('supply'), '', null);
  assert.ok(sup.task?.text, '管倉主句是自己的操作');
  assert.ok(sup.task?.go, '副句：先去問誰');
});

test('換階段就清掉上一階段的表決結果（夜裡不掛白天的「沒通過」）', () => {
  const s = setup(3, 0);
  for (const item of ['麥子', '器具', '小船'] as const) s.act(s.who('supply'), { type: 'setItem', item, on: false });
  s.clock.t += 61_000;
  s.room.tick();
  s.act(s.who('nav'), { type: 'lock' });
  const p = s.room.round!.proposal!;
  s.room.vote(p.voters[0], p.id, 'wait');
  assert.ok(s.room.view(s.ps[0].id, '', null).voteResult, '同一階段看得到沒通過');
  s.clock.t = s.room.round!.startedAt + CRISIS_AT;
  s.room.tick();
  assert.equal(s.room.round!.game.phase, 'blackout');
  assert.equal(s.room.view(s.ps[0].id, '', null).voteResult, null);
});
