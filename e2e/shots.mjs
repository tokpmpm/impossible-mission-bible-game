// PR 截圖用（不是測試）：開伺服器＋N 支模擬手機，直接操作伺服器裡的房間跳到指定畫面再截圖。
// 執行：node e2e/shots.mjs <情境> [輸出資料夾]；deviceScaleFactor 2、寬 390（10 人局 320）。
// 情境：safety（fix/safety 的畫面）。之後的分支可在 SCENES 加新的情境。
// 這是自動截圖，不是真人試玩。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { startServer } from '../src/server/main.ts';
import { CRISIS_AT } from '../src/engine/game.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODE_PATH ? process.env.NODE_PATH + '/playwright' : 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scene = process.argv[2] || 'safety';
const OUT = process.argv[3] || 'docs/screenshots/' + scene;
mkdirSync(OUT, { recursive: true });

const srv = await startServer({ port: 0, introMs: 60_000, sweepWarningMs: 10_000, boardingMs: scene === 'safety' ? 0 : 40_000 });
const BASE = `http://localhost:${srv.port}`;
const browser = await chromium.launch();

/** 開 n 支手機進同一個房間；回傳 { pages, room, nick→page }。 */
async function table(n, width = 390, prefs = {}) {
  const pages = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
    pages.push(await ctx.newPage());
  }
  const names = ['阿明', '小芳', '大衛', '美玲', '志豪', '佳慧', '建宏', '雅婷', '俊傑', '怡君'];
  await pages[0].goto(BASE);
  await pages[0].fill('#in-nick', names[0]);
  await pages[0].click('button[type=submit]');
  await pages[0].waitForSelector('.big-code');
  const code = (await pages[0].textContent('.big-code strong')).trim();
  for (let i = 1; i < n; i++) {
    await pages[i].goto(BASE + '/?room=' + code);
    await pages[i].fill('#in-nick', names[i]);
    await pages[i].click('button[type=submit]');
    await pages[i].waitForSelector('.big-code');
  }
  for (const [i, v] of Object.entries(prefs)) await pages[Number(i)].click(`[data-action=pref][data-value=${v}]`);
  const room = srv.rooms.get(code);
  const pageOf = (pid) => pages[room.players.findIndex((p) => p.id === pid)];
  const who = (role) => room.players.find((p) => room.round.roles.get(p.id).includes(role)).id;
  let k = 0;
  const act = (pid, a) => {
    const r = room.act(pid, 'shot' + k++, a);
    srv.hub.broadcast(room);
    return r;
  };
  /** 把局內時間跳到 ms（往前撥開局時間）。 */
  const jump = async (ms) => {
    const now = Date.now() - room.round.startedAt;
    if (ms > now) room.round.startedAt -= ms - now;
    room.tick();
    srv.hub.broadcast(room);
    await sleep(500);
  };
  const agree = async () => {
    const p = room.round.proposal;
    if (p) for (const v of p.voters) room.vote(v, p.id, 'yes');
    srv.hub.broadcast(room);
    await sleep(400);
  };
  const closeCards = async () => {
    for (const p of pages) {
      const c = await p.$('[data-action=card-close]');
      if (c) await c.click().catch(() => {});
    }
    await sleep(300);
  };
  return { pages, room, pageOf, who, act, jump, agree, closeCards };
}

async function shot(p, name, full = false) {
  await sleep(250);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('  ' + name);
}

const SCENES = {
  async 'onboarding-core'() {
    // 6 人局：上船角色卡（醫生沒有按鈕、船長有按鈕）、三格動畫、開局任務條＋離天亮、夜裡錨住船／出發前、角色卡浮窗
    const t = await table(6, 390);
    await t.pages[0].click('[data-action=start]');
    await sleep(1200);
    await shot(t.pageOf(t.who('medic')), '01-boarding-rolecard-medic');
    await shot(t.pageOf(t.who('nav')), '02-boarding-rolecard-captain');
    const setBoard = async (msLeftOfBoarding) => {
      t.room.round.startedAt = Date.now() + msLeftOfBoarding;
      srv.hub.broadcast(t.room);
      await sleep(900);
    };
    await setBoard(40_000 - 8_500);
    await shot(t.pageOf(t.who('medic')), '03-boarding-story-1');
    await setBoard(40_000 - 28_500);
    await shot(t.pageOf(t.who('medic')), '04-boarding-story-3');
    await t.pages[0].click('[data-action=sail]');
    await sleep(1000);
    await t.closeCards();
    await shot(t.pageOf(t.who('medic')), '05-intro-taskbar-medic', true);
    await shot(t.pageOf(t.who('supply')), '06-intro-taskbar-supply', true);
    const mp = t.pageOf(t.who('medic'));
    await mp.click('[data-action=role-card]');
    await sleep(500);
    await shot(mp, '07-rolecard-overlay');
    await mp.click('[data-action=role-card-close]');
    // 夜裡
    for (const item of ['麥子', '器具', '小船']) t.act(t.who('supply'), { type: 'setItem', item, on: false });
    await t.jump(CRISIS_AT);
    for (const s of t.room.round.game.repair.slots) t.act(t.who('eng'), { type: 'repairPick', option: s.answer });
    await sleep(600);
    await t.closeCards();
    await t.jump(t.room.elapsed() + 60_000);
    await t.closeCards();
    await shot(t.pageOf(t.who('comms')), '08-night-dawn-clock-comms', true);
  },
  async 'onboarding-3p'() {
    const t = await table(3, 390);
    await t.pages[0].click('[data-action=start]');
    await sleep(1200);
    for (let i = 0; i < 3; i++) await shot(t.pages[i], `01-boarding-3p-p${i}`);
  },
  async safety() {
    // 6 人局：首局走完 → 第二局超重只丟小船，看捲走預警；也拍第二局開局 30 秒、記號轉向、面板鎖
    const t = await table(6, 390);
    await t.pages[0].click('[data-action=start]');
    await sleep(800);
    await t.closeCards();
    // 首局：停電時記號持有者（轉向＋船頭↑）與木匠選錯後面板鎖
    for (const item of ['麥子', '器具', '小船']) t.act(t.who('supply'), { type: 'setItem', item, on: false });
    await t.jump(CRISIS_AT);
    const holderId = t.room.round.slotHolders.find((h, i) => t.room.round.slotRots[i] !== 0) ?? t.room.round.slotHolders[0];
    const hp = t.pageOf(holderId);
    const hold = await hp.$('[data-hold]');
    const box = await hold.boundingBox();
    await hp.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await hp.mouse.down();
    await shot(hp, '01-holder-rotated-bow');
    await hp.mouse.up();
    const eng = t.who('eng');
    const slot = t.room.round.game.repair.slots[0];
    t.act(eng, { type: 'repairPick', option: slot.options.find((o) => o !== slot.answer) });
    await sleep(300);
    await shot(t.pageOf(eng), '02-carpenter-panel-locked');
    // 補完、吃飯、出發
    await sleep(2600);
    for (const s of t.room.round.game.repair.slots.slice(t.room.round.game.repair.progress)) t.act(eng, { type: 'repairPick', option: s.answer });
    await sleep(400);
    await t.closeCards();
    t.act(t.who('comms'), { type: 'use', use: '吃飯' });
    await t.agree();
    await t.jump(t.room.elapsed() + 3000);
    t.act(t.who('nav'), { type: 'depart' });
    await t.agree();
    await sleep(6000);
    // 第二局：經典見聞、只丟小船（超重 5）
    t.room.forceCards = { a: 'A5', b: 'B4', tonight: { 食: '糧食', 繩: '纜索', 水: '深' } };
    await t.pages[0].click('[data-action=next]').catch(() => {});
    await sleep(800);
    if (t.room.round.no < 2) {
      t.room.next(t.room.hostId);
      srv.hub.broadcast(t.room);
      await sleep(800);
    }
    await t.closeCards();
    await t.jump(5000);
    const nav = t.who('nav');
    t.act(nav, { type: 'lock' });
    await sleep(400);
    await shot(t.pageOf(nav), '03-round2-intro-30s', true);
    t.act(t.who('supply'), { type: 'setItem', item: '小船', on: false });
    await t.jump(CRISIS_AT - 8000);
    await shot(t.pageOf(t.who('supply')), '04-sweep-warning-overweight', true);
    // 協助模式放大的描述
    await t.jump(CRISIS_AT + 62_000);
    await t.jump(t.room.round.game.repair.assistAt + 1000);
    await shot(t.pageOf(t.who('eng')), '05-assist-desc-bold');
  },
};

try {
  await SCENES[scene]();
} finally {
  await browser.close();
  await srv.close();
}
