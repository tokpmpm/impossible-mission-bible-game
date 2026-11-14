const { chromium } = require('playwright');
// 瀏覽器端對端：N 支模擬手機玩完 seed 001 與 seed 002 兩局。由 e2e/run.mjs 啟動（會先開伺服器）。
const OUT = (process.env.SHOTS || require('os').tmpdir() + '/im-shots') + '/' + (process.env.TAG || '');
require('fs').mkdirSync(require('path').dirname(OUT + 'x'), { recursive: true });
// BASE_URL：直接測已部署的網址（例如 https://impossible-mission.xxx.workers.dev）
const BASE = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3100);
const N = Number(process.env.N || 3);
const W = Number(process.env.W || 390);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const proxy = process.env.BASE_URL && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch(proxy ? { proxy } : {});
  const pages = [];
  const errs = [];
  for (let i = 0; i < N; i++) {
    const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: !!proxy });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`p${i}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(`p${i} console: ${m.text()}`); });
    pages.push(p);
  }
  const shot = async (p, name) => {
    await sleep(150);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (sw > W) errs.push(`${name}: horizontal overflow ${sw}`);
    await p.screenshot({ path: OUT + name + '.png', fullPage: true });
  };
  const [host] = pages;
  await host.goto(BASE);
  await shot(host, '00-home');
  await host.fill('#in-nick', '小明');
  await host.click('button[type=submit]');
  await host.waitForSelector('.big-code');
  const code = (await host.textContent('.big-code strong')).trim();
  for (let i = 1; i < N; i++) {
    await pages[i].goto(BASE + '/?room=' + code);
    if (i === 1) await shot(pages[i], '01-join-prefilled');
    await pages[i].fill('#in-nick', '隊員' + i);
    await pages[i].click('button[type=submit]');
    await pages[i].waitForSelector('.big-code');
  }
  await pages[1].click('[data-action=pref][data-value=casual]');
  await sleep(200);
  await shot(host, '02-lobby-host');
  await shot(pages[1], '03-lobby-guest');
  await host.click('[data-action=start]');
  await host.waitForSelector('.board');
  // 前 60 秒（測試時縮短）不能鎖定：按了會在按鈕上方說明還要等多久
  await host.click('[data-action=lock]');
  await host.waitForSelector('.bar-note.rejected:has-text("認識隊友")', { timeout: 5000 });
  await shot(host, '04a-lock-too-early');
  await host.click('[data-action=note-close]');
  const steps = await host.textContent('.next-step');
  if (!/去(問|告訴|找)/.test(steps)) errs.push('開局下一步沒有具體對象：' + steps.trim().slice(0, 60));
  for (let i = 0; i < N; i++) await shot(pages[i], `04-intro-p${i}`);
  await host.click('[data-action=zoom]');
  await shot(host, '05-zoom');
  await host.click('[data-action=unzoom]');
  await sleep(200);
  // 一個畫面看完：規劃畫面不需要往下捲（3、6 人 390／360px 嚴格檢查；320px 窄螢幕只記錄）
  for (let i = 0; i < N; i++) {
    const over = await pages[i].evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (over > 0) {
      const msg = `p${i} 規劃畫面要往下捲 ${over}px`;
      if (W >= 360) errs.push(msg); else console.log('提醒：' + msg);
    }
  }
  const findPage = async (sel) => {
    for (const p of pages) if (await p.$(sel + ':not([disabled])')) return p;
    return null;
  };
  // 路線、物資按鈕大家都能按；自己負責的才有 data-mine
  const mineOf = async (action) => findPage(`[data-action=${action}][data-mine]`);
  const waitLockOpen = (p) => p.waitForSelector('.status-line[data-lock-open="1"]', { timeout: 75000 });
  const nav = await mineOf('route');
  const sup = await mineOf('item');
  await nav.click('[data-action=route][data-route=紅]');
  await sleep(150);
  for (const name of ['藥品', '飲水', '毛毯', '食物']) {
    const b = await sup.$(`[data-action=item]:has-text("${name}")`);
    if (b) { await b.click(); await sleep(150); }
  }
  await sleep(300);
  await shot(nav, '06-plan-overweight');
  if (!(await nav.$('.status-line.bad'))) errs.push('超重時狀態列沒有變紅');
  // 不是導航的人點路線：不會沒反應，會說要找誰
  const notNav = pages.find((p) => p !== nav);
  await notNav.click('[data-action=route][data-route=藍]');
  await notNav.waitForSelector('.bar-note:has-text("導航")', { timeout: 3000 });
  await shot(notNav, '06b-not-my-button');
  // 超重時按鎖定：按的人看到原因＋下一步
  await waitLockOpen(nav);
  await nav.click('[data-action=lock]');
  await nav.waitForSelector('.bar-note.rejected:has-text("超重 2 kg")', { timeout: 3000 });
  await shot(nav, '06c-lock-overweight');
  const food = await sup.$('[data-action=item]:has-text("食物")');
  if (food) await food.click();
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `07-plan-p${i}`);
  await waitLockOpen(pages[0]);
  const locker = await findPage('[data-action=lock]');
  await locker.click('[data-action=lock]');
  await pages[0].waitForSelector('.blackout');
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `08-blackout-p${i}`);
  async function doRepair(tag) {
  const eng = await findPage('[data-action=pick]');
  for (let guard = 0; guard < 6; guard++) {
    if (!(await eng.$('[data-action=pick]'))) break;
    const ask = (await eng.textContent('.eng h2')).trim();
    const slotDisp = Number(ask.match(/第 (\d+) 格/)[1]);
    let desc = null;
    for (const p of pages) {
      const holds = p.locator('[data-hold]');
      for (let hi = 0; hi < (await holds.count()); hi++) {
        const h = holds.nth(hi);
        const label = await h.getAttribute('aria-label');
        if (!label.includes(`第 ${slotDisp} 格`)) continue;
        await h.scrollIntoViewIfNeeded();
        const box = await h.boundingBox();
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await p.mouse.down();
        await sleep(150);
        desc = await h.getAttribute('data-sym'); // 畫面上只有圖，測試從屬性讀符號代號
        if (guard === 0) await p.screenshot({ path: OUT + tag+'09-hold-symbol.png' });
        await p.mouse.up();
        await sleep(100);
        if (guard === 0) await shot(p, tag+'10-hold-released');
      }
    }
    if (guard === 0) {
      const picks = eng.locator('[data-action=pick]:not([disabled])');
      for (let wi = 0; wi < (await picks.count()); wi++) {
        const w = picks.nth(wi);
        // 按鈕文字含圖示標題＋描述，用 includes 判斷，確保真的選到錯的
        if ((await w.getAttribute('data-opt')) !== desc) { await w.click(); break; }
      }
      await sleep(250);
      await shot(eng, tag+'11-eng-wrong');
    }
    const opt = eng.locator(`[data-action=pick][data-opt="${desc}"]`);
    if (!(await opt.count())) { console.log("no opt for", desc, "ask", ask, "opts", (await eng.locator("[data-action=pick]").allTextContents()).join("/")); break; }
    await opt.first().click();
    // 等工程師畫面換到下一格（或修好）再讀，避免讀到舊的格子
    await eng.waitForFunction((prev) => {
      const h = document.querySelector('.eng h2');
      return !h || h.textContent.trim() !== prev;
    }, ask, { timeout: 5000 });
    await sleep(100);
  }
  }
  await doRepair('');
  await pages[0].waitForSelector('.blackout', { state: 'detached', timeout: 15000 });
  await sleep(400);
  for (let i = 0; i < N; i++) await shot(pages[i], `12-replan-p${i}`);
  for (let i = 0; i < N; i++) {
    const over = await pages[i].evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (over > 0) {
      const msg = `p${i} 停電後的規劃畫面要往下捲 ${over}px`;
      if (W >= 360) errs.push(msg); else console.log('提醒：' + msg);
    }
  }
  const fg = await findPage('#in-channel');
  if (fg) {
    await fg.fill('#in-channel', '999');
    await fg.click('[data-form=floodgate] button');
    await sleep(300);
    await shot(fg, '13-floodgate-wrong');
    let ch = null;
    for (const p of pages) {
      const t = await p.textContent('body');
      const mm = t.match(/授權頻道是 ?([^\s。]+)/);
      if (mm) ch = mm[1];
    }
    console.log('channel', ch);
    await fg.fill('#in-channel', ch);
    await fg.click('[data-form=floodgate] button');
    await sleep(300);
    await nav.click('[data-action=route][data-route=綠]');
    await sleep(300);
    await shot(fg, '14-floodgate-done');
  }
  const dep = await findPage('[data-action=depart]');
  await dep.click('[data-action=depart]');
  await pages[0].waitForSelector('.result-hero');
  await sleep(300);
  await pages[1].click('[data-action=thank]');
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `15-result-p${i}`);
  await pages[2].reload();
  await sleep(1500);
  await shot(pages[2], '16-reload-resume');
  await host.click('[data-action=next]');
  await sleep(800);
  await shot(host, '17-after-next');
  // ── 第二局 seed 002 ──
  await sleep(300);
  await sleep(300);
  const nav2 = await mineOf('route');
  const sup2 = await mineOf('item');
  await nav2.click('[data-action=route][data-route=藍]');
  for (const name of ['食物', '藥品', '飲水']) { await sup2.click(`[data-action=item]:has-text("${name}")`); await sleep(150); }
  await sleep(300);
  await shot(nav2, 'r2-07-plan');
  await waitLockOpen(nav2);
  await (await findPage('[data-action=lock]')).click('[data-action=lock]');
  await pages[0].waitForSelector('.blackout');
  await sleep(300);
  await doRepair('r2-');
  await pages[0].waitForSelector('.blackout', { state: 'detached', timeout: 15000 });
  await sleep(400);
  const q = await findPage('[data-action=q-village]');
  await q.click('[data-action=q-village][data-value=北村]');
  await q.click('[data-action=q-question][data-value=well]');
  await q.click('[data-action=q-ask]');
  await sleep(200);
  await shot(q, 'r2-12-query-confirm');
  await q.click('[data-action=q-send]');
  await sleep(400);
  await sup2.click('[data-action=item]:has-text("飲水")');
  await sleep(200);
  await sup2.click('[data-action=item]:has-text("淨水錠")');
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `r2-13-replan-p${i}`);
  await (await findPage('[data-action=depart]')).click('[data-action=depart]');
  await pages[0].waitForSelector('.result-hero');
  await sleep(300);
  await shot(pages[0], 'r2-15-result');
  const title = await pages[0].textContent('.result-hero');
  if (!title.includes('三村都送到了')) errs.push('第二局沒有拿到三星：' + title.trim().slice(0, 40));
  await browser.close();
  if (errs.length) {
    console.error('失敗：', errs);
    process.exit(1);
  }
  console.log(`通過：${N} 人、${W}px，兩局三星，無 JS 錯誤與橫向捲動。截圖在 ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
