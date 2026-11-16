const { chromium } = require('playwright');
// 瀏覽器端對端：N 支模擬手機玩完兩局保羅海難。由 e2e/run.mjs 啟動（會先開伺服器）。
// 檢查：按鈕只出現在負責的人手機上、丟東西、決定好了、黑暗補船、用掉一件、衝向海灘、三星、下一局換卡、無 JS 錯誤與橫向捲動。
// 第一局：經典配置（不捲走）。第二局：照各手機上的「見聞」決定帶什麼，風暴前丟的會被捲走（捲走前 10 秒提醒）。
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
  // 首局經典配置：水深不能拋錨；吃飯按鈕只在伙房手機上
  if ((await countPages('[data-action=use][data-use="吃飯"]')) !== 1) errs.push('吃飯按鈕不只出現在伙房手機');
  if ((await countPages('[data-action=use][data-use="拋錨"]')) !== 0) errs.push('首局水深卻出現拋錨按鈕');
  if ((await countPages('.banner.sweep')) !== 0) errs.push('首局不該有風暴捲走');
  const cook = await findPage('[data-action=use][data-use="吃飯"]');
  await cook.click('[data-action=use][data-use="吃飯"]');
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
  // ── 第二局：新的故事卡與見聞、職能輪替；風暴捲走 ──
  await host.waitForSelector('.card-ovl');
  await shot(host, 'r2-03-card-a');
  for (const p of pages) { await p.waitForSelector('.card-ovl'); await p.click('[data-action=card-close]'); }
  await sleep(300);
  // 大家把見聞說出來（這裡由程式讀每支手機上的見聞卡）
  const tonight = {};
  for (const p of pages) for (const el of await p.$$('.tn-card')) tonight[await el.getAttribute('data-dial')] = await el.getAttribute('data-value');
  for (let i = 0; i < N; i++) await shot(pages[i], `r2-04-tonight-p${i}`);
  if (!tonight['食'] || !tonight['水'] || !tonight['胃']) errs.push('第二局見聞不齊：' + JSON.stringify(tonight));
  if ((await countPages('.banner.sweep.rule')) !== N) errs.push('第二局沒有提醒「風暴一來撈不回來」');
  const sup2 = await findPage('.tray');
  const pinned2 = !!(await sup2.$('.tray-item.pinned'));
  const rope = tonight['繩'] || null; // A4：船底已捆好，不發「繩」
  const keep2 = [tonight['食'], rope, '錨', pinned2 ? '麥子' : null].filter(Boolean);
  await setKeep(sup2, keep2);
  const cap2 = await findPage('[data-action=lock]');
  await cap2.waitForSelector('.status-line[data-lock-open="1"]', { timeout: 75000 });
  await cap2.click('[data-action=lock]');
  // 捲走前 10 秒提醒：每支手機都看得到
  for (const p of pages) await p.waitForSelector('.banner.sweep.warn', { timeout: 5000 });
  for (let i = 0; i < N; i++) await shot(pages[i], `r2-07-sweep-warning-p${i}`);
  await pages[0].waitForSelector('.blackout', { timeout: 15000 });
  await doRepair('r2-');
  await pages[0].waitForSelector('.blackout', { state: 'detached', timeout: 15000 });
  for (const p of pages) { await p.waitForSelector('.card-ovl', { timeout: 5000 }); await p.click('[data-action=card-close]'); }
  await sleep(300);
  const swept = await pages[0].$('.banner.sweep');
  const sweptText = swept ? await swept.textContent() : '';
  if (!/捲走/.test(sweptText)) errs.push('第二局沒有東西被捲走：' + sweptText);
  // 被捲走的不在托盤上（撈不回來）
  for (const id of ['糧食', '纜索', '錨', '麥子', '器具', '小船'].filter((x) => !keep2.includes(x))) {
    if (await sup2.$(`.tray-item[data-item="${id}"]`)) errs.push(`被捲走的${id}還在托盤上`);
  }
  // 補好船後今晚靠哪一樣公開了；決定用掉哪一件（只來得及一件）
  const weights = {};
  for (const el of await sup2.$$('.tray-item')) weights[await el.getAttribute('data-item')] = (await el.$$('.ti-w i')).length;
  const provides = {};
  const litNow = {};
  for (const el of await pages[0].$$('.need')) {
    const via = await el.$('.need-via');
    const id = await el.getAttribute('data-need');
    provides[id] = via ? (await via.getAttribute('title')).replace('今晚靠', '') : null;
    litNow[id] = /\b(lit|pending)\b/.test(await el.getAttribute('class'));
  }
  const bCard = await pages[0].getAttribute('.card-chip:nth-child(2)', 'data-card');
  // 卡片已顧好的事：東西不在船上了卻亮著（A4 船身、B5 天亮）
  const cardDone = Object.keys(provides).filter((n) => weights[provides[n]] === undefined && litNow[n]);
  const todo = Object.keys(provides).filter((n) => !cardDone.includes(n));
  const useOf = { 力氣: '吃飯', 船身: '捆船底', 天亮: '拋錨' };
  const wsum = (ns) => ns.reduce((t, n) => t + (weights[provides[n]] ?? 99), 0);
  let plan = null;
  if (bCard !== 'B5' && wsum(todo) <= 5) plan = { use: null, land: todo };
  for (const n of todo) {
    if (plan) break;
    const u = useOf[n];
    const btnPage = await findPage(`[data-action=use][data-use="${u}"]`);
    if (!btnPage) continue;
    const rest = todo.filter((x) => x !== n);
    if (wsum(rest) <= 5) plan = { use: u, land: rest, page: btnPage };
  }
  if (!plan) errs.push(`第二局找不到三星做法：${JSON.stringify({ tonight, provides, weights, bCard, cardDone })}`);
  else {
    if (plan.use) {
      await plan.page.click(`[data-action=use][data-use="${plan.use}"]`);
      await plan.page.waitForSelector('[data-action=undo-use]', { timeout: 3000 });
      await shot(plan.page, 'r2-13-used-undo');
      for (const p of pages) await p.waitForSelector('.banner.fed', { timeout: 3000 });
      if ((await countPages('[data-action=use]')) !== 0) errs.push('用掉一件後還有其他用掉按鈕');
      await sleep(3000);
    }
    await setKeep(sup2, plan.land.map((n) => provides[n]));
    await sleep(400);
    for (let i = 0; i < N; i++) await shot(pages[i], `r2-14-replan-p${i}`);
    const dep2 = await findPage('[data-action=depart]');
    await dep2.waitForSelector('.status-line.ok', { timeout: 30000 });
    await dep2.click('[data-action=depart]');
    await pages[0].waitForSelector('.result-hero', { timeout: 10000 });
    await pages[0].waitForSelector('.landing-ovl', { state: 'detached', timeout: 6000 });
    await shot(pages[0], 'r2-15-result');
    const res2 = await pages[0].textContent('.result');
    if (!res2.includes('上岸很順利')) errs.push('第二局照見聞做應該三星：' + res2.trim().slice(0, 60));
    if (!res2.includes('被浪捲走')) errs.push('第二局結尾沒有提到被浪捲走');
    if (!/今晚力氣靠/.test(res2)) errs.push('結尾沒有「今晚靠的是……」');
    console.log(`第二局：${JSON.stringify(tonight)} 卡 ${bCard} → ${plan.use || '不用掉'}，帶 ${plan.land.map((n) => provides[n]).join('、')} 上岸`);
  }
  await browser.close();
  if (errs.length) {
    console.error('失敗：', errs);
    process.exit(1);
  }
  console.log(`通過：${N} 人、${W}px，兩局（首局經典配置三星；第二局見聞＋風暴捲走三星），無 JS 錯誤與橫向捲動。截圖在 ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
