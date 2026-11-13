// 伺服器整合測試：真的 WebSocket，多個模擬手機。涵蓋 F01–F03、F17、F18、F19、F20 的伺服器層（不是真人試玩）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server/main.ts';
import type { ServerMessage, View, Action } from '../src/server/view.ts';

class Phone {
  ws!: WebSocket;
  view: View | null = null;
  playerId = '';
  token = '';
  code = '';
  errors: string[] = [];
  acks: string[] = [];
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

async function setup(n: number) {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20 });
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

for (const n of [3, 6, 10]) {
  test(`${n} 人：開房 → 分工 → 鎖定 → 停電修復 → 開閘 → 三星 → 感謝 → 下一局換 seed 002`, async () => {
    const { srv, phones, host } = await setup(n);
    try {
      assert.equal(host.view!.qrSvg?.startsWith('<svg'), true);
      assert.equal(host.view!.can.start, true);
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro')));

      // F02／F03：每人都有職能、至少一條開局線索；職能涵蓋六種核心能力
      const allRoles = phones.flatMap((p) => p.view!.me.roles.map((r) => r.id));
      for (const core of ['nav', 'supply', 'comms', 'eng', 'medic', 'observer']) assert.ok(allRoles.includes(core as never), core);
      for (const p of phones) {
        assert.ok(p.view!.me.roles.length >= 1);
        assert.ok(p.view!.clues.length >= 1, `${p.view!.me.nickname} 沒有線索`);
      }
      assert.equal(phones.filter((p) => p.view!.can.route).length, 1);
      assert.equal(phones.filter((p) => p.view!.can.items).length, 1);
      assert.equal(phones.filter((p) => p.view!.preferenceHint).length, n);

      const nav = who(phones, (v) => v.can.route);
      const supply = who(phones, (v) => v.can.items);
      nav.act({ type: 'selectRoute', route: '紅' });
      for (const item of ['藥品', '飲水', '毛毯']) supply.act({ type: 'setItem', item, on: true });
      await host.until((v) => v.plan?.reachable === 3);
      assert.equal(host.view!.plan!.weight, 7);

      // 非導航員不能選路線
      const notNav = phones.find((p) => p !== nav)!;
      notNav.act({ type: 'selectRoute', route: '藍' });
      await notNav.until(() => notNav.errors.length > 0);

      host.act({ type: 'lock' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
      assert.ok(host.view!.crisis?.title.includes('吊橋'));

      // F07：符號數、排除線索、每位非工程師都有事
      const sym = { 3: 2, 6: 4, 10: 4 }[n]!;
      const holders = phones.filter((p) => p.view!.repair!.mySymbols.length > 0);
      const clueHolders = phones.filter((p) => p.view!.repair!.myEliminationClue);
      assert.equal(holders.length, sym);
      assert.equal(clueHolders.length, n - 1 - sym);
      const eng = who(phones, (v) => v.can.repair);
      for (const p of phones) if (p !== eng) assert.ok(p.view!.repair!.mySymbols.length + (p.view!.repair!.myEliminationClue ? 1 : 0) >= 1);
      assert.equal(eng.view!.repair!.panel!.slots.length, sym);
      assert.equal(eng.view!.repair!.panel!.slots[0].options.length, 9);

      // F26：排除能力
      const pref = who(phones, (v) => v.can.eliminate);
      pref.act({ type: 'useEliminate' });
      await eng.until((v) => v.repair!.panel!.slots[0].options.filter((o) => o.grayed).length === 2);

      await repair(phones);
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'replanning')));
      assert.equal(host.view!.plan!.reasons[0], '道路封閉');

      // 突破口三段線索分別在觀測、通訊、工程手機上
      const bt = phones.flatMap((p) => p.view!.clues.filter((c) => c.breakthrough).map((c) => c.breakthrough));
      assert.deepEqual([...bt].sort(), [1, 2, 3]);
      const engineerClue = eng.view!.clues.find((c) => c.breakthrough === 3)!;
      const channel = engineerClue.text.match(/(\d{3})/)![1];
      const comms = who(phones, (v) => v.can.floodgate);
      comms.act({ type: 'floodgate', channel: '000' });
      await comms.until((v) => v.breakthrough!.floodgateWrongCount === 1);
      comms.act({ type: 'floodgate', channel });
      await comms.until((v) => v.breakthrough!.done);

      nav.act({ type: 'selectRoute', route: '綠' });
      await host.until((v) => v.plan?.route?.id === '綠' && v.plan.reasons.length === 0);
      // F17：多人同時按出發，只結算一次
      for (const p of phones) p.act({ type: 'depart' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'settled')));
      for (const p of phones) assert.equal(p.view!.result!.stars, 3);
      assert.ok(host.view!.result!.recap.length >= 1);
      assert.ok(host.view!.result!.recap.every((r) => r.ref.startsWith('林前 12:')));

      // F20：感謝卡只顯示誰謝了誰
      phones[1].send({ t: 'thank', to: phones[0].playerId });
      await host.until((v) => v.result!.thanks.length === 1);
      assert.deepEqual(Object.keys(host.view!.result!.thanks[0]).sort(), ['from', 'to']);

      host.send({ t: 'next' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro' && v.round?.seedId === 'seed 002')));
      assert.equal(host.view!.round!.firstRound, false);
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  });
}

test('seed 002（第二局）：落石載重降為 5、詢問北村井水、淨水錠三星', async () => {
  const { srv, phones, host } = await setup(4);
  try {
    host.send({ t: 'start' });
    await host.until((v) => v.phase === 'intro');
    host.act({ type: 'lock' }); // 沒排方案不能鎖
    await host.until((v) => !!v.plan?.lastRejection);
    // 快轉：第一局直接用合法方案鎖定並結算
    const nav = who(phones, (v) => v.can.route);
    const supply = who(phones, (v) => v.can.items);
    nav.act({ type: 'selectRoute', route: '藍' });
    supply.act({ type: 'setItem', item: '藥品', on: true });
    supply.act({ type: 'setItem', item: '飲水', on: true });
    await host.until((v) => v.plan?.reachable === 2);
    host.act({ type: 'lock' });
    await host.until((v) => v.phase === 'blackout');
    await repair(phones);
    host.act({ type: 'depart' });
    await host.until((v) => v.phase === 'settled');
    host.send({ t: 'next' });
    await Promise.all(phones.map((p) => p.until((v) => v.round?.seedId === 'seed 002' && v.phase === 'intro')));

    const nav2 = who(phones, (v) => v.can.route);
    const sup2 = who(phones, (v) => v.can.items);
    nav2.act({ type: 'selectRoute', route: '藍' });
    for (const item of ['食物', '藥品', '飲水']) sup2.act({ type: 'setItem', item, on: true });
    await host.until((v) => v.plan?.reachable === 3 && v.plan.weight === 6);
    host.act({ type: 'lock' });
    await host.until((v) => v.phase === 'blackout');
    assert.ok(host.view!.crisis!.title.includes('落石'));
    await repair(phones);
    await host.until((v) => v.plan!.cap === 5 && v.plan!.overweight === 1);
    assert.equal(host.view!.plan!.reasons[0], '超重 1 kg');
    const comms = who(phones, (v) => v.can.query);
    comms.act({ type: 'query', village: '北村', question: 'well' });
    await host.until((v) => !!v.breakthrough?.queryReply && v.plan!.itemChoices.some((i) => i.id === '淨水錠' && !i.locked));
    sup2.act({ type: 'setItem', item: '飲水', on: false });
    sup2.act({ type: 'setItem', item: '淨水錠', on: true });
    await host.until((v) => v.plan!.weight === 5 && v.plan!.reasons.length === 0);
    host.act({ type: 'depart' });
    await host.until((v) => v.phase === 'settled');
    assert.equal(host.view!.result!.stars, 3);
    assert.equal(host.view!.result!.recap[0].ref, '林前 12:14');
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

test('F18：斷線重連回到原角色；房主離線會移交；重送同一個動作代號不會重複執行', async () => {
  const { srv, url, phones, host } = await setup(3);
  try {
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro')));
    const victim = phones[1];
    const rolesBefore = victim.view!.me.roles.map((r) => r.id);
    victim.close();
    await host.until((v) => v.players.some((p) => p.id === victim.playerId && !p.connected));
    const again = await new Phone(url).open();
    again.send({ t: 'resume', playerId: victim.playerId, token: victim.token });
    await again.until((v) => v.phase === 'intro');
    assert.deepEqual(again.view!.me.roles.map((r) => r.id), rolesBefore);
    phones[1] = again;

    // 防重複提交：同一個 id 送兩次 setItem(on) 再送 off → 只有一次效果
    const supply = who(phones, (v) => v.can.items);
    supply.act({ type: 'setItem', item: '藥品', on: true }, 'dup-1');
    supply.act({ type: 'setItem', item: '藥品', on: false }, 'dup-2');
    supply.act({ type: 'setItem', item: '藥品', on: true }, 'dup-1');
    await supply.until(() => supply.acks.filter((a) => a === 'dup-1').length === 2);
    await supply.until((v) => !v.plan!.items.includes('藥品'));

    // 房主離線 → 移交
    host.close();
    await phones[2].until((v) => v.players.some((p) => p.isHost && p.id !== host.playerId));
    // 離線玩家的操作交給在線的人，不會卡死
    await Promise.all(phones.slice(1).map((p) => p.until((v) => v.players.some((x) => x.id === host.playerId && !x.connected))));
    const ops = phones.slice(1).map((p) => p.view!.can);
    assert.ok(ops.some((c) => c.route));
    assert.ok(ops.some((c) => c.items));
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('F19：偏好全跳過或多人同選隨性派，都一定有人持有排除能力', async () => {
  for (const prefs of [[null, null, null, null], ['casual', 'casual', 'casual', 'casual'], ['planner', 'either', 'planner', null]]) {
    const { srv, phones, host } = await setup(4);
    try {
      phones.forEach((p, i) => p.send({ t: 'pref', value: prefs[i] }));
      await host.until((v) => v.players.length === 4);
      await new Promise((r) => setTimeout(r, 100));
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro')));
      const holders = phones.filter((p) => p.view!.preferenceHint?.startsWith('你持有'));
      assert.equal(holders.length, 1, JSON.stringify(prefs));
      assert.equal(holders[0].view!.me.roles.some((r) => r.id === 'eng'), false);
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  }
});

test('F02／F03：3–10 每種人數，每人都有職能、開局線索；停電時每位非工程師都有符號或排除線索', async () => {
  for (let n = 3; n <= 10; n++) {
    const { srv, phones, host } = await setup(n);
    try {
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro')));
      for (const p of phones) {
        assert.ok(p.view!.me.roles.length >= 1, `${n} 人`);
        assert.ok(p.view!.clues.length >= 1, `${n} 人：${p.view!.me.roles.map((r) => r.name)} 沒有開局線索`);
      }
      const nav = who(phones, (v) => v.can.route);
      const supply = who(phones, (v) => v.can.items);
      nav.act({ type: 'selectRoute', route: '藍' });
      supply.act({ type: 'setItem', item: '藥品', on: true });
      await host.until((v) => v.plan?.reachable === 1);
      host.act({ type: 'lock' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
      const eng = who(phones, (v) => v.can.repair);
      for (const p of phones) {
        if (p === eng) continue;
        const r = p.view!.repair!;
        assert.ok(r.mySymbols.length + (r.myEliminationClue ? 1 : 0) === 1, `${n} 人：${p.view!.me.nickname}`);
      }
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  }
});
