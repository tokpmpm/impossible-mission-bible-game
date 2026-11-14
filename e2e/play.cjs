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
  await host.waitForSelector('.role-hero');
  for (let i = 0; i < N; i++) await shot(pages[i], `04-intro-p${i}`);
  await host.click('[data-action=zoom]');
  await shot(host, '05-zoom');
  await host.click('[data-action=unzoom]');
  for (const p of pages) await p.click('[data-action=intro-tab][data-tab=plan]');
  await sleep(200);
  const findPage = async (sel) => {
    for (const p of pages) if (await p.$(sel + ':not([disabled])')) return p;
    return null;
  };
  const nav = await findPage('[data-action=route]');
  const sup = await findPage('[data-action=item]');
  await nav.click('[data-action=route][data-route=紅]');
  await sleep(150);
  for (const name of ['藥品', '飲水', '毛毯', '食物']) {
    const b = await sup.$(`[data-action=item]:has-text("${name}")`);
    if (b) { await b.click(); await sleep(150); }
  }
  await sleep(300);
  await shot(nav, '06-plan-overweight');
  const food = await sup.$('[data-action=item]:has-text("食物")');
  if (food) await food.click();
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `07-plan-p${i}`);
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
      for (const h of await p.$$('[data-hold]')) {
        const label = await h.getAttribute('aria-label');
        if (!label.includes(`第 ${slotDisp} 格`)) continue;
        const box = await h.boundingBox();
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await p.mouse.down();
        await sleep(150);
        desc = (await p.textContent('.hold-desc')).trim();
        if (guard === 0) await p.screenshot({ path: OUT + tag+'09-hold-symbol.png' });
        await p.mouse.up();
        await sleep(100);
        if (guard === 0) await shot(p, tag+'10-hold-released');
      }
    }
    if (guard === 0) {
      for (const w of await eng.$$('[data-action=pick]:not([disabled])')) {
        if ((await w.textContent()).trim() !== desc) { await w.click(); break; }
      }
      await sleep(250);
      await shot(eng, tag+'11-eng-wrong');
    }
    const opt = await eng.$(`[data-action=pick]:has-text("${desc}")`);
    if (!opt) { console.log('no opt for', desc); break; }
    await opt.click();
    await sleep(250);
  }
  }
  await doRepair('');
  await pages[0].waitForSelector('.blackout', { state: 'detached', timeout: 15000 });
  await sleep(400);
  for (let i = 0; i < N; i++) await shot(pages[i], `12-replan-p${i}`);
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
  for (const p of pages) await p.click('[data-action=intro-tab][data-tab=plan]');
  await sleep(300);
  const nav2 = await findPage('[data-action=route]');
  const sup2 = await findPage('[data-action=item]');
  await nav2.click('[data-action=route][data-route=藍]');
  for (const name of ['食物', '藥品', '飲水']) { await sup2.click(`[data-action=item]:has-text("${name}")`); await sleep(150); }
  await sleep(300);
  await shot(nav2, 'r2-07-plan');
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
