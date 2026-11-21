const { chromium } = require('playwright');
// 瀏覽器端對端：N 支模擬手機玩完兩局保羅海難。由 e2e/run.mjs 啟動（會先開伺服器）。
// 檢查：按鈕只出現在負責的人手機上、丟東西、決定好了、黑暗補船、用掉一件、衝向海灘、三星、下一局換卡、無 JS 錯誤與橫向捲動。
// 2026-11-20（DECISIONS 18）：決定好了／用掉／衝向海灘要其他人在對話框按同意；第一局先有人按「等一下」讓表決沒通過一次。
// 第一局：經典配置（不捲走）。第二局：照各手機上的「見聞」決定帶什麼，風暴前丟的會被捲走（捲走前 10 秒提醒）。
const OUT = (process.env.SHOTS || require('os').tmpdir() + '/im-shots') + '/' + (process.env.TAG || '');
require('fs').mkdirSync(require('path').dirname(OUT + 'x'), { recursive: true });
const BASE = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3100);
const N = Number(process.env.N || 3);
const W = Number(process.env.W || 390);
// 閃爍量測：#body 被整批換掉幾次、進場動畫（同一內容）重播幾次。結果印在最後一行。
const FLICKER_PROBE = () => {
  const st = (window.__flicker = { bodyReplace: 0, anim: 0, repeat: 0, seen: {} });
  document.addEventListener('animationstart', (e) => {
    const path = [];
    for (let n = e.target; n && n.nodeType === 1 && n.id !== 'body' && n.id !== 'hud' && n.id !== 'ovl'; n = n.parentNode) path.push(n.nodeName + ':' + Array.prototype.indexOf.call(n.parentNode.children, n));
    const key = e.animationName + '|' + (e.target.closest && e.target.closest('#hud') ? 'hud' : e.target.closest('#ovl') ? 'ovl' : 'body') + '|' + path.join('/');
    st.anim++;
    st.names = st.names || {};
    st.names[e.animationName] = (st.names[e.animationName] || 0) + 1;
    if (st.seen[key]) st.repeat++;
    st.seen[key] = (st.seen[key] || 0) + 1;
  }, true);
  new MutationObserver((ms) => {
    for (const m of ms) if (m.target.id === 'body' && m.addedNodes.length) st.bodyReplace++;
  }).observe(document, { childList: true, subtree: true });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const proxy = process.env.BASE_URL && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch(proxy ? { proxy } : {});
  const pages = [];
  const errs = [];
  for (let i = 0; i < N; i++) {
    const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: Number(process.env.DSF || 1), ignoreHTTPSErrors: !!proxy });
    const p = await ctx.newPage();
    await p.addInitScript(FLICKER_PROBE);
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
  const countPages = async (sel) => { let n = 0; for (const p of pages) if (await p.$(sel)) n++; return n; };
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
  // 表決：其他人都在對話框按「同意」（提案的人手機上不會有同意鍵）
  const agreeAll = async (proposer, shotName) => {
    for (const p of pages) if (p !== proposer) await p.waitForSelector('.vote-card.ask [data-choice=yes]', { timeout: 5000 });
    if (await proposer.$('.vote-card.ask')) errs.push('提案的人手機上出現同意鍵');
    if (shotName) {
      await shot(pages.find((p) => p !== proposer), shotName + '-ask');
      await shot(proposer, shotName + '-wait');
    }
    for (const p of pages) {
      if (p === proposer) continue;
      for (let t = 0; t < 4; t++) {
        try {
          await p.click('.vote-card.ask [data-choice=yes]', { timeout: 1500 });
          break;
        } catch {
          if (!(await p.$('.vote-card.ask'))) break;
        }
      }
    }
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

  // ── 團隊分數與排行榜檢查 ──
  const TEAM = `測試隊${N}${Date.now() % 1000}`;
  /** 每一支手機都看得到同一個總分（0–1000）與四項；只有房主有「登記上榜」。回傳總分。 */
  const checkScore = async (label) => {
    const totals = [];
    for (const p of pages) {
      await p.waitForSelector('[data-score-total]', { timeout: 8000 });
      // 動畫跑完（約 4.5 秒）數字才會停在最終分數
      await p.waitForFunction(() => { const e = document.querySelector('[data-score-total]'); return e && e.textContent.trim() === e.getAttribute('data-score-total'); }, null, { timeout: 15000 });
      totals.push(Number(await p.getAttribute('[data-score-total]', 'data-score-total')));
      if ((await p.$$('.sc-row')).length !== 4) errs.push(`${label}：分數不是四項`);
      if (await p.$('.sc-row.pending')) errs.push(`${label}：動畫結束後還有項目沒出現`);
    }
    if (new Set(totals).size !== 1) errs.push(`${label}：各手機總分不一致 ${JSON.stringify(totals)}`);
    if (!(totals[0] >= 0 && totals[0] <= 1000)) errs.push(`${label}：總分超出 0–1000：${totals[0]}`);
    for (let i = 1; i < N; i++) if (await pages[i].$('[data-action=sub-open]')) errs.push(`${label}：非房主看到登記按鈕`);
    if (!(await pages[0].$('[data-action=sub-open]'))) errs.push(`${label}：房主沒有登記按鈕`);
    // 重新連線（整頁重載）不重播動畫
    // （不重載房主：房主斷線會換人當房主）
    const last = pages[N - 1];
    await last.reload();
    await last.waitForSelector('[data-score-total]', { timeout: 8000 });
    await sleep(300);
    if (await last.$('.sc-row.pending')) errs.push(`${label}：重新連線後動畫又重播`);
    return totals[0];
  };
  const submitTeam = async (label) => {
    await pages[0].click('[data-action=sub-open]');
    await pages[0].fill('#in-team', TEAM);
    const left = (await pages[0].textContent('[data-sub-left]')).trim();
    if (left !== String(12 - [...TEAM].length)) errs.push(`${label}：剩餘字數顯示 ${left}`);
    await shot(pages[0], `${label}-submit-form`);
    await pages[0].click('form[data-form=submit] button[type=submit]');
    await pages[0].waitForSelector('[data-submitted]', { timeout: 5000 });
    const t = await pages[0].textContent('[data-submitted]');
    if (!t.includes(TEAM) || !/第 \d+ 名/.test(t)) errs.push(`${label}：登記結果沒有隊名與名次：${t.trim()}`);
    for (let i = 1; i < N; i++) {
      await pages[i].waitForSelector('[data-submitted]', { timeout: 5000 });
      if (!(await pages[i].textContent('[data-submitted]')).includes(TEAM)) errs.push(`${label}：隊員沒看到已登記`);
    }
    await shot(pages[0], `${label}-submitted`);
    return t;
  };
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
  // 表決：有一個人按「等一下」→ 沒通過（所有手機看到結果、不點名）；再提一次，大家同意
  await cap.click('[data-action=lock]');
  const objector = pages.find((p) => p !== cap);
  await objector.waitForSelector('.vote-card.ask [data-choice=wait]', { timeout: 5000 });
  await shot(objector, '07b-vote-ask');
  await shot(cap, '07c-vote-wait');
  await objector.click('.vote-card.ask [data-choice=wait]');
  for (const p of pages) await p.waitForSelector('.banner.vote-res.no', { timeout: 5000 });
  await shot(cap, '07d-vote-rejected');
  const objName = await objector.evaluate(() => document.querySelector('.tb-nick')?.textContent || '');
  if (objName && (await cap.textContent('.banner.vote-res.no')).includes(objName)) errs.push('表決結果點名了不同意的人');
  await cap.click('[data-action=lock]');
  await agreeAll(cap);
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
  await agreeAll(cook, '12b-vote-meal');
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
  await agreeAll(capPage);
  await pages[0].waitForSelector('.landing-ovl', { timeout: 3000 });
  await sleep(2200);
  await shot(pages[0], '15a-landing');
  await pages[0].waitForSelector('.result-hero', { timeout: 8000 });
  await pages[0].waitForSelector('.landing-ovl', { state: 'detached', timeout: 6000 });
  const result = await pages[0].textContent('.result');
  if (!result.includes('全船平安上岸・一路準備周全')) errs.push('第一局沒有三星：' + result.trim().slice(0, 60));
  if (!result.includes('276 人，全都得救上了岸')) errs.push('結尾沒有寫 276 人都上了岸');
  if (!result.includes('外衣')) errs.push('結尾沒有點名背包裡的外衣');
  if (!/27:\d+/.test(result) || !result.includes('你知道嗎')) errs.push('結尾缺經文或小知識');
  const score1 = await checkScore('第一局分數');
  await submitTeam('第一局登記');
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
  if (!tonight['食'] || !tonight['水'] || tonight['胃']) errs.push('第二局見聞不對（應有食、水，沒有胃）：' + JSON.stringify(tonight));
  if ((await countPages('.banner.sweep.rule')) !== N) errs.push('第二局沒有提醒「風暴一來撈不回來」');
  const sup2 = await findPage('.tray');
  const pinned2 = !!(await sup2.$('.tray-item.pinned'));
  const rope = tonight['繩'] || null; // A4：船底已捆好，不發「繩」
  const keep2 = [tonight['食'], rope, '錨', pinned2 ? '麥子' : null].filter(Boolean);
  await setKeep(sup2, keep2);
  const cap2 = await findPage('[data-action=lock]');
  await cap2.waitForSelector('.status-line[data-lock-open="1"]', { timeout: 75000 });
  await cap2.click('[data-action=lock]');
  await agreeAll(cap2);
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
  // 力氣只能靠吃飯（DECISIONS 18）：天亮前那一件一定是吃飯，其餘留在船上
  let plan = null;
  const cookPage = await findPage('[data-action=use][data-use="吃飯"]');
  const rest = todo.filter((x) => x !== '力氣');
  if (cookPage && todo.includes('力氣') && wsum(rest) <= 5) plan = { use: '吃飯', land: rest, page: cookPage };
  void useOf;
  if (!plan) errs.push(`第二局找不到三星做法：${JSON.stringify({ tonight, provides, weights, bCard, cardDone })}`);
  else {
    if (plan.use) {
      await plan.page.click(`[data-action=use][data-use="${plan.use}"]`);
      await agreeAll(plan.page);
      for (const p of pages) await p.waitForSelector('.banner.fed', { timeout: 5000 });
      await shot(plan.page, 'r2-13-used');
      if ((await countPages('[data-action=use]')) !== 0) errs.push('用掉一件後還有其他用掉按鈕');
      await sleep(3000);
    }
    await setKeep(sup2, plan.land.map((n) => provides[n]));
    await sleep(400);
    for (let i = 0; i < N; i++) await shot(pages[i], `r2-14-replan-p${i}`);
    const dep2 = await findPage('[data-action=depart]');
    await dep2.waitForSelector('.status-line.ok', { timeout: 30000 });
    await dep2.click('[data-action=depart]');
    await agreeAll(dep2);
    await pages[0].waitForSelector('.result-hero', { timeout: 10000 });
    await pages[0].waitForSelector('.landing-ovl', { state: 'detached', timeout: 6000 });
    await shot(pages[0], 'r2-15-result');
    const res2 = await pages[0].textContent('.result');
    if (!res2.includes('全船平安上岸・一路準備周全')) errs.push('第二局照見聞做應該三星：' + res2.trim().slice(0, 60));
    if (!res2.includes('被浪捲走')) errs.push('第二局結尾沒有提到被浪捲走');
    if (!/今晚力氣靠/.test(res2)) errs.push('結尾沒有「今晚靠的是……」');
    const score2 = await checkScore('第二局分數');
    // 第二局：房主用同一個隊名再登記，榜上同一隊只留一筆、取較高分
    await pages[0].click('[data-action=sub-open]');
    await pages[0].fill('#in-team', TEAM);
    await pages[0].click('form[data-form=submit] button[type=submit]');
    await pages[0].waitForSelector('[data-submitted]', { timeout: 5000 });
    const t2 = await pages[0].textContent('[data-submitted]');
    if (score2 < score1 && !t2.includes('最好成績仍是 ' + score1)) errs.push('第二局分數較低，畫面沒說「最好成績仍是 ' + score1 + '」：' + t2.trim());
    await shot(pages[0], 'r2-16-submitted');
    const lb = await pages[0].evaluate(() => fetch('/api/leaderboard').then((r) => r.json()));
    const mine = lb.entries.filter((e) => e.name === TEAM);
    if (mine.length !== 1) errs.push(`排行榜同一隊名出現 ${mine.length} 次`);
    else if (mine[0].score !== Math.max(score1, score2)) errs.push(`排行榜分數 ${mine[0].score}，應為 ${Math.max(score1, score2)}`);
    if (!lb.trial) errs.push('排行榜沒有標試行');
    // 首頁排行榜面板（全新的瀏覽器分頁、沒有房間）
    const ctx2 = await browser.newContext({ viewport: { width: W, height: 844 }, ignoreHTTPSErrors: !!proxy });
    const hp = await ctx2.newPage();
    hp.on('pageerror', (e) => errs.push(`board: ${e.message}`));
    await hp.goto(BASE);
    await hp.click('[data-action=board-open]');
    await hp.waitForSelector('[data-leaderboard]', { timeout: 5000 });
    if (!(await hp.textContent('[data-leaderboard]')).includes(TEAM)) errs.push('首頁排行榜沒有這一隊');
    await shot(hp, 'r2-17-board');
    await hp.click('[data-action=board-close]');
    await hp.waitForSelector('[data-action=board-open]');
    await ctx2.close();
    console.log(`分數：第一局 ${score1}、第二局 ${score2}，排行榜 ${TEAM} = ${mine[0] && mine[0].score}`);
    console.log(`第二局：${JSON.stringify(tonight)} 卡 ${bCard} → ${plan.use || '不用掉'}，帶 ${plan.land.map((n) => provides[n]).join('、')} 上岸`);
  }
  // 練習房：伺服器第一個檢查就是 practice，submitScore 一定被拒
  await new Promise((resolve) => {
    const WS = require('ws');
    const ws = new WS(BASE.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => { errs.push('練習房檢查逾時'); ws.close(); resolve(); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create', nickname: '練習', practice: true })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'submitScore', name: '練習隊' }));
      else if (m.t === 'error' || m.t === 'submitted') {
        if (m.t !== 'error' || !String(m.msg).includes('練習模式不計入排行榜')) errs.push('練習房登記沒被拒絕：' + JSON.stringify(m));
        clearTimeout(timer); ws.close(); resolve();
      }
    });
    ws.on('error', (e) => { errs.push('練習房 ws：' + e.message); clearTimeout(timer); resolve(); });
  });
  const fl = { bodyReplace: 0, anim: 0, repeat: 0 };
  for (const p of pages) { const f = await p.evaluate(() => window.__flicker).catch(() => null); if (f) for (const k of Object.keys(fl)) fl[k] += f[k]; }
  if (process.env.FLICKER_DETAIL) { const names = {}; for (const p of pages) { const f = await p.evaluate(() => window.__flicker.names).catch(() => null); for (const [k, v] of Object.entries(f || {})) names[k] = (names[k] || 0) + v; } console.log('動畫分布', JSON.stringify(names)); }
  console.log(`閃爍量測（${N} 支手機合計）：body 整批替換 ${fl.bodyReplace} 次、進場動畫 ${fl.anim} 次、其中重複播放 ${fl.repeat} 次`);
  await browser.close();
  if (errs.length) {
    console.error('失敗：', errs);
    process.exit(1);
  }
  console.log(`通過：${N} 人、${W}px，兩局（首局經典配置三星；第二局見聞＋風暴捲走三星），無 JS 錯誤與橫向捲動。截圖在 ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
