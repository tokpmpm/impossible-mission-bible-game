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

for (const n of [3, 6, 10]) {
  test(`${n} 人：開房 → 分工 → 鎖定 → 停電修復 → 開閘 → 三星 → 感謝 → 下一局換 seed 002`, async () => {
    const { srv, phones, host } = await setup(n);
    try {
      assert.equal(host.view!.qrSvg?.startsWith('<svg'), true);
      assert.equal(host.view!.can.start, true);
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));

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
      assert.equal(host.view!.plan!.showReach, false); // 危機前畫面不顯示可送幾村

      // 非導航員不能選路線
      const notNav = phones.find((p) => p !== nav)!;
      notNav.act({ type: 'selectRoute', route: '藍' });
      await notNav.until(() => notNav.errors.length > 0);

      host.act({ type: 'lock' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
      assert.ok(host.view!.crisis?.title.includes('吊橋'));
      assert.equal(host.view!.crisis!.reachBefore, 3); // 停電時揭曉：原本能送 3 村
      assert.equal(host.view!.plan!.showReach, true);

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
      // 三段在三支不同的手機上（3 人局通訊＋工程同一人時，第 3 段會轉給別人）
      const btPhones = phones.filter((p) => p.view!.clues.some((c) => c.breakthrough));
      assert.equal(btPhones.length, 3);
      const channelClue = phones.flatMap((p) => p.view!.clues).find((c) => c.breakthrough === 3)!;
      const channel = channelClue.text.match(/(\d{3})/)![1];
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
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning' && v.round?.seedId === 'seed 002')));
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
    await host.until((v) => v.phase === 'planning');
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
    await Promise.all(phones.map((p) => p.until((v) => v.round?.seedId === 'seed 002' && v.phase === 'planning')));

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
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
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
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
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

test('前 60 秒不能鎖定：按的人收到 rejected（原因＋還剩幾秒），別人沒收到；時間到就能鎖', async () => {
  const { srv, phones, host } = await setup(3, 600);
  try {
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'intro')));
    assert.ok(host.view!.round!.lockOpensAt > host.view!.round!.startedAt);
    const nav = who(phones, (v) => v.can.route);
    const supply = who(phones, (v) => v.can.items);
    nav.act({ type: 'selectRoute', route: '紅' });
    for (const item of ['藥品', '飲水', '毛毯']) supply.act({ type: 'setItem', item, on: true });
    await host.until((v) => v.plan?.reachable === 3); // 認識隊友時間也能排方案
    const id = host.act({ type: 'lock' });
    await host.until(() => host.rejections.length === 1);
    const rej = host.rejections[0];
    assert.equal(rej.id, id);
    assert.equal(rej.action, 'lock');
    assert.equal(rej.reasons[0].code, 'TOO_EARLY');
    assert.match(rej.reasons[0].text, /認識隊友.*秒/);
    assert.equal(host.view!.phase, 'intro');
    for (const p of phones) if (p !== host) assert.equal(p.rejections.length, 0);
    await host.until((v) => v.phase === 'planning', 3000);
    host.act({ type: 'lock' });
    await host.until((v) => v.phase === 'blackout');
    assert.equal(host.rejections.length, 1);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('被擋下的回饋：超重寫出幾公斤與該找誰；按的人是補給就說「你」；道路封閉附改選路線', async () => {
  const { srv, phones, host } = await setup(4);
  try {
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const nav = who(phones, (v) => v.can.route);
    const supply = who(phones, (v) => v.can.items);
    const other = phones.find((p) => p !== supply)!;
    const supplyNick = supply.view!.me.nickname;
    // 沒選路線
    other.act({ type: 'lock' });
    await other.until(() => other.rejections.length === 1);
    assert.ok(other.rejections[0].reasons.some((r) => r.code === 'NO_ROUTE' && r.text.includes(nav === other ? '請你' : nav.view!.me.nickname)));
    nav.act({ type: 'selectRoute', route: '紅' });
    for (const item of ['藥品', '飲水', '毛毯', '食物']) supply.act({ type: 'setItem', item, on: true });
    await host.until((v) => v.plan?.overweight === 2);
    other.act({ type: 'lock' });
    await other.until(() => other.rejections.length === 2);
    assert.equal(other.rejections[1].reasons[0].text, `超重 2 kg，請 ${supplyNick}（補給）放下一樣`);
    supply.act({ type: 'lock' });
    await supply.until(() => supply.rejections.length === 1);
    assert.equal(supply.rejections[0].reasons[0].text, '超重 2 kg，請你放下一樣');
    // view 也帶著同樣的下一步，所有人都看得到；負責人暱稱也在 view 裡
    assert.ok(other.view!.plan!.advice[0].startsWith('超重 2 kg'));
    assert.deepEqual(other.view!.plan!.reasonCodes, ['OVERWEIGHT']);
    assert.equal(other.view!.operators!.items, supplyNick);
    assert.equal(other.view!.operators!.route, nav.view!.me.nickname);
    // 別人也看得到「剛剛被擋下」，時間是伺服器時間（不是局內毫秒）
    const lr = host.view!.plan!.lastRejection!;
    assert.equal(lr.action, 'lock');
    assert.ok(Math.abs(lr.at - host.view!.serverNow) < 5000);
    supply.act({ type: 'setItem', item: '食物', on: false });
    await host.until((v) => v.plan?.reasons.length === 0);
    host.act({ type: 'lock' });
    await repair(phones);
    const before = host.rejections.length;
    host.act({ type: 'depart' });
    await host.until(() => host.rejections.length === before + 1);
    const road = host.rejections[before];
    assert.equal(road.action, 'depart');
    assert.equal(road.reasons[0].code, 'ROAD_CLOSED');
    assert.match(road.reasons[0].text, /紅線・吊橋斷了，請.*改選藍線或綠線/);
    nav.act({ type: 'selectRoute', route: '綠' });
    await host.until((v) => v.plan?.reasonCodes.includes('TOO_LATE') ?? false);
    assert.match(host.view!.plan!.advice[0], /綠線要 6 分鐘，洪水 5 分鐘就到.*拖住洪水/);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('開局下一步有名字和問題；6 人以下不出現拆分職能名稱；3 人 seed 002 突破口也分在三支手機', async () => {
  for (const n of [3, 6]) {
    const { srv, phones, host } = await setup(n);
    try {
      host.send({ t: 'start' });
      await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
      const nicks = phones.map((p) => p.view!.me.nickname);
      for (const p of phones) {
        const steps = p.view!.nextSteps;
        assert.ok(steps.length >= 1, `${n} 人：${p.view!.me.roles.map((r) => r.name)} 沒有下一步`);
        for (const st of steps) {
          assert.ok(nicks.includes(st.nickname) && st.nickname !== p.view!.me.nickname);
          assert.ok(st.text.length > 2);
        }
        for (const c of p.view!.clues) assert.ok(!/倉儲管理|村民聯絡|備援觀察|道路偵察/.test(c.role), `${n} 人出現 ${c.role}`);
      }
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  }
  // 3 人第二局（seed 002）：醫護＋補給同一人，突破口第 1、2 段原本會在同一支手機
  const { srv, phones, host } = await setup(3);
  try {
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const nav = who(phones, (v) => v.can.route);
    const supply = who(phones, (v) => v.can.items);
    nav.act({ type: 'selectRoute', route: '藍' });
    supply.act({ type: 'setItem', item: '藥品', on: true });
    await host.until((v) => v.plan?.reachable === 1);
    host.act({ type: 'lock' });
    await repair(phones);
    host.act({ type: 'depart' });
    await host.until((v) => v.phase === 'settled');
    host.send({ t: 'next' });
    await Promise.all(phones.map((p) => p.until((v) => v.round?.seedId === 'seed 002' && v.phase === 'planning')));
    const nav2 = who(phones, (v) => v.can.route);
    const sup2 = who(phones, (v) => v.can.items);
    nav2.act({ type: 'selectRoute', route: '藍' });
    sup2.act({ type: 'setItem', item: '藥品', on: true });
    await host.until((v) => v.plan?.reachable === 1);
    host.act({ type: 'lock' });
    await repair(phones);
    const counts = phones.map((p) => p.view!.clues.filter((c) => c.breakthrough).length);
    assert.deepEqual(counts.sort(), [1, 1, 1]);
    assert.ok(phones.some((p) => p.view!.clues.some((c) => c.role.includes('由你保管'))));
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('心跳：送 ping 會收到 pong（讓雲端伺服器在大家聊天、沒人點手機時保持清醒）', async () => {
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
