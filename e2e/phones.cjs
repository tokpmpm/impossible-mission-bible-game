// 模擬真手機（docs/16 第 8 節）：iPhone／Android 裝置設定（螢幕、觸控、瀏覽器識別）＋4G 延遲抖動，
// 情境：鎖螢幕、切到別的 App、兩人同時鎖螢幕（暫停）、Wi‑Fi 換 4G、進電梯。
// 執行：npm run e2e:phones（自己開 Node 伺服器）；E2E_EXTERNAL=1 PORT=8787 測 wrangler dev。
// 限制：只有 Chromium（不是真的 Safari）；「App 進背景」用 Debugger.pause 停住整個頁面的 JS 來模擬
// （CDP 的 frozen 在 headless 下計時器照跑，不能用）；iOS 關掉連線用代理切斷模擬。這是模擬，不是真機測試。
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');
const PORT = Number(process.env.PORT || 3400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
const res = [];
const check = (ok, what) => { log(ok ? '  ✓' : '  ✗', what); res.push([ok, what]); };
// 行動網路：每段資料延遲 base±jitter（保持順序）
function proxy(port, base, jitter) {
  const st = { socks: new Set(), refuse: false };
  net.createServer((c) => {
    if (st.refuse) return c.destroy();
    const u = net.connect(PORT, '127.0.0.1');
    const pair = { c, u, dead: false }; st.socks.add(pair);
    const pipe = (a, b) => { let last = 0; a.on('data', (d) => { if (pair.dead) return; const at = Math.max(last, Date.now() + base + Math.random() * jitter); last = at; setTimeout(() => !pair.dead && !b.destroyed && b.write(d), at - Date.now()); }); };
    pipe(c, u); pipe(u, c);
    const end = () => { c.destroy(); u.destroy(); st.socks.delete(pair); };
    for (const s of [c, u]) s.on('close', end).on('error', end);
  }).listen(port);
  st.kill = () => [...st.socks].forEach((p) => (p.c.destroy(), p.u.destroy()));
  st.dead = () => st.socks.forEach((p) => (p.dead = true));
  return st;
}
(async () => {
  const server = process.env.E2E_EXTERNAL ? null : spawn(process.execPath, ['src/server/main.ts'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), INTRO_MS: '0', BOARDING_MS: process.env.BOARDING_MS || '0' }, stdio: 'ignore' });
  process.on('exit', () => server?.kill());
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break; } catch {} await sleep(100); }
  const kinds = [['iPhone 13', 'iPhone 甲'], ['Pixel 7', 'Android 乙'], ['iPhone SE', 'iPhone 丙'], ['Galaxy S9+', 'Android 丁']];
  const px = kinds.map((_, i) => proxy(PORT + 1 + i, 80, 220)); // 4G：80–300ms 單程
  const browser = await chromium.launch();
  const ph = [];
  for (const [i, [dev, name]] of kinds.entries()) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const p = await ctx.newPage();
    await p.addInitScript(() => { const W = window.WebSocket; window.__ws = []; window.WebSocket = function (u) { const w = new W(u); window.__ws.push(w); return w; }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); });
    p.on('pageerror', (e) => check(false, `${name} JS 錯誤 ${e.message}`));
    ph.push({ p, name, nick: name.split(' ')[1], cdp: await ctx.newCDPSession(p), url: `http://localhost:${PORT + 1 + i}`, px: px[i] });
  }
  const banner = (p) => p.evaluate(() => { const e = document.getElementById('conn'); return e && !e.hidden ? e.textContent : ''; });
  const live = (p) => p.evaluate(() => window.__ws.length > 0 && window.__ws[window.__ws.length - 1].readyState === 1 && document.getElementById('conn').hidden);
  const note = (p) => p.evaluate(() => (document.querySelector('.conn-note') || {}).textContent || '');
  const cd = (p) => p.evaluate(() => (document.querySelector('[data-cd=round]') || {}).textContent);
  const roles = (p) => p.evaluate(() => [...document.querySelectorAll('#body button[data-action], #hud button[data-action]')].map((b) => b.dataset.action).sort().join(','));
  const waitFor = async (fn, ms, step = 100) => { const s = Date.now(); while (Date.now() - s < ms) { if (await fn()) return Date.now() - s; await sleep(step); } return -1; };
  // iOS 鎖螢幕：頁面進背景＋凍結，系統關掉連線
  const lock = async (h, killSocket) => {
    await h.p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await h.cdp.send('Debugger.enable');
    await h.cdp.send('Debugger.pause');
    if (killSocket) { h.px.refuse = true; h.px.kill(); }
  };
  const unlock = async (h) => {
    h.px.refuse = false;
    await h.cdp.send('Debugger.resume');
    await h.cdp.send('Debugger.disable');
    await h.p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  };

  const [A, B, C, D] = ph;
  await A.p.goto(A.url); await A.p.tap('#in-nick'); await A.p.fill('#in-nick', A.nick); await A.p.tap('button[type=submit]'); await A.p.waitForSelector('.big-code');
  const code = (await A.p.textContent('.big-code strong')).trim();
  for (const h of [B, C, D]) { await h.p.goto(`${h.url}/?room=${code}`); await h.p.fill('#in-nick', h.nick); await h.p.tap('button[type=submit]'); await h.p.waitForSelector('.big-code'); }
  log('房間', code, '4 支模擬手機（iPhone 13、Pixel 7、iPhone SE、Galaxy S9+），4G 延遲 80–300ms');
  await A.p.tap('[data-action=start]');
  for (const h of ph) { await h.p.waitForSelector('.card-ovl'); await h.p.tap('[data-action=card-close]'); }
  await sleep(1000);

  log('S1 行動網路下操作同步速度');
  const sup = (await Promise.all(ph.map(async (h) => (await h.p.$('[data-action=item]')) ? h : null))).find(Boolean);
  const other = ph.find((h) => h !== sup);
  const offCount = (p) => p.evaluate(() => document.querySelectorAll('.item.off, [data-action=item][aria-pressed=false]').length);
  const before = await other.p.evaluate(() => document.body.innerText.match(/(\d+)\s*／\s*\d+/)?.[1]);
  const ts = Date.now();
  await sup.p.tap('[data-action=item]');
  const syncMs = await waitFor(async () => (await other.p.evaluate(() => document.body.innerText.match(/(\d+)\s*／\s*\d+/)?.[1])) !== before, 5000, 20);
  check(syncMs >= 0 && syncMs < 1500, `${sup.name} 丟一樣東西，${other.name} ${syncMs}ms 後看到`);

  log('S2 iPhone 鎖螢幕 30 秒（iOS 會關掉連線）');
  const r0 = await roles(C.p);
  await lock(C, true);
  await sleep(3000);
  check(/斷線中/.test(await note(A.p)), `其他人看到：「${(await note(A.p)).trim()}」`);
  check(!(await A.p.evaluate(() => !!document.querySelector('.conn-note.paused'))), '只有 1/4 斷線：不暫停');
  await sleep(27000);
  const tb = Date.now(); await unlock(C);
  await sleep(150);
  const b2 = await banner(C.p);
  check(!/重新整理/.test(b2), `打開那一刻的提示沒有「重新整理」：「${b2.trim()}」`);
  const back2 = await waitFor(() => live(C.p), 15000);
  check(back2 >= 0 && back2 < 5000, `打開後 ${back2}ms 回到遊戲`);
  const r1 = await roles(C.p);
  check(r1 === r0, '回來後按鈕和鎖螢幕前一樣');
  if (r1 !== r0) log('    前:', r0, '\n            後:', r1);

  log('S3 Android 切到別的 App 60 秒（連線不一定被關，但頁面停住、不送心跳）');
  await lock(B, false);
  await sleep(60000);
  check(/斷線中/.test(await note(A.p)), `60 秒後伺服器已判斷乙離線：「${(await note(A.p)).trim()}」`);
  await unlock(B);
  const back3 = await waitFor(() => live(B.p) && B.p.evaluate(() => !document.querySelector('.conn-note')), 15000);
  check(back3 >= 0 && back3 < 6000, `切回來後 ${back3}ms 回到遊戲`);

  log('S4 兩支 iPhone 同時鎖螢幕 20 秒 → 暫停');
  const c1 = await cd(A.p);
  await lock(C, true); await lock(D, true);
  check((await waitFor(() => A.p.evaluate(() => !!document.querySelector('.conn-note.paused')), 5000)) >= 0, `房主看到：「${(await note(A.p)).trim().slice(0, 30)}…」`);
  await sleep(600);
  const c2 = await cd(A.p); await sleep(15000);
  check((await cd(A.p)) === c2, `暫停中倒數停在 ${c2}`);
  await unlock(C); await unlock(D);
  const back4 = await waitFor(() => A.p.evaluate(() => !document.querySelector('.conn-note.paused')), 15000);
  check(back4 >= 0 && back4 < 6000, `兩人打開後 ${back4}ms 解除暫停`);

  log('S5 Android 從 Wi‑Fi 走出門切到 4G（舊連線變死）');
  D.px.dead();
  const n5 = await D.p.evaluate(() => window.__ws.length);
  const back5 = await waitFor(async () => (await D.p.evaluate(() => window.__ws.length)) > n5 && (await live(D.p)), 40000, 500);
  check(back5 >= 0 && back5 < 32000, `${back5}ms 自己換到新連線`);

  log('S6 進電梯 15 秒沒訊號，期間按了按鈕');
  const h6 = sup; const beforeTxt = await A.p.evaluate(() => document.body.innerText.match(/(\d+)\s*／\s*\d+/)?.[1]);
  h6.px.refuse = true; h6.px.kill(); await sleep(2500);
  await h6.p.tap('[data-action=item]').catch(() => {});
  await sleep(1000);
  const b6 = await banner(h6.p);
  check(/連上後自動送出/.test(b6), `${h6.name} 看到：「${b6.trim().slice(0, 40)}…」`);
  await sleep(11500); h6.px.refuse = false;
  const ok6 = await waitFor(async () => (await A.p.evaluate(() => document.body.innerText.match(/(\d+)\s*／\s*\d+/)?.[1])) !== beforeTxt, 12000);
  check(ok6 >= 0, `出電梯後 ${ok6}ms 那一下有生效（其他人看到載重改變）`);
  if (process.env.SHOTS) for (const h of ph) await h.p.screenshot({ path: path.join(process.env.SHOTS, `phone-${h.nick}.png`) });
  await browser.close();
  const bad = res.filter((x) => !x[0]);
  console.log(bad.length ? `失敗 ${bad.length} 項` : `通過：模擬手機 ${res.length} 項（不是真機測試）`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
