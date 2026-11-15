const { chromium } = require('playwright');
// 瀏覽器端對端：N 支模擬手機玩完兩局保羅海難。由 e2e/run.mjs 啟動（會先開伺服器）。
// 檢查：按鈕只出現在負責的人手機上、丟東西、決定好了、黑暗補船、吃飯、衝向海灘、三星、下一局換卡、無 JS 錯誤與橫向捲動。
const OUT = (process.env.SHOTS || require('os').tmpdir() + '/im-shots') + '/' + (process.env.TAG || '');
require('fs').mkdirSync(require('path').dirname(OUT + 'x'), { recursive: true });
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
    const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: Number(process.env.DSF || 1), ignoreHTTPSErrors: !!proxy });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`p${i}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(`p${i} console: ${m.text()}`); });
    pages.push(p);
  }
  const shot = async (p, name) => {
    await sleep(150);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (sw > W) errs.push(`${name}: horizontal overflow ${sw}`);
    await p.screenshot({ path: OUT + name + '.png', fullPage: !process.env.VIEWPORT_ONLY });
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
    await pages[i].fill('#in-nick', '隊員' + i);
    await pages[i].click('button[type=submit]');
    await pages[i].waitForSelector('.big-code');
  }
  await pages[1].click('[data-action=pref][data-value=lamp]');
  await pages[2].click('[data-action=pref][data-value=coat]');
  await sleep(300);
  const bags = await host.textContent('.players');
  if (!bags.includes('油燈') || !bags.includes('外衣')) errs.push('大廳名單沒有顯示背包物品：' + bags.trim().slice(0, 80));
  await shot(host, '02-lobby-host');
  await host.click('[data-action=start]');
  // 開局：起風卡自動翻開
  await host.waitForSelector('.card-ovl');
  await shot(host, '03-card-a');
  for (const p of pages) { await p.waitForSelector('.card-ovl'); await p.click('[data-action=card-close]'); }
  await sleep(200);
  for (let i = 0; i < N; i++) await shot(pages[i], `04-intro-p${i}`);

  const findPage = async (sel) => {
    for (const p of pages) if (await p.$(sel + ':not([disabled])')) return p;
    return null;
  };
  /** 只留下 keep 裡的東西（每次都重新找元素，畫面重畫後舊的元素會失效）。 */
  const setKeep = async (p, keep) => {
    for (const id of ['糧食', '纜索', '錨', '麥子', '器具', '小船']) {
      const sel = '.tray-item[data-item="' + id + '"]';
      if (!(await p.$(sel))) continue;
      const want = keep.includes(id);
      const on = (await p.getAttribute(sel, 'aria-pressed')) === 'true';
      if (on === want) continue;
      await p.click(sel);
      await p.waitForFunction(([s, w]) => { const e = document.querySelector(s); return !e || (e.getAttribute('aria-pressed') === 'true') === w; }, [sel, want], { timeout: 3000 });
    }
  };
  const countPages = async (sel) => { let n = 0; for (const p of pages) if (await p.$(sel)) n++; return n; };
  // 不是自己能操作的不顯示：托盤、決定好了各只有一支手機
  if ((await countPages('.tray')) !== 1) errs.push('托盤不只出現在管倉手機');
  if ((await countPages('[data-action=lock]')) !== 1) errs.push('「決定好了」不只出現在船長手機');
  const sup = await findPage('.tray');
  const cap = await findPage('[data-action=lock]');
  // 前 60 秒（測試時縮短）不能決定
  await cap.click('[data-action=lock]');
  await cap.waitForSelector('.bar-note.rejected', { timeout: 5000 });
  await shot(cap, '05-lock-too-early');
  await cap.click('[data-action=note-close]');
  const isPinned = !!(await sup.$('.tray-item.pinned'));
  // 丟掉三樣誘答（A1 時麥子丟不掉，改丟糧食以外的）
  const throwItems = isPinned ? ['器具', '小船', '錨'] : ['麥子', '器具', '小船'];
  for (const name of throwItems) {
    await sup.click(`.tray-item[data-item="${name}"]`);
    await sleep(250);
  }
  await sleep(600);
  await shot(sup, '06-thrown');
  for (let i = 0; i < N; i++) await shot(pages[i], `07-plan-p${i}`);
  await cap.waitForSelector('.status-line[data-lock-open="1"]', { timeout: 75000 });
  await cap.click('[data-action=lock]');
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
          // 畫面可能剛好重畫（別人的動作、協助模式），按鈕被換掉就重試
          for (let tries = 0; tries < 4 && !desc; tries++) {
            try {
              await h.scrollIntoViewIfNeeded({ timeout: 2000 });
              const box = await h.boundingBox();
              await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await p.mouse.down();
              await sleep(150);
              desc = await h.getAttribute('data-sym', { timeout: 2000 });
            } catch {
              await p.mouse.up();
              await sleep(200);
            }
          }
          if (guard === 0 && tag === '') await p.screenshot({ path: OUT + '09-hold-symbol.png' });
          await p.mouse.up();
          await sleep(100);
        }
      }
      const opt = eng.locator(`[data-action=pick][data-opt="${desc}"]`);
      if (!(await opt.count())) { errs.push('找不到記號選項 ' + desc); break; }
      if (guard === 0 && tag === '') await shot(eng, '10-eng-panel');
      await opt.first().click();
      await eng.waitForFunction((prev) => { const h = document.querySelector('.eng h2'); return !h || h.textContent.trim() !== prev; }, ask, { timeout: 5000 });
      await sleep(100);
    }
  }
  await doRepair('');
  await pages[0].waitForSelector('.blackout', { state: 'detached', timeout: 15000 });
  // 風暴卡翻開
  for (const p of pages) { await p.waitForSelector('.card-ovl', { timeout: 5000 }); }
  await shot(pages[0], '11-card-b');
  for (const p of pages) await p.click('[data-action=card-close]');
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `12-replan-p${i}`);
  // 吃飯按鈕只在伙房手機上；糧食要在船上
  if ((await countPages('[data-action=eat]')) !== 1) errs.push('吃飯按鈕不只出現在伙房手機');
  const cook = await findPage('[data-action=eat]');
  await cook.click('[data-action=eat]');
  await pages[0].waitForSelector('.meal-ovl', { timeout: 3000 });
  await sleep(1200);
  await shot(pages[0], '13-meal');
  await pages[0].waitForSelector('.meal-ovl', { state: 'detached', timeout: 5000 });
  // 留纜索＋錨（A4 時纜索已綁好、只留錨），丟掉其他
  await setKeep(sup, ['纜索', '錨']);
  await sleep(400);
  await shot(sup, '14-replan-final');
  const capPage = await findPage('[data-action=depart]');
  // 等天亮（B5）時可能要等一下
  await capPage.waitForSelector('.status-line.ok', { timeout: 30000 });
  await capPage.click('[data-action=depart]');
  await pages[0].waitForSelector('.landing-ovl', { timeout: 3000 });
  await sleep(2200);
  await shot(pages[0], '15a-landing');
  await pages[0].waitForSelector('.result-hero', { timeout: 8000 });
  await pages[0].waitForSelector('.landing-ovl', { state: 'detached', timeout: 6000 });
  const result = await pages[0].textContent('.result');
  if (!result.includes('上岸很順利')) errs.push('第一局沒有三星：' + result.trim().slice(0, 60));
  if (!result.includes('外衣')) errs.push('結尾沒有點名背包裡的外衣');
  if (!/27:\d+/.test(result) || !result.includes('你知道嗎')) errs.push('結尾缺經文或小知識');
  await pages[1].click('[data-action=thank]');
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `15-result-p${i}`);
  await pages[2].reload();
  await sleep(1500);
  await shot(pages[2], '16-reload-resume');
  await host.click('[data-action=next]');
  // ── 第二局：新的故事卡、職能輪替；這次不吃飯，二星 ──
  await host.waitForSelector('.card-ovl');
  await shot(host, 'r2-03-card-a');
  for (const p of pages) { await p.waitForSelector('.card-ovl'); await p.click('[data-action=card-close]'); }
  const sup2 = await findPage('.tray');
  const pinned2 = !!(await sup2.$('.tray-item.pinned'));
  await setKeep(sup2, pinned2 ? ['糧食', '纜索', '麥子'] : ['糧食', '纜索', '錨']);
  const cap2 = await findPage('[data-action=lock]');
  await cap2.waitForSelector('.status-line[data-lock-open="1"]', { timeout: 75000 });
  await cap2.click('[data-action=lock]');
  await pages[0].waitForSelector('.blackout');
  await doRepair('r2-');
  await pages[0].waitForSelector('.blackout', { state: 'detached', timeout: 15000 });
  for (const p of pages) { await p.waitForSelector('.card-ovl', { timeout: 5000 }); await p.click('[data-action=card-close]'); }
  await setKeep(sup2, ['糧食', '纜索']);
  await sleep(300);
  for (let i = 0; i < N; i++) await shot(pages[i], `r2-12-replan-p${i}`);
  const dep2 = await findPage('[data-action=depart]');
  await dep2.waitForSelector('.status-line.ok', { timeout: 30000 });
  await dep2.click('[data-action=depart]');
  await pages[0].waitForSelector('.result-hero', { timeout: 10000 });
  await pages[0].waitForSelector('.landing-ovl', { state: 'detached', timeout: 6000 });
  await shot(pages[0], 'r2-15-result');
  const title = await pages[0].textContent('.result-hero');
  if (!title.includes('平安上岸')) errs.push('第二局應該是兩星：' + title.trim().slice(0, 40));
  await browser.close();
  if (errs.length) {
    console.error('失敗：', errs);
    process.exit(1);
  }
  console.log(`通過：${N} 人、${W}px，兩局（三星、二星），無 JS 錯誤與橫向捲動。截圖在 ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
