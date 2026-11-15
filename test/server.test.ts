// 伺服器整合測試：真的 WebSocket，多個模擬手機（第一關保羅海難）。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server/main.ts';
import type { ServerMessage, View, Action } from '../src/server/view.ts';
import { Room, PLAN_CHANGERS } from '../src/server/room.ts';
import { execFileSync } from 'node:child_process';

class Phone {
  ws!: WebSocket;
  view: View | null = null;
  playerId = '';
  token = '';
  code = '';
  errors: string[] = [];
  acks: string[] = [];
  rejections: Extract<ServerMessage, { t: 'rejected' }>[] = [];
  private waiters: (() => void)[] = [];
  private url: string;
  constructor(url: string) {
    this.url = url;
  }

  async open(): Promise<this> {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'state') this.view = m.view;
      if (m.t === 'welcome') Object.assign(this, { playerId: m.playerId, token: m.token, code: m.code });
      if (m.t === 'error') this.errors.push(m.msg);
      if (m.t === 'ack') this.acks.push(m.id);
      if (m.t === 'rejected') this.rejections.push(m);
      this.waiters.splice(0).forEach((w) => w());
    });
    await new Promise((r) => this.ws.once('open', r));
    return this;
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  act(ev: Action, id = Math.random().toString(36).slice(2)): string {
    this.send({ t: 'act', id, ev });
    return id;
  }
  async until(pred: (v: View) => boolean, ms = 3000): Promise<View> {
    const end = Date.now() + ms;
    while (!(this.view && pred(this.view))) {
      if (Date.now() > end) throw new Error(`等不到條件；最後 phase=${this.view?.phase} errors=${this.errors.join(',')}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return this.view!;
  }
  close(): void {
    this.ws.close();
  }
}

// introMs 預設 0：大部分測試要馬上鎖定；「前 60 秒不能鎖定」另外測
async function setup(n: number, introMs = 0) {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20, introMs });
  const url = `ws://localhost:${srv.port}/ws`;
  const host = await new Phone(url).open();
  host.send({ t: 'create', nickname: '房主' });
  await host.until((v) => v.phase === 'lobby');
  const phones = [host];
  for (let i = 1; i < n; i++) {
    const p = await new Phone(url).open();
    p.send({ t: 'join', code: host.code, nickname: `隊員${i}` });
    phones.push(p);
  }
  await host.until((v) => v.players.length === n);
  return { srv, url, phones, host };
}

function who(phones: Phone[], pred: (v: View) => boolean): Phone {
  const p = phones.find((x) => x.view && pred(x.view));
  if (!p) throw new Error('找不到符合條件的手機');
  return p;
}

async function repair(phones: Phone[]): Promise<void> {
  await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
  const eng = who(phones, (v) => v.can.repair);
  // 依 order 問持符號的人
  for (const { slot, nickname } of eng.view!.repair!.order) {
    const holder = who(phones, (v) => v.me.nickname === nickname);
    const sym = holder.view!.repair!.mySymbols.find((s) => s.slot === slot)!;
    eng.act({ type: 'repairPick', option: sym.id });
    await eng.until((v) => (v.repair?.progress ?? 0) > slot || v.phase === 'replanning');
  }
  await Promise.all(phones.map((p) => p.until((v) => v.phase === 'replanning')));
}

function roomOf(srv: { rooms: Map<string, unknown> }, code: string): Room {
  return srv.rooms.get(code) as Room;
}

const ALL = ['糧食', '纜索', '錨', '麥子', '器具', '小船'] as const;
async function keepOnly(sup: Phone, items: string[]): Promise<void> {
  for (const i of ALL) sup.act({ type: 'setItem', item: i, on: items.includes(i) });
  await sup.until((v) => v.ship!.items.filter((x) => x.onShip).map((x) => x.id).join() === ALL.filter((i) => items.includes(i) && sup.view!.ship!.items.find((x) => x.id === i && !x.gone)).join());
}

for (const n of [3, 6, 10]) {
  test(`${n} 人：開房 → 故事卡 → 丟東西 → 決定好了 → 黑暗補船 → 吃飯 → 三星 → 感謝 → 下一局換卡`, async () => {
    const { srv, phones, host } = await setup(n);
    try {
      phones[1].send({ t: 'pref', value: 'coat' });
      roomOf(srv, host.code).forceCards = { a: 'A5', b: 'B4' };
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
      // 每個人都看得到起風卡與船；按鈕只在負責的人手機上
      for (const p of phones) {
        assert.equal(p.view!.cards.a?.id, 'A5');
        assert.equal(p.view!.ship!.items.length, 6);
        assert.equal(p.view!.ship!.needs, null, '危機前不顯示三件事亮不亮');
      }
      assert.equal(phones.filter((p) => p.view!.can.items).length, 1);
      assert.equal(phones.filter((p) => p.view!.can.lock).length, 1);
      assert.equal(phones.filter((p) => p.view!.can.eat).length, 0);
      const sup = who(phones, (v) => v.can.items);
      const cap = who(phones, (v) => v.can.lock);
      // 沒按鈕的人有一句任務
      for (const p of phones.filter((x) => x !== sup && x !== cap)) assert.ok(/告訴/.test(p.view!.myTask ?? '') || p.view!.nextSteps.length > 0, '沒有按鈕的人要知道找誰');
      // 超重時「決定好了」被擋下，只回給按的人
      cap.act({ type: 'lock' });
      await cap.until(() => cap.rejections.length > 0);
      assert.match(cap.rejections[0].reasons[0].text, /超重 7/);
      await keepOnly(sup, ['糧食', '纜索', '錨']);
      cap.act({ type: 'lock' });
      await repair(phones);
      const v = host.view!;
      assert.equal(v.crisis!.starsBefore, 3);
      assert.equal(v.cards.b?.id, 'B4');
      assert.equal(v.ship!.cap, 4);
      assert.equal(v.ship!.stars, 3);
      assert.deepEqual(v.ship!.reasonCodes, ['OVERWEIGHT']);
      // B4：醫生那段「吃了就有力氣」全隊都看得到
      for (const p of phones) assert.ok(p.view!.clues.some((c) => c.breakthrough === 1), `${n} 人 B4 線索公開`);
      // 突破口三段在三支手機
      const owners = [1, 2, 3].map((b) => phones.filter((p) => p.view!.clues.some((c) => c.breakthrough === b && !c.shared)).length);
      assert.deepEqual(owners, [1, 1, 1]);
      const cook = who(phones, (x) => x.can.eat);
      assert.ok(cook.view!.clues.some((c) => c.breakthrough === 3), '吃飯按鈕與第三段線索在同一支手機');
      cook.act({ type: 'eat' });
      await host.until((x) => x.ship!.fed);
      assert.ok(host.view!.ship!.fedAt);
      await keepOnly(sup, ['纜索', '錨']);
      await cap.until((x) => x.ship!.reasons.length === 0);
      cap.act({ type: 'depart' });
      await Promise.all(phones.map((p) => p.until((x) => x.phase === 'settled')));
      const res = host.view!.result!;
      assert.equal(res.stars, 3);
      assert.equal(res.title, '上岸很順利！');
      assert.ok(res.moments.some((m) => m.text.includes('召集大家吃飯')));
      assert.ok(res.moments.some((m) => m.text.includes('外衣')));
      assert.match(res.verse.ref, /27:35/);
      phones[1].send({ t: 'thank', to: host.playerId });
      await host.until((x) => x.result!.thanks.length === 1);
      host.send({ t: 'next' });
      await Promise.all(phones.map((p) => p.until((x) => x.phase === 'intro' || x.phase === 'planning')));
      assert.equal(host.view!.round!.no, 2);
      assert.ok(host.view!.cards.a?.id !== 'A5', '第二局換一張起風卡');
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  });
}

test('故事卡 A1＋B5：危機前麥子丟不掉；補好船後錨已拋下、留著糧食不算力氣', async () => {
  const { srv, phones, host } = await setup(4);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A1', b: 'B5' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    assert.ok(sup.view!.ship!.items.find((i) => i.id === '麥子')!.pinned);
    sup.act({ type: 'setItem', item: '麥子', on: false });
    await sup.until(() => sup.rejections.length > 0);
    assert.match(sup.rejections[0].reasons[0].text, /船主不准丟麥子/);
    const cap = who(phones, (v) => v.can.lock);
    await keepOnly(sup, ['糧食', '纜索', '麥子']);
    cap.act({ type: 'lock' });
    await repair(phones);
    await keepOnly(sup, ['糧食', '纜索']);
    assert.ok(cap.view!.ship!.items.find((i) => i.id === '錨')!.gone);
    assert.deepEqual(cap.view!.ship!.needs!.filter((n) => n.lit).map((n) => n.id), ['船身', '天亮']);
    cap.act({ type: 'depart' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'settled')));
    assert.equal(host.view!.result!.stars, 2);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('吃飯：糧食丟了不能吃，伙房看到要先撈回；伙房以外的人沒有吃飯按鈕', async () => {
  const { srv, phones, host } = await setup(6);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A2', b: 'B2' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    await keepOnly(sup, ['纜索', '錨']);
    who(phones, (v) => v.can.lock).act({ type: 'lock' });
    await repair(phones);
    const cook = who(phones, (v) => v.can.eat);
    assert.equal(cook.view!.eatNeedsFood, true);
    assert.equal(phones.filter((p) => p.view!.can.eat).length, 1);
    cook.act({ type: 'eat' });
    await cook.until(() => cook.rejections.length > 0);
    assert.match(cook.rejections[0].reasons[0].text, /撈回/);
    // B2：小船自動離船
    assert.ok(host.view!.ship!.items.find((i) => i.id === '小船')!.gone);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('F01：人數不足不能開始；11 人以上進不來', async () => {
  const { srv, url, phones, host } = await setup(2);
  try {
    assert.equal(host.view!.can.start, false);
    host.send({ t: 'start' });
    await host.until(() => host.errors.length > 0);
    const extra: Phone[] = [];
    for (let i = 0; i < 9; i++) {
      const p = await new Phone(url).open();
      p.send({ t: 'join', code: host.code, nickname: `加${i}` });
      extra.push(p);
    }
    for (let i = 0; i < 60 && extra[8].errors.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(extra[8].errors[0], /已滿/);
    extra.forEach((p) => p.close());
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('F18：斷線重連回到原角色；房主離線會移交；重送同一個動作代號不會重複執行；別人的操作被拒', async () => {
  const { srv, url, phones, host } = await setup(3);
  try {
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const victim = phones[1];
    const rolesBefore = victim.view!.me.roles.map((r) => r.id);
    victim.close();
    await host.until((v) => v.players.some((p) => p.id === victim.playerId && !p.connected));
    const again = await new Phone(url).open();
    again.send({ t: 'resume', playerId: victim.playerId, token: victim.token });
    await again.until((v) => v.phase === 'planning');
    assert.deepEqual(again.view!.me.roles.map((r) => r.id), rolesBefore);
    phones[1] = again;
    // 等所有手機都知道他回來了（離線期間他的操作暫時交給別人）
    await Promise.all(phones.map((p) => p.until((v) => v.players.every((x) => x.connected))));

    const supply = who(phones, (v) => v.can.items);
    supply.act({ type: 'setItem', item: '麥子', on: false }, 'dup-1');
    supply.act({ type: 'setItem', item: '麥子', on: true }, 'dup-2');
    supply.act({ type: 'setItem', item: '麥子', on: false }, 'dup-1');
    await supply.until(() => supply.acks.filter((a) => a === 'dup-1').length === 2);
    await supply.until((v) => v.ship!.items.find((i) => i.id === '麥子')!.onShip);

    const other = phones.find((p) => p !== supply)!;
    other.act({ type: 'setItem', item: '錨', on: false });
    await other.until(() => other.errors.length > 0);
    assert.match(other.errors[0], /不是你負責/);

    host.close();
    await phones[2].until((v) => v.players.some((p) => p.isHost && p.id !== host.playerId));
    await Promise.all(phones.slice(1).map((p) => p.until((v) => v.players.some((x) => x.id === host.playerId && !x.connected))));
    const ops = phones.slice(1).map((p) => p.view!.can);
    assert.ok(ops.some((c) => c.lock), '離線船長的按鈕交給在線的人');
    assert.ok(ops.some((c) => c.items));
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('F19：背包全跳過、全帶油燈、沒人帶油燈，都恰有一位非木匠拿著油燈', async () => {
  for (const prefs of [[null, null, null, null], ['lamp', 'lamp', 'lamp', 'lamp'], ['coat', 'nuts', 'song', null]]) {
    const { srv, phones, host } = await setup(4);
    try {
      phones.forEach((p, i) => p.send({ t: 'pref', value: prefs[i] }));
      await new Promise((r) => setTimeout(r, 100));
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
      const holders = phones.filter((p) => /^(你帶了油燈|倉庫配給你一盞油燈)/.test(p.view!.preferenceHint ?? ''));
      assert.equal(holders.length, 1, JSON.stringify(prefs));
      assert.equal(holders[0].view!.me.roles.some((r) => r.id === 'eng'), false);
      const others = phones.filter((p) => p !== holders[0]);
      const expect = prefs[0] === 'lamp' ? '帶油燈的 ' : '倉庫配給 ';
      for (const o of others) assert.ok(o.view!.preferenceHint!.startsWith(expect + holders[0].view!.me.nickname), o.view!.preferenceHint!);
      assert.deepEqual(host.view!.players.map((p) => p.pref), prefs);
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  }
});

test('F02／F03：3–10 每種人數，每人都有職能與開局線索；有「哪樣顧哪件」的線索分散在不同人；黑暗中每位非木匠都有記號或排除線索', async () => {
  for (let n = 3; n <= 10; n++) {
    const { srv, phones, host } = await setup(n);
    try {
      roomOf(srv, host.code).forceCards = { a: n % 2 ? 'A3' : 'A5', b: 'B1' };
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
      for (const p of phones) {
        assert.ok(p.view!.me.roles.length >= 1, `${n} 人`);
        assert.ok(p.view!.clues.length >= 1, `${n} 人：${p.view!.me.roles.map((r) => r.name)} 沒有開局線索`);
        // 6 人以下不出現玩家沒聽過的拆分職能名稱
        if (n <= 6) for (const c of p.view!.clues) assert.ok(!/測水深|船主|水手長|舵手/.test(c.role), `${n} 人出現 ${c.role}`);
      }
      // 三件事的對應線索都在場、且不全在同一個人
      const needHolders = (['力氣', '船身', '天亮'] as const).map((need) => phones.filter((p) => p.view!.clues.some((c) => c.need === need)));
      for (const hs of needHolders) assert.equal(hs.length, 1, `${n} 人：三件事的線索各一人`);
      assert.ok(new Set(needHolders.map((h) => h[0])).size >= 2, `${n} 人：三件事線索至少分在兩支手機`);
      // 每人至少有一條會影響決定的線索（三件事或誘答），或有操作
      for (const p of phones) {
        const v = p.view!;
        const tips = ['黑暗中', '補船小撇步'];
        const useful = v.clues.some((c) => !tips.includes(c.title)) || v.can.items || v.can.lock;
        assert.ok(useful, `${n} 人：${v.me.roles.map((r) => r.name)} 沒有有效線索也沒有操作`);
      }
      who(phones, (v) => v.can.lock);
      const sup = who(phones, (v) => v.can.items);
      await keepOnly(sup, ['糧食', '纜索', '錨']);
      who(phones, (v) => v.can.lock).act({ type: 'lock' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
      for (const p of phones) {
        const r = p.view!.repair!;
        const isEng = p.view!.can.repair;
        if (!isEng) assert.ok(r.mySymbols.length > 0 || r.myEliminationClue, `${n} 人：${p.view!.me.nickname} 黑暗中沒事做`);
      }
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  }
});

test('前 60 秒不能決定：按的人收到 rejected（原因＋還剩幾秒），別人沒收到', async () => {
  const { srv, phones, host } = await setup(3, 1500);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A2', b: 'B3' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro')));
    const sup = who(phones, (v) => v.can.items);
    await keepOnly(sup, ['糧食', '纜索', '錨']);
    const cap = who(phones, (v) => v.can.lock);
    cap.act({ type: 'lock' });
    await cap.until(() => cap.rejections.length > 0);
    assert.match(cap.rejections[0].reasons[0].text, /認識隊友/);
    assert.equal(phones.filter((p) => p !== cap).every((p) => p.rejections.length === 0), true);
    await cap.until((v) => v.phase === 'planning', 4000);
    cap.act({ type: 'lock' });
    await cap.until((v) => v.phase === 'blackout');
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('開局下一步有名字和問題；3 人局突破口也分在三支手機', async () => {
  const { srv, phones, host } = await setup(3);
  try {
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    for (const p of phones) {
      assert.ok(p.view!.nextSteps.length >= 1, p.view!.me.roles.map((r) => r.name).join());
      for (const s of p.view!.nextSteps) assert.ok(s.nickname && s.text);
    }
    const room = roomOf(srv, host.code);
    assert.equal(new Set(room.round!.btHolders.values()).size, 3);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('心跳：送 ping 會收到 pong', async () => {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20 });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    await new Promise((r) => ws.once('open', r));
    const got = new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    ws.send(JSON.stringify({ t: 'ping' }));
    assert.deepEqual(JSON.parse(await got), { t: 'pong' });
    ws.close();
  } finally {
    await srv.close();
  }
});

test('角色輪替：第二局盡量每個人都換到不同職能（3／6／10 人）', () => {
  for (const n of [3, 6, 10]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const room = new Room('ROTA', { seed, introMs: 0 });
      const ids = Array.from({ length: n }, (_, i) => room.addPlayer('p' + i).id);
      room.start(room.hostId!);
      const first = new Map(ids.map((id) => [id, room.round!.roles.get(id)![0]]));
      room.round!.game = { ...room.round!.game, phase: 'settled' };
      room.next(room.hostId!);
      const same = ids.filter((id) => room.round!.roles.get(id)![0] === first.get(id)).length;
      assert.equal(same, 0, `${n} 人 seed ${seed}：${same} 人職能沒換`);
    }
  }
});

test('故事卡：連續 4 局，起風卡、風暴卡都不和上一局重複', () => {
  const room = new Room('CARD', { seed: 9, introMs: 0 });
  for (let i = 0; i < 3; i++) room.addPlayer('p' + i);
  let prev: { a: string; b: string } | null = null;
  for (let k = 0; k < 4; k++) {
    if (k === 0) room.start(room.hostId!);
    else {
      room.round!.game = { ...room.round!.game, phase: 'settled' };
      room.next(room.hostId!);
    }
    const c = room.round!.game.cards;
    if (prev) {
      assert.notEqual(c.a, prev.a);
      assert.notEqual(c.b, prev.b);
    }
    prev = c;
  }
});

test('會改變留法的卡片清單和 tools/verify_seeds.py 一致；首局至少抽到一張', () => {
  const out = execFileSync('python3', ['tools/verify_seeds.py'], { encoding: 'utf8' });
  const fromScript = [...out.matchAll(/^  ([AB]\d)：改變/gm)].map((m) => m[1]);
  assert.deepEqual([...PLAN_CHANGERS].sort(), fromScript.sort());
  for (let seed = 1; seed <= 40; seed++) {
    const room = new Room('FRST', { seed, introMs: 0 });
    for (let i = 0; i < 3; i++) room.addPlayer('p' + i);
    room.start(room.hostId!);
    const c = room.round!.game.cards;
    assert.ok(PLAN_CHANGERS.includes(c.a) || PLAN_CHANGERS.includes(c.b), `seed ${seed}: ${c.a}+${c.b}`);
  }
});

test('風暴卡要帶走的東西早就丟了：卡面照實說沒有影響', async () => {
  const { srv, phones, host } = await setup(3);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A2', b: 'B2' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    await keepOnly(sup, ['糧食', '纜索', '錨']);
    who(phones, (v) => v.can.lock).act({ type: 'lock' });
    await repair(phones);
    assert.match(host.view!.cards.b!.effect, /早就丟進海裡/);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});
