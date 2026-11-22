// 連線加強（2026-11-22，docs/16、DECISIONS 19、ADR-0010）：心跳逾時、訊息去重、房間不見代碼、暫停、存檔與讀回。
// 真的 WebSocket＋Node 伺服器；伺服器「重啟」用同一個 MemoryRoomStore 交給新的伺服器模擬。不是真機測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server/main.ts';
import { Room } from '../src/server/room.ts';
import { MemoryRoomStore } from '../src/server/roomstore.ts';
import type { ServerMessage, View } from '../src/server/view.ts';

class Phone {
  ws!: WebSocket;
  view: View | null = null;
  playerId = '';
  token = '';
  code = '';
  errors: { msg: string; code?: string }[] = [];
  acks: string[] = [];
  rejections: Extract<ServerMessage, { t: 'rejected' }>[] = [];
  closed = false;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private url: string;
  constructor(url: string) {
    this.url = url;
  }
  async open(pingMs = 0): Promise<this> {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'state') this.view = m.view;
      if (m.t === 'welcome') Object.assign(this, { playerId: m.playerId, token: m.token, code: m.code });
      if (m.t === 'error') this.errors.push({ msg: m.msg, code: m.code });
      if (m.t === 'ack') this.acks.push(m.id);
      if (m.t === 'rejected') this.rejections.push(m);
    });
    this.ws.on('close', () => (this.closed = true));
    await new Promise((r) => this.ws.once('open', r));
    if (pingMs) this.pinger = setInterval(() => this.send({ t: 'ping' }), pingMs);
    return this;
  }
  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  stopPing(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }
  async until(pred: () => boolean, ms = 3000, what = '條件'): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等不到${what}；phase=${this.view?.phase} errors=${JSON.stringify(this.errors)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  close(): void {
    this.stopPing();
    this.ws.close();
  }
}

type Srv = Awaited<ReturnType<typeof startServer>>;

async function room(srv: Srv, n: number, pingMs = 0) {
  const url = `ws://localhost:${srv.port}/ws`;
  const host = await new Phone(url).open(pingMs);
  host.send({ t: 'create', nickname: '房主' });
  await host.until(() => host.view?.phase === 'lobby');
  const phones = [host];
  for (let i = 1; i < n; i++) {
    const p = await new Phone(url).open(pingMs);
    p.send({ t: 'join', code: host.code, nickname: `隊員${i}` });
    phones.push(p);
  }
  await host.until(() => host.view?.players.length === n);
  return { url, host, phones };
}

async function resume(url: string, old: Phone): Promise<Phone> {
  const p = await new Phone(url).open();
  p.send({ t: 'resume', playerId: old.playerId, token: old.token });
  await p.until(() => !!p.view || p.errors.length > 0);
  return p;
}

test('心跳逾時：太久沒送任何訊息的連線會被伺服器關掉並標成離線；有送心跳的不會', async () => {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20, staleMs: 400 });
  const { host, phones } = await room(srv, 3, 100);
  try {
    const quiet = phones[2];
    quiet.stopPing(); // 模擬網路換手後的「假連線」：伺服器再也收不到他的東西
    await host.until(() => !!host.view?.players.find((p) => p.id === quiet.playerId && !p.connected), 3000, '他被標成離線');
    await quiet.until(() => quiet.closed, 3000, '伺服器關掉他的連線');
    assert.ok(host.view!.players.filter((p) => p.connected).length === 2, '有心跳的兩個人都還在線');
    assert.equal(host.closed, false);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('訊息去重：同一個 mid 重送只處理一次，每次都回 ack', async () => {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20 });
  const { host, phones } = await room(srv, 3);
  try {
    host.send({ t: 'start', mid: 'm-start' });
    host.send({ t: 'start', mid: 'm-start' }); // 斷線重送：不能變成「這局還在進行」的錯誤
    await host.until(() => host.acks.filter((a) => a === 'm-start').length === 2, 3000, '兩次 ack');
    await host.until(() => host.view?.phase === 'intro' || host.view?.phase === 'planning');
    assert.deepEqual(host.errors, []);
    // 沒帶 mid 的照舊（相容舊版手機）
    host.send({ t: 'start' });
    await host.until(() => host.errors.length === 1);
    assert.match((host.errors as { msg: string }[])[0].msg, /這局還在進行/);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('房間不見：resume 找不到房間回 code ROOM_GONE', async () => {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20 });
  try {
    const p = await new Phone(`ws://localhost:${srv.port}/ws`).open();
    p.send({ t: 'resume', playerId: 'nobody', token: 'x' });
    await p.until(() => p.errors.length > 0);
    assert.equal(p.errors[0].code, 'ROOM_GONE');
    p.close();
  } finally {
    await srv.close();
  }
});

test('暫停（DECISIONS 19）：一半以上隊員離線時倒數停住、動作被擋；回來後從停住的地方繼續', async () => {
  const srv = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20, introMs: 0 });
  const { url, host, phones } = await room(srv, 4);
  try {
    host.send({ t: 'start' });
    await host.until(() => host.view?.phase === 'planning');
    const r = srv.rooms.get(host.code) as Room;
    const sup = phones.find((p) => p.view!.can.items)!;
    const [o1, o2] = phones.filter((p) => p !== sup && p !== host);
    // 1／4 離線：不暫停
    o1.close();
    await host.until(() => host.view!.players.filter((p) => !p.connected).length === 1);
    assert.equal(host.view!.paused, null);
    // 2／4 離線＝一半：暫停
    o2.close();
    await host.until(() => !!host.view?.paused, 3000, '暫停');
    assert.deepEqual([...host.view!.paused!.offline].sort(), [o1.view!.me.nickname, o2.view!.me.nickname].sort());
    const frozen = r.elapsed();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.elapsed(), frozen, '暫停時局內時間不走');
    // 暫停時動作被擋（附原因），不會改變船上
    sup.send({ t: 'act', id: 'during-pause', ev: { type: 'setItem', item: '麥子', on: false } });
    await sup.until(() => sup.rejections.some((x) => x.id === 'during-pause'));
    assert.equal(sup.rejections.find((x) => x.id === 'during-pause')!.reasons[0].code, 'PAUSED');
    assert.equal(sup.view!.ship!.items.find((i) => i.id === '麥子')!.onShip, true, '暫停時船上沒變');
    // 一個人回來：1／4 離線，繼續；局內時間從停住的地方接著走
    const back = await resume(url, o2);
    phones[phones.indexOf(o2)] = back;
    await host.until(() => host.view?.paused === null, 3000, '恢復');
    assert.ok(r.elapsed() - frozen < 200, `恢復後時間接得上（差 ${r.elapsed() - frozen}ms）`);
  } finally {
    phones.forEach((p) => p.close());
    await srv.close();
  }
});

test('存檔：伺服器重啟後讀回房間，大家重連回到同一局、同一個職能；重連前這局是暫停的', async () => {
  const store = new MemoryRoomStore();
  const srv1 = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20, introMs: 0, store });
  const { host, phones } = await room(srv1, 3);
  host.send({ t: 'start' });
  await host.until(() => host.view?.phase === 'planning');
  const sup = phones.find((p) => p.view!.can.items)!;
  sup.send({ t: 'act', id: 'before-restart', ev: { type: 'setItem', item: '麥子', on: false } });
  await sup.until(() => sup.view!.ship!.items.find((i) => i.id === '麥子')!.onShip === false);
  const before = phones.map((p) => ({ roles: p.view!.me.roles.map((x) => x.id).join(), elapsed: p.view!.round!.elapsedMs }));
  const code = host.code;
  phones.forEach((p) => p.close());
  await srv1.close(); // 關機前會把房間存好
  assert.ok(store.rows.has(code), '房間有存檔');

  const srv2 = await startServer({ port: 0, publicUrl: 'http://test.local', tickMs: 20, introMs: 0, store });
  try {
    const url = `ws://localhost:${srv2.port}/ws`;
    const restored = srv2.rooms.get(code) as Room;
    assert.ok(restored, '新伺服器讀回房間');
    assert.ok(restored.pausedAt !== null, '大家都還沒連回來：暫停');
    const again: Phone[] = [];
    for (const p of phones) again.push(await resume(url, p));
    try {
      for (const [i, p] of again.entries()) {
        assert.deepEqual(p.errors, []);
        await p.until(() => p.view?.paused === null && p.view.players.every((x) => x.connected), 3000, '大家回來、恢復計時');
        assert.equal(p.view!.phase, 'planning');
        assert.equal(p.view!.me.roles.map((x) => x.id).join(), before[i].roles, '同一個職能');
      }
      const s = again.find((p) => p.view!.can.items)!;
      assert.equal(s.view!.ship!.items.find((i) => i.id === '麥子')!.onShip, false, '重啟前丟掉的麥子還是丟掉的');
      assert.ok(s.view!.round!.elapsedMs - before[0].elapsed < 1500, '重啟期間倒數沒有跑掉');
      // 重啟前用過的動作代號仍然去重
      s.send({ t: 'act', id: 'before-restart', ev: { type: 'setItem', item: '麥子', on: true } });
      await s.until(() => s.acks.includes('before-restart'));
      assert.equal(s.view!.ship!.items.find((i) => i.id === '麥子')!.onShip, false);
    } finally {
      again.forEach((p) => p.close());
    }
  } finally {
    await srv2.close();
  }
});

test('存檔格式：serialize → restore 後每個人看到的畫面一樣（Map 也保留）', async () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const r = new Room('ABCD', { now, seed: 7, introMs: 0 });
  const ids = ['甲', '乙', '丙', '丁', '戊'].map((n) => r.addPlayer(n).id);
  r.start(ids[0]);
  t += 5_000;
  r.tick();
  const copy = Room.restore(r.serialize(), { now });
  for (const p of copy.players) p.connected = true;
  copy.updatePause();
  for (const id of ids) {
    const a = r.view(id, 'u', null);
    const b = copy.view(id, 'u', null);
    assert.deepEqual(b, a);
  }
});
