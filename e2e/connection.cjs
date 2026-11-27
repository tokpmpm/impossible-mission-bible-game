// 連線情境端對端（docs/16）：3 支模擬手機，丙經過一個可控的 TCP 代理，模擬網路出狀況。
// 執行：npm run e2e:conn（自己開 Node 伺服器）；或 E2E_EXTERNAL=1 PORT=8787 測已在跑的伺服器（例如 wrangler dev）。
// 情境：硬斷線、網路換手（舊連線變死但不關）、連線卡在「連線中」、遊戲中 2/3 斷線暫停、遊戲中斷線回到原職能。
// 「伺服器重啟後接回同一局」需要重啟 wrangler dev，步驟寫在 docs/16；Node 版用 test/connection.test.ts 的存檔測試。
// 這是模擬，不是真機測試。
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
const fails = [];
const check = (ok, what) => {
  log(ok ? '  ✓' : '  ✗', what);
  if (!ok) fails.push(what);
};

/** 可控 TCP 代理：dead＝現有連線的資料全部丟掉但不關閉；refuse＝拒絕新連線；hang＝新連線接受但永遠不轉送。 */
function proxy(port) {
  const st = { socks: new Set(), refuse: false, hang: false };
  net
    .createServer((c) => {
      if (st.refuse) return c.destroy();
      const u = net.connect(PORT, '127.0.0.1');
      const pair = { c, u, dead: st.hang };
      st.socks.add(pair);
      c.on('data', (d) => !pair.dead && u.write(d));
      u.on('data', (d) => !pair.dead && c.write(d));
      const end = () => {
        c.destroy();
        u.destroy();
        st.socks.delete(pair);
      };
      for (const s of [c, u]) s.on('close', end).on('error', end);
    })
    .listen(port);
  st.killAll = () => [...st.socks].forEach((p) => (p.c.destroy(), p.u.destroy()));
  st.deadAll = () => st.socks.forEach((p) => (p.dead = true));
  return st;
}

const WS_SPY = () => {
  const W = window.WebSocket;
  window.__ws = [];
  window.WebSocket = function (u) {
    const w = new W(u);
    window.__ws.push(w);
    return w;
  };
  window.WebSocket.prototype = W.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
};

(async () => {
  const server = process.env.E2E_EXTERNAL
    ? null
    : spawn(process.execPath, ['src/server/main.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT), INTRO_MS: '0', BOARDING_MS: process.env.BOARDING_MS || '0' }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break;
      } catch {}
      await sleep(100);
    }
    const px = [proxy(PORT + 1), proxy(PORT + 2), proxy(PORT + 3)];
    browser = await chromium.launch();
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const p = await ctx.newPage();
      await p.addInitScript(WS_SPY);
      p.on('pageerror', (e) => fails.push(`p${i} JS 錯誤：${e.message}`));
      pages.push(p);
    }
    const [A, B, C] = pages;
    const base = (i) => `http://localhost:${PORT + 1 + i}`;
    const banner = (p) => p.evaluate(() => {
      const e = document.getElementById('conn');
      return e && !e.hidden ? e.textContent : '';
    });
    const wsCount = (p) => p.evaluate(() => window.__ws.length);
    const lastOpen = (p) => p.evaluate(() => window.__ws.length > 0 && window.__ws[window.__ws.length - 1].readyState === 1);
    const pref = (p, name) => p.evaluate((n) => {
      const li = [...document.querySelectorAll('.player')].find((x) => x.textContent.includes(n));
      return li ? li.textContent : '';
    }, name);
    const offline = (p, name) => p.evaluate((n) => [...document.querySelectorAll('.player.off')].some((li) => li.textContent.includes(n)), name);
    const waitFor = async (fn, ms, step = 100) => {
      const s = Date.now();
      while (Date.now() - s < ms) {
        if (await fn()) return Date.now() - s;
        await sleep(step);
      }
      return -1;
    };

    await A.goto(base(0));
    await A.fill('#in-nick', '甲');
    await A.click('button[type=submit]');
    await A.waitForSelector('.big-code');
    const code = (await A.textContent('.big-code strong')).trim();
    for (const [i, n] of [[1, '乙'], [2, '丙']]) {
      await pages[i].goto(`${base(i)}/?room=${code}`);
      await pages[i].fill('#in-nick', n);
      await pages[i].click('button[type=submit]');
      await pages[i].waitForSelector('.big-code');
    }
    log('房間', code);

    log('情境 1：硬斷線 10 秒（網路完全中斷）');
    px[2].refuse = true;
    px[2].killAll();
    check((await waitFor(() => offline(A, '丙'), 3000)) >= 0, '房主 3 秒內看到丙離線');
    check((await waitFor(async () => !!(await banner(C)), 4000)) >= 0, '丙 4 秒內出現斷線提示');
    await C.click('[data-action=pref][data-value=coat]');
    await sleep(8000);
    px[2].refuse = false;
    const back1 = await waitFor(async () => (await lastOpen(C)) && !(await banner(C)), 8000);
    check(back1 >= 0, `網路恢復後 8 秒內自動連回（${back1}ms）`);
    check((await waitFor(async () => (await pref(A, '丙')).includes('外衣'), 3000)) >= 0, '斷線時選的「外衣」連回後有送到');

    log('情境 2：網路換手（舊連線變死、不關閉；新連線可以通）');
    const n2 = await wsCount(C);
    px[2].deadAll();
    await C.click('[data-action=pref][data-value=lamp]');
    const sw = await waitFor(async () => (await wsCount(C)) > n2 && (await lastOpen(C)), 35000, 500);
    check(sw >= 0 && sw <= 32000, `丙 32 秒內自己換一條新連線（${sw}ms）`);
    check((await waitFor(async () => (await pref(A, '丙')).includes('油燈'), 3000)) >= 0, '換手期間選的「油燈」最後有送到');

    log('情境 3：連線卡在「連線中」（伺服器接受但永遠不回，類似 iOS 回前景卡住）');
    px[2].hang = true;
    px[2].killAll();
    await sleep(25000);
    const b3 = await banner(C);
    check((await wsCount(C)) >= n2 + 4, '卡住時會一直放棄重來（6 秒逾時）');
    check(/重新整理/.test(b3), `卡住 25 秒後提示有「重新整理」：${b3.trim()}`);
    px[2].hang = false;
    const back3 = await waitFor(async () => (await lastOpen(C)) && !(await banner(C)), 10000);
    check(back3 >= 0 && back3 <= 8000, `網路恢復後 8 秒內連上（${back3}ms）`);

    log('情境 4：遊戲中 2／3 斷線 → 暫停，回來後繼續');
    await A.click('[data-action=start]');
    for (const p of pages) {
      await p.waitForSelector('.card-ovl');
      await p.click('[data-action=card-close]');
    }
    await sleep(1500);
    const cd = (p) => p.evaluate(() => (document.querySelector('[data-cd=round]') || {}).textContent);
    for (const i of [1, 2]) {
      px[i].refuse = true;
      px[i].killAll();
    }
    check((await waitFor(() => A.evaluate(() => !!document.querySelector('.conn-note.paused')), 3000)) >= 0, '房主看到「時間暫停」');
    const c1 = await cd(A);
    await sleep(5000);
    check((await cd(A)) === c1, `暫停時倒數不動（${c1}）`);
    for (const i of [1, 2]) px[i].refuse = false;
    check((await waitFor(() => A.evaluate(() => !document.querySelector('.conn-note.paused')), 10000)) >= 0, '大家回來後暫停解除');

    log('情境 5：遊戲中斷線 6 秒 → 回到原職能、原按鈕');
    const snap = () => C.evaluate(() => ({
      roles: [...document.querySelectorAll('#hud .chip, #hud [class*=role]')].map((e) => e.textContent.trim()).join('|'),
      btns: [...document.querySelectorAll('button[data-action]:not([disabled])')].map((b) => b.dataset.action).sort().join(','),
    }));
    const before = await snap();
    px[2].refuse = true;
    px[2].killAll();
    check((await waitFor(() => A.evaluate(() => /丙 斷線中/.test((document.querySelector('.conn-note') || {}).textContent || '')), 3000)) >= 0, '隊友在遊戲畫面看到「丙 斷線中」');
    await sleep(5000);
    px[2].refuse = false;
    await waitFor(async () => (await lastOpen(C)) && !(await banner(C)), 8000);
    await sleep(800);
    const after = await snap();
    check(before.roles === after.roles && before.btns === after.btns, '回來後職能與按鈕和斷線前一樣');
  } catch (e) {
    fails.push(String(e && e.stack ? e.stack : e));
  } finally {
    if (browser) await browser.close();
    server?.kill();
  }
  if (fails.length) {
    console.log('失敗：\n- ' + fails.join('\n- '));
    process.exit(1);
  }
  console.log('通過：連線情境 1–5（模擬，非真機）');
  process.exit(0);
})();
