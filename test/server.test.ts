// 伺服器整合測試：真的 WebSocket，多個模擬手機（第一關保羅海難）。不是真人試玩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server/main.ts';
import type { ServerMessage, View, Action } from '../src/server/view.ts';
import { Room } from '../src/server/room.ts';
import { validSetups } from '../src/engine/rules.ts';
import { CLASSIC, type Tonight } from '../src/engine/seeds.ts';

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
// sweepWarningMs：捲走前提醒縮成 300 毫秒（正式 10 秒），測試不用真的等
// voteMs：表決「沒回應算同意」縮成 60 毫秒（正式 10 秒）；表決本身另外測（voteMs 加長）
async function setup(n: number, introMs = 0, voteMs = 60) {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20, introMs, sweepWarningMs: 300, voteMs });
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

const WHEAT_SHALLOW: Tonight = { 食: '麥子', 繩: '纜索', 水: '淺' };

for (const n of [3, 6, 10]) {
  test(`${n} 人：首局經典配置（不捲走）吃飯三星 → 第二局換見聞、風暴捲走、吃麥子三星（表決沒回應算同意）`, async () => {
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
        assert.equal(p.view!.ship!.provides, null, '危機前不公開今晚靠哪一樣');
        assert.equal(p.view!.ship!.sweep, false, '首局不捲走');
      }
      // 見聞：三張各在一支手機（3 人局每人至少一張）；首局是經典配置
      const dials = phones.flatMap((p) => p.view!.tonight.map((t) => t.dial));
      assert.deepEqual([...dials].sort(), ['水', '繩', '食'].sort());
      if (n === 3) for (const p of phones) assert.ok(p.view!.tonight.length >= 1, '3 人局每人至少一張見聞');
      const food = who(phones, (v) => v.tonight.some((t) => t.dial === '食')).view!.tonight.find((t) => t.dial === '食')!;
      assert.equal(food.item, '糧食');
      assert.equal(food.tag, '遊戲設定');
      assert.equal(phones.filter((p) => p.view!.can.items).length, 1);
      assert.equal(phones.filter((p) => p.view!.can.lock).length, 1);
      assert.equal(phones.filter((p) => p.view!.can.uses.length).length, 0);
      const sup = who(phones, (v) => v.can.items);
      const cap = who(phones, (v) => v.can.lock);
      for (const p of phones.filter((x) => x !== sup && x !== cap)) assert.ok(/告訴/.test(p.view!.myTask ?? '') || p.view!.nextSteps.length > 0, '沒有按鈕的人要知道找誰');
      cap.act({ type: 'lock' });
      await cap.until(() => cap.rejections.length > 0);
      assert.match(cap.rejections[0].reasons[0].text, /超重 7/);
      await keepOnly(sup, ['糧食', '纜索', '錨']);
      cap.act({ type: 'lock' });
      await repair(phones);
      let v = host.view!;
      assert.equal(v.crisis!.starsBefore, 3);
      assert.equal(v.cards.b?.id, 'B4');
      assert.equal(v.ship!.cap, 5);
      assert.deepEqual(v.ship!.provides, { 力氣: '糧食', 船身: '纜索', 天亮: '錨' });
      assert.deepEqual(v.ship!.reasonCodes, ['OVERWEIGHT']);
      for (const p of phones) assert.ok(p.view!.clues.some((c) => c.breakthrough === 1), `${n} 人 B4 線索公開`);
      const owners = [1, 2, 3].map((b) => phones.filter((p) => p.view!.clues.some((c) => c.breakthrough === b && !c.shared)).length);
      assert.deepEqual(owners, [1, 1, 1]);
      // 水深：沒有人有拋錨按鈕；吃飯在伙房、捆船底在木匠
      const useOwners = phones.flatMap((p) => p.view!.can.uses.map((u) => u.id)).sort();
      assert.deepEqual(useOwners, ['吃飯', '捆船底'].sort());
      const cook = who(phones, (x) => x.can.uses.some((u) => u.id === '吃飯'));
      assert.ok(cook.view!.clues.some((c) => c.breakthrough === 3), '吃飯按鈕與第三段線索在同一支手機');
      cook.act({ type: 'use', use: '吃飯' });
      await Promise.all(phones.map((p) => p.until((x) => !!x.ship!.used)));
      assert.equal(host.view!.ship!.used!.item, '糧食');
      await Promise.all(phones.map((p) => p.until((x) => x.can.uses.length === 0)));
      await keepOnly(sup, ['纜索', '錨']);
      await cap.until((x) => x.ship!.reasons.length === 0);
      cap.act({ type: 'depart' });
      await Promise.all(phones.map((p) => p.until((x) => x.phase === 'settled')));
      let res = host.view!.result!;
      assert.equal(res.stars, 3);
      assert.equal(res.safe, true);
      assert.equal(res.title, '全船平安上岸・一路準備周全');
      assert.match(res.saved.text, /276 人，全都得救上了岸/);
      assert.ok(res.moments.some((m) => m.text.includes('召集大家吃了糧食')));
      assert.ok(res.moments.some((m) => m.text.includes('外衣')));
      assert.match(res.tonightLine, /力氣靠糧食/);
      assert.match(res.verse.ref, /27:35/);
      phones[1].send({ t: 'thank', to: host.playerId });
      await host.until((x) => x.result!.thanks.length === 1);

      // ---------- 第二局：今晚靠麥子、水淺；風暴捲走 ----------
      roomOf(srv, host.code).forceCards = { a: 'A2', b: 'B1', tonight: WHEAT_SHALLOW };
      host.send({ t: 'next' });
      await Promise.all(phones.map((p) => p.until((x) => x.round?.no === 2 && x.phase === 'planning')));
      assert.equal(host.view!.ship!.sweep, true);
      const wheat = who(phones, (x) => x.tonight.some((t) => t.dial === '食')).view!.tonight.find((t) => t.dial === '食')!;
      assert.match(wheat.text, /麥子/);
      const water = who(phones, (x) => x.tonight.some((t) => t.dial === '水')).view!.tonight.find((t) => t.dial === '水')!;
      assert.equal(water.ref, '徒 27:28');
      assert.equal(water.tag, null);
      const sup2 = who(phones, (x) => x.can.items);
      const cap2 = who(phones, (x) => x.can.lock);
      await keepOnly(sup2, ['纜索', '錨', '麥子']);
      cap2.act({ type: 'lock' });
      // 捲走前提醒：所有手機都看到漂著的東西
      await Promise.all(phones.map((p) => p.until((x) => !!x.ship?.sweepWarning || x.phase === 'blackout')));
      await repair(phones);
      v = host.view!;
      assert.deepEqual(v.ship!.items.filter((i) => i.swept).map((i) => i.id), ['糧食', '器具', '小船']);
      const before = sup2.rejections.length;
      sup2.act({ type: 'setItem', item: '糧食', on: true });
      await sup2.until(() => sup2.rejections.length > before);
      assert.match(sup2.rejections.at(-1)!.reasons[0].text, /捲走/);
      // 水淺：拋錨按鈕在測水深／瞭望手上；但要三星就得吃飯（力氣只能靠吃，天亮前只來得及一件）
      assert.ok(phones.some((p) => p.view!.can.uses.some((u) => u.id === '拋錨')));
      assert.deepEqual(host.view!.ship!.needs!.filter((x) => x.lit).map((x) => x.id), ['船身', '天亮'], '麥子留著也不算力氣');
      const cook2 = who(phones, (x) => x.can.uses.some((u) => u.id === '吃飯'));
      cook2.act({ type: 'use', use: '吃飯' });
      await host.until((x) => x.ship!.used?.item === '麥子');
      await cap2.until((x) => x.ship!.reasons.length === 0 && x.ship!.stars === 3);
      cap2.act({ type: 'depart' });
      await Promise.all(phones.map((p) => p.until((x) => x.phase === 'settled')));
      res = host.view!.result!;
      assert.equal(res.stars, 3);
      assert.ok(res.moments.some((m) => m.text.includes('被浪捲走')));
      assert.match(res.tonightLine, /力氣靠麥子/);
    } finally {
      phones.forEach((p) => p.close());
      await srv.close();
    }
  });
}

test('故事卡 A1＋B5：危機前麥子丟不掉；補好船後錨已拋下、留著麥子不算力氣（二星仍平安上岸）', async () => {
  const { srv, phones, host } = await setup(4);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A1', b: 'B5', tonight: { 食: '麥子', 繩: '纜索', 水: '深' } };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    assert.ok(sup.view!.ship!.items.find((i) => i.id === '麥子')!.pinned);
    sup.act({ type: 'setItem', item: '麥子', on: false });
    await sup.until(() => sup.rejections.length > 0);
    assert.match(sup.rejections[0].reasons[0].text, /船主不准丟麥子/);
    const cap = who(phones, (v) => v.can.lock);
    await keepOnly(sup, ['纜索', '錨', '麥子']);
    cap.act({ type: 'lock' });
    await repair(phones);
    await keepOnly(sup, ['纜索', '麥子']);
    assert.ok(cap.view!.ship!.items.find((i) => i.id === '錨')!.gone);
    assert.deepEqual(cap.view!.ship!.needs!.filter((n) => n.lit).map((n) => n.id), ['船身', '天亮']);
    cap.act({ type: 'depart' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'settled')));
    assert.equal(host.view!.result!.stars, 2);
    assert.equal(host.view!.result!.safe, true);
    assert.equal(host.view!.result!.title, '全船平安上岸・準備了大半');
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('用掉：東西丟了不能用，按的人看到要先撈回；按鈕只在今晚做得到的人手上', async () => {
  const { srv, phones, host } = await setup(6);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A2', b: 'B2' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    await keepOnly(sup, ['纜索', '錨']);
    who(phones, (v) => v.can.lock).act({ type: 'lock' });
    await repair(phones);
    const cook = who(phones, (v) => v.can.uses.some((u) => u.id === '吃飯'));
    assert.equal(cook.view!.can.uses.find((u) => u.id === '吃飯')!.ready, false);
    assert.equal(phones.filter((p) => p.view!.can.uses.some((u) => u.id === '吃飯')).length, 1);
    assert.equal(phones.filter((p) => p.view!.can.uses.some((u) => u.id === '拋錨')).length, 0, '水深：沒有拋錨按鈕');
    cook.act({ type: 'use', use: '吃飯' });
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
      // 三張見聞各在一支手機，至少分在兩個人；線索裡的 {繩} 等已換成職能名稱
      const dialHolders = (['食', '繩', '水'] as const).map((d) => phones.filter((p) => p.view!.tonight.some((t) => t.dial === d)));
      for (const hs of dialHolders) assert.equal(hs.length, 1, `${n} 人：每張見聞恰一人`);
      assert.ok(new Set(dialHolders.map((h) => h[0])).size >= (n >= 5 ? 3 : 2), `${n} 人：見聞分散`);
      for (const p of phones) for (const c of p.view!.clues) assert.ok(!/\{/.test(c.text), c.text);
      // 每人至少有一條會影響決定的線索、見聞，或有操作
      for (const p of phones) {
        const v = p.view!;
        const tips = ['黑暗中', '補船小撇步'];
        const useful = v.tonight.length > 0 || v.clues.some((c) => !tips.includes(c.title)) || v.can.items || v.can.lock;
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

test('抽卡與見聞：首局都是經典配置、不捲走；第二局起都捲走，見聞照表抽、自創細節只在部分局生效', () => {
  const table = validSetups();
  const key = (a: string, t: Tonight, b: string) => `${a}|${Object.values(t).join('/')}|${b}`;
  const legal = new Set(table.flatMap((x) => x.b.map((b) => key(x.a, x.tonight, b))));
  let later = 0;
  let invented = 0;
  let changed = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const room = new Room('DRAW', { seed, introMs: 0 });
    for (let i = 0; i < 3; i++) room.addPlayer('p' + i);
    let prev: Tonight | null = null;
    for (let k = 0; k < 4; k++) {
      if (k === 0) room.start(room.hostId!);
      else {
        room.round!.game = { ...room.round!.game, phase: 'settled' };
        room.next(room.hostId!);
      }
      const g = room.round!.game;
      assert.ok(legal.has(key(g.cards.a, g.tonight, g.cards.b)), `seed ${seed} 第 ${k + 1} 局不在表裡`);
      if (k === 0) {
        assert.deepEqual(g.tonight, CLASSIC);
        assert.equal(g.sweep, false);
        assert.notEqual(g.cards.a, 'A1', '首局經典配置不會配 A1');
      } else {
        assert.equal(g.sweep, true);
        later++;
        if (g.tonight.食 === '麥子' || g.tonight.繩 !== '纜索' || g.tonight.水 === '深') invented++;
        if (prev && JSON.stringify(prev) !== JSON.stringify(g.tonight)) changed++;
      }
      prev = g.tonight;
    }
  }
  // 自創細節（麥子、器具／小船的繩子、暈船）只在部分局生效
  const wheatOrRope = (t: Tonight) => t.食 === '麥子' || t.繩 !== '纜索';
  let custom = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const room = new Room('CUST', { seed, introMs: 0 });
    for (let i = 0; i < 3; i++) room.addPlayer('p' + i);
    room.start(room.hostId!);
    room.round!.game = { ...room.round!.game, phase: 'settled' };
    room.next(room.hostId!);
    if (wheatOrRope(room.round!.game.tonight)) custom++;
  }
  assert.ok(custom > 0 && custom < 40, `第二局用到自創細節的比例 ${custom}/40`);
  assert.ok(invented > 0 && later > 0);
  assert.equal(changed, later, '第二局起每局都換一組見聞');
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


// ---------- 表決（DECISIONS 18）：決定好了、三種用掉、衝向海灘要其他在線隊員都同意；2 次沒通過可強制；10 秒沒回應算同意 ----------

test('表決：其他人跳出同意／不同意；全部同意才執行；不點名誰不同意', async () => {
  const { srv, phones, host } = await setup(4, 0, 5_000);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A5', b: 'B4' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    const cap = who(phones, (v) => v.can.lock);
    await keepOnly(sup, ['糧食', '纜索', '錨']);
    cap.act({ type: 'lock' });
    await Promise.all(phones.map((p) => p.until((v) => !!v.vote)));
    assert.equal(cap.view!.vote!.mine, true);
    assert.equal(cap.view!.vote!.canVote, false, '提案的人不用投');
    assert.equal(cap.view!.vote!.label, '決定好了');
    assert.equal(cap.view!.vote!.total, 3);
    const voters = phones.filter((p) => p !== cap);
    for (const p of voters) assert.equal(p.view!.vote!.canVote, true);
    // 表決中再按一次：被擋
    cap.act({ type: 'lock' });
    await cap.until(() => cap.rejections.length > 0);
    assert.match(cap.rejections.at(-1)!.reasons[0].text, /正在表決/);
    // 重複投票會被忽略
    voters[0].send({ t: 'vote', id: cap.view!.vote!.id, choice: 'yes' });
    voters[0].send({ t: 'vote', id: cap.view!.vote!.id, choice: 'wait' });
    await cap.until((v) => v.vote?.agreed === 1);
    voters[1].send({ t: 'vote', id: cap.view!.vote!.id, choice: 'yes' });
    await cap.until((v) => v.vote?.agreed === 2);
    assert.equal(cap.view!.phase, 'planning', '還有一人沒投，不會執行');
    voters[2].send({ t: 'vote', id: cap.view!.vote!.id, choice: 'yes' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
    assert.equal(host.view!.vote, null);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('表決：有人不同意就沒通過；同一個動作 2 次沒通過，負責人再按就強制執行（不用表決）', async () => {
  const { srv, phones, host } = await setup(3, 0, 5_000);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A5', b: 'B4' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    const cap = who(phones, (v) => v.can.lock);
    await keepOnly(sup, ['糧食', '纜索', '錨']);
    const other = phones.find((p) => p !== cap)!;
    for (const [i, choice] of (['wait', 'info'] as const).entries()) {
      cap.act({ type: 'lock' });
      await other.until((v) => !!v.vote?.canVote);
      assert.equal(other.view!.vote!.attempt, i + 1);
      other.send({ t: 'vote', id: other.view!.vote!.id, choice });
      await Promise.all(phones.map((p) => p.until((v) => !v.vote && v.voteResult?.outcome === 'rejected' && v.voteResult.tries === i + 1)));
      const r = host.view!.voteResult!;
      assert.equal(r.wait + r.info, 1);
      assert.ok(!JSON.stringify(r).includes(other.view!.me.nickname), '不點名誰不同意');
    }
    assert.equal(cap.view!.phase, 'planning');
    assert.deepEqual(cap.view!.can.force, ['lock']);
    assert.deepEqual(other.view!.can.force, [], '強制只出現在負責人手上');
    cap.act({ type: 'lock' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'blackout')));
    assert.equal(host.view!.vote, null);
    await repair(phones);
    // 結尾回顧寫出強制的人與沒通過的次數
    const cook = who(phones, (v) => v.can.uses.some((u) => u.id === '吃飯'));
    cook.act({ type: 'use', use: '吃飯' });
    const voters = phones.filter((p) => p !== cook);
    await Promise.all(voters.map((p) => p.until((v) => !!v.vote?.canVote)));
    for (const p of voters) p.send({ t: 'vote', id: p.view!.vote!.id, choice: 'yes' });
    await host.until((v) => !!v.ship!.used);
    await keepOnly(sup, ['纜索', '錨']);
    cap.act({ type: 'depart' });
    const v2 = phones.filter((p) => p !== cap);
    await Promise.all(v2.map((p) => p.until((v) => !!v.vote?.canVote)));
    for (const p of v2) p.send({ t: 'vote', id: p.view!.vote!.id, choice: 'yes' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'settled')));
    const res = host.view!.result!;
    assert.ok(res.moments.some((m) => m.text.includes('2 次沒通過後，強制「決定好了」')));
    assert.ok(res.moments.some((m) => m.text.includes('有 2 次有人喊')));
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('表決：沒回應的時間到算同意；離線的人不算進表決', async () => {
  const { srv, phones, host } = await setup(4, 0, 400);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A5', b: 'B4' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    const cap = who(phones, (v) => v.can.lock);
    await keepOnly(sup, ['糧食', '纜索', '錨']);
    const quiet = phones.find((p) => p !== cap && p !== sup)!;
    quiet.close();
    await cap.until((v) => v.players.some((p) => !p.connected));
    cap.act({ type: 'lock' });
    await cap.until((v) => !!v.vote);
    assert.equal(cap.view!.vote!.total, 2, '離線的人不算');
    // 沒人投：400 毫秒後算同意
    await cap.until((v) => v.phase === 'blackout', 3000);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('沒能平安上岸：顧好 1 件就衝向海灘 → 標題寫沒能平安上岸、經文那行仍寫 276 人都上了岸、任務分 0', async () => {
  const { srv, phones, host } = await setup(3);
  try {
    roomOf(srv, host.code).forceCards = { a: 'A5', b: 'B4' };
    host.send({ t: 'start' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'planning')));
    const sup = who(phones, (v) => v.can.items);
    const cap = who(phones, (v) => v.can.lock);
    await keepOnly(sup, ['纜索']);
    cap.act({ type: 'lock' });
    await repair(phones);
    cap.act({ type: 'depart' });
    await Promise.all(phones.map((p) => p.until((v) => v.phase === 'settled')));
    const res = host.view!.result!;
    assert.equal(res.stars, 1);
    assert.equal(res.safe, false);
    assert.equal(res.title, '這一局，你們沒能平安上岸');
    assert.match(res.saved.text, /經文裡，船上 276 人全都上了岸/);
    assert.ok(res.moments.some((m) => m.text.includes('沒能平安上岸')));
    assert.ok(!res.moments.some((m) => /死|喪命|淹死/.test(m.text)), '不寫有人死亡');
    const mission = res.score!.parts.find((x) => x.id === 'mission')!;
    assert.equal(mission.points, 0);
    assert.equal(mission.detail, '沒能平安上岸');
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});
