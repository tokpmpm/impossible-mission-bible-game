// 《不可能的任務》第一關「保羅海難」（使徒行傳 27 章）手機前端。
// 原則（2026-11-15 使用者決定）：只照伺服器送來的 view（src/server/view.ts）畫圖、不自己算規則；
// 不是自己能操作的按鈕不畫；能用圖就不用字。
import { createConnection, loadSession, clearSession } from './net.js';
import { symbolSvg, describeSymbol } from './symbols.js';
import * as art from './art.js';

// 背包題：上船前多帶一樣什麼（公開、可跳過）。油燈黑暗中能照亮面板一次；其他會在結尾出場。
const PREFS = [
  { value: 'lamp', label: '油燈', note: '黑暗中能照亮面板一次' },
  { value: 'coat', label: '外衣', note: '' },
  { value: 'nuts', label: '乾果', note: '' },
  { value: 'song', label: '一首歌', note: '' },
];
const PREF_OF = Object.fromEntries(PREFS.map((p) => [p.value, p]));
const NEED_LABEL = { 力氣: '力氣', 船身: '船身', 天亮: '等天亮' };

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
const params = new URLSearchParams(location.search);
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 三層：hud（頂列＋船的場景，只在內容變了才重畫，動畫才不會一直重來）、body（每次重畫）、ovl（卡片／吃飯／上岸動畫）
root.innerHTML = '<div id="hud"></div><div id="body"></div><div id="ovl"></div>';
const hudEl = document.getElementById('hud');
const bodyEl = document.getElementById('body');
const ovlEl = document.getElementById('ovl');
let lastHud = '';
let lastOvl = '';

const ui = {
  view: null,
  status: 'connecting',
  offset: 0,
  hadSession: !!loadSession(),
  left: false,
  busy: false,
  homeMode: params.get('room') ? 'join' : 'create',
  nick: (params.get('nick') || '').slice(0, 12),
  code: (params.get('room') || '').toUpperCase().slice(0, 8),
  zoom: false,
  holding: null,
  seenWrong: null,
  wrongUntil: 0,
  leaveConfirm: false,
  prefSkipped: false,
  noFlicker: readFlag('im.noFlicker'),
  note: null, // 底部按鈕上方的非模態提示
  flash: null,
  /** 已看過的故事卡（局數:卡號），看過就不再自動跳出。 */
  seenCards: new Set(),
  cardOpen: null, // 正在看的卡號
  cardOpenAt: 0,
  /** 船上的東西上一次的狀態，用來播「丟進海裡／撈回來」動畫。 */
  prevOnShip: null,
  justThrown: [],
  justRescued: [],
  mealAt: 0, // 吃飯動畫開始時間
  seenFed: null,
  revealAt: 0, // 上岸動畫開始時間
};

const ACTION_LABEL = { lock: '決定好了', depart: '衝向海灘', eat: '召集大家吃飯', setItem: '丟東西' };
const FLASH_BLOCK = { OVERWEIGHT: 'load', PINNED: 'items', NO_FOOD: 'items' };
const MEAL_MS = 2800;
const REVEAL_MS = 4400;
const CARD_AUTO_CLOSE_MS = 20000;

function readFlag(k) {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
}
function writeFlag(k, on) {
  try {
    localStorage.setItem(k, on ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}

const now = () => Date.now() + ui.offset;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function showNote(kind, title, lines, ms = 9000) {
  ui.note = { kind, title, lines, until: Date.now() + ms };
  render();
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3800);
}

// ───────── 連線 ─────────

let autoSent = false;

const conn = createConnection({
  onStatus(s) {
    ui.status = s;
    renderStatus();
    // ?auto=1（單機試玩）：沒有 session 時自動用 nick 建立或加入房間
    if (s === 'open' && params.get('auto') && !autoSent && !loadSession() && ui.nick) {
      autoSent = true;
      if (ui.code) conn.send({ t: 'join', code: ui.code, nickname: ui.nick });
      else conn.send({ t: 'create', nickname: ui.nick });
    }
  },
  onWelcome() {
    ui.left = false;
    ui.busy = false;
    ui.hadSession = true;
  },
  onState(view) {
    if (ui.left) return;
    ui.busy = false;
    ui.offset = view.serverNow - Date.now();
    track(view);
    const prevPhase = ui.view && ui.view.phase;
    ui.view = view;
    if (prevPhase !== view.phase) onPhaseChange(prevPhase, view.phase);
    render();
  },
  onRejected(r) {
    const title = ACTION_LABEL[r.action] ? `還不能${ACTION_LABEL[r.action]}` : '這一步沒有成功';
    const blocks = new Set(['status']);
    for (const x of r.reasons) if (FLASH_BLOCK[x.code]) blocks.add(FLASH_BLOCK[x.code]);
    ui.flash = { blocks, until: Date.now() + 1400 };
    showNote('rejected', title, r.reasons.map((x) => x.text), 10000);
  },
  onError(msg, ctx) {
    ui.busy = false;
    if (ctx.duringResume && !ui.view) {
      clearSession();
      ui.hadSession = false;
      toast('原本的房間已經結束了，請重新建立或加入。');
      render();
      return;
    }
    toast(msg);
    render();
  },
});

/** 比對前後兩份 view：哪些東西剛被丟／撈回、剛吃飯、剛選錯。 */
function track(v) {
  const wf = v.repair ? v.repair.wrongFlash : null;
  if (wf != null) {
    if (ui.seenWrong != null && wf > ui.seenWrong) ui.wrongUntil = Date.now() + 3500;
    ui.seenWrong = wf;
  } else ui.seenWrong = null;

  const ship = v.ship;
  if (ship) {
    const on = ship.items.filter((i) => i.onShip).map((i) => i.id);
    if (ui.prevOnShip) {
      const thrown = ui.prevOnShip.filter((id) => !on.includes(id) && !ship.items.find((i) => i.id === id).gone);
      const rescued = on.filter((id) => !ui.prevOnShip.includes(id));
      if (thrown.length || rescued.length) {
        ui.justThrown = thrown;
        ui.justRescued = rescued;
      }
    }
    ui.prevOnShip = on;
    if (ship.fed && ui.seenFed === false && ship.fedAt && now() - ship.fedAt < 8000) ui.mealAt = Date.now();
    ui.seenFed = ship.fed;
  } else {
    ui.prevOnShip = null;
    ui.seenFed = null;
  }
}

function onPhaseChange(prev, next) {
  ui.holding = null;
  ui.leaveConfirm = false;
  ui.note = null;
  ui.justThrown = [];
  ui.justRescued = [];
  if (next === 'blackout') ui.zoom = false;
  // 衝向海灘：先播上岸動畫，再看結算（結果早已由伺服器決定）
  if (next === 'settled' && prev === 'replanning') ui.revealAt = Date.now();
  if (prev && next !== prev) window.scrollTo(0, 0);
}

// ───────── 共用元件 ─────────

function slotBase(v) {
  const r = v.repair;
  if (!r) return 1;
  const all = [...r.order.map((o) => o.slot), ...r.mySymbols.map((s) => s.slot)];
  if (r.panel) all.push(...r.panel.slots.map((s) => s.index));
  return all.some((n) => n === 0) ? 1 : 0;
}

function nickOf(v, idOrName) {
  const p = v.players.find((x) => x.id === idOrName);
  return p ? p.nickname : idOrName;
}

function roleBadge(v) {
  return v.me.roles
    .map((r) => `<span class="role-chip">${art.role(r.id, 22)}<span>${esc(r.name)}</span></span>`)
    .join('');
}

function renderTopbar(v) {
  const leave = ui.leaveConfirm
    ? `<div class="leave-confirm"><span>確定離開？</span>
        <button class="btn small ghost" data-action="leave-cancel">留下</button>
        <button class="btn small danger" data-action="leave-yes">離開</button></div>`
    : `<button class="btn small ghost" data-action="leave" aria-label="離開房間">離開</button>`;
  const live = v.round && ['intro', 'planning', 'replanning'].includes(v.phase);
  const cd = live
    ? `<div class="tb-cd" role="timer" aria-label="剩下時間"><span aria-hidden="true">⏳</span><strong data-cd="round">${mmss(v.round.startedAt + v.round.timeLimitMs - now())}</strong></div>`
    : '';
  return `<header class="topbar ${live ? 'live' : ''}">
    <div class="tb-room"><span class="tb-label">房號</span><strong>${esc(v.code)}</strong></div>
    <div class="tb-me"><span class="tb-nick">${esc(v.me.nickname)}</span>${roleBadge(v)}</div>
    ${cd}${leave}
  </header>`;
}

/** 線索：一張小卡＝圖（東西 → 顧哪件事）＋一句話。 */
function clueCards(v) {
  if (!v.clues.length) return '';
  return v.clues
    .map((c) => {
      const pic = c.item || c.need
        ? `<div class="clue-pic" aria-hidden="true">${c.item ? art.item(c.item, 34) : ''}${c.item && c.need ? '<span class="arrow">→</span>' : ''}${c.need ? art.need(c.need, true, 34) : ''}</div>`
        : '';
      return `<article class="clue ${c.breakthrough ? 'clue-bt' : ''}">
        ${pic}
        <div class="clue-body"><div class="clue-head"><span class="clue-title">${esc(c.title)}</span><span class="tag">${esc(c.role)}</span></div>
        <p>${esc(c.text)}</p></div></article>`;
    })
    .join('');
}

function storyLine(v) {
  if (!v.story) return '';
  return `<p class="story"><span>${esc(v.story.text)}</span><cite>${esc(v.story.ref)}</cite></p>`;
}

function lockOpen(v) {
  return !!v.round && v.phase !== 'intro';
}

/** 底部固定列：提示（被擋下）＋狀態＋主按鈕。只有船長看得到按鈕。 */
function actionBar(v, button) {
  const n = ui.note && Date.now() < ui.note.until ? ui.note : null;
  const note = n
    ? `<div class="bar-note ${n.kind}" role="alert">
        <div class="bar-note-head"><strong>${esc(n.title)}</strong><button class="note-x" data-action="note-close" aria-label="關閉提示">✕</button></div>
        ${n.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
      </div>`
    : '';
  if (!note && !button) return '';
  return `<div class="action-bar stack">${note}${button ? statusLine(v) : ''}${button}</div>`;
}

function statusLine(v) {
  const s = v.ship;
  if (!s) return '';
  const planning = v.phase === 'planning' || v.phase === 'intro';
  const open = lockOpen(v);
  const ok = s.reasons.length === 0 && (!planning || open);
  let sub = '';
  if (planning && !open && v.round) {
    sub = `<div class="status-sub">認識隊友中：<strong data-cd="lock">${mmss(v.round.lockOpensAt - now())}</strong> 後才能決定</div>`;
  } else if (!ok && s.advice.length) {
    sub = `<div class="status-sub advice">${esc(s.advice[0])}</div>`;
  } else if (ok) {
    sub = `<div class="status-sub ok">${planning ? '可以決定了 ✓' : '可以衝向海灘了 ✓'}</div>`;
  }
  return `<div class="status-line ${s.overweight > 0 ? 'bad' : ''} ${ok ? 'ok' : ''}" data-block="status" data-lock-open="${open ? '1' : '0'}" aria-live="polite">${sub}</div>`;
}

// ───────── 首頁 ─────────

function renderHome() {
  const waiting = ui.hadSession && !ui.view && !ui.left;
  if (waiting) {
    return `<main class="screen center">
      <div class="logo">不可能的任務</div>
      <p class="muted">正在回到你的房間…</p>
      <button class="btn ghost" data-action="forget">改成重新加入</button>
    </main>`;
  }
  const isJoin = ui.homeMode === 'join';
  return `<main class="screen home">
    <div class="hero">
      <div class="hero-art">${art.scene({ sky: 'storm', onDeck: ['糧食', '纜索', '錨', '麥子', '器具', '小船'], afloat: [], load: { weight: 6, cap: 6 }, rock: 'storm' })}</div>
      <div class="hero-badge">第一關・使徒行傳 27 章</div>
      <h1 class="logo">不可能的任務</h1>
      <p class="hero-sub">保羅海難：每人一支手機，一起讓全船平安上岸</p>
    </div>
    <div class="seg" role="tablist">
      <button role="tab" aria-selected="${!isJoin}" class="seg-btn ${!isJoin ? 'on' : ''}" data-action="home-mode" data-mode="create">建立房間</button>
      <button role="tab" aria-selected="${isJoin}" class="seg-btn ${isJoin ? 'on' : ''}" data-action="home-mode" data-mode="join">加入房間</button>
    </div>
    <form class="card form" data-form="${isJoin ? 'join' : 'create'}">
      ${
        isJoin
          ? `<label class="field"><span>房號</span>
        <input id="in-code" data-model="code" value="${esc(ui.code)}" inputmode="text" autocomplete="off" autocapitalize="characters" maxlength="8" placeholder="例如 ABCD" required></label>`
          : ''
      }
      <label class="field"><span>你的暱稱</span>
        <input id="in-nick" data-model="nick" value="${esc(ui.nick)}" maxlength="12" autocomplete="nickname" placeholder="隊友會這樣叫你" required></label>
      <button class="btn primary block" type="submit" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '連線中…' : isJoin ? '加入房間' : '建立房間'}</button>
      <p class="muted small">入房不計時；人到齊、房主按開始後才開始 8 分鐘。</p>
    </form>
    <p class="muted small" style="text-align:center">手機不夠？<a href="/solo.html" style="color:inherit">用一台電腦同時扮演 3–10 位玩家</a></p>
  </main>`;
}

// ───────── 大廳 ─────────

function renderLobby(v) {
  const prefBtns = [...PREFS, { value: null, label: '跳過' }]
    .map((p) => {
      const on = p.value === null ? v.me.pref === null && ui.prefSkipped : v.me.pref === p.value;
      return `<button class="chip pref-chip ${on ? 'on' : ''}" aria-pressed="${on}" data-action="pref" data-value="${p.value ?? ''}">${
        p.value ? art.pref(p.value, 28) : ''
      }<span>${esc(p.label)}</span></button>`;
    })
    .join('');
  const myPref = v.me.pref && PREF_OF[v.me.pref];
  const players = v.players
    .map(
      (p) => `<li class="player ${p.connected ? '' : 'off'}">
      <span class="dot" aria-hidden="true"></span>
      <span class="pname">${esc(p.nickname)}${p.id === v.me.id ? '（你）' : ''}</span>
      ${p.pref && PREF_OF[p.pref] ? `<span class="bag" title="背包">${art.pref(p.pref, 20)} ${esc(PREF_OF[p.pref].label)}</span>` : ''}
      ${p.isHost ? '<span class="tag gold">房主</span>' : ''}
      ${p.connected ? '' : '<span class="tag">離線</span>'}
    </li>`,
    )
    .join('');
  const n = v.players.length;
  const action = v.me.isHost
    ? `<button class="btn primary block" data-action="start" ${v.can.start ? '' : 'disabled'}>${n < 3 ? `開始（至少 3 人，還差 ${3 - n} 人）` : '開船！'}</button>`
    : '';
  return `<main class="screen lobby">
    ${
      v.me.isHost
        ? `<section class="card join-card">
      <div class="big-code"><span class="tb-label">房號</span><strong>${esc(v.code)}</strong></div>
      ${v.qrSvg ? `<div class="qr">${v.qrSvg}</div>` : ''}
      <p class="join-url">${esc(v.joinUrl)}</p>
      <p class="muted small">用手機相機掃描，或輸入房號加入。</p>
    </section>`
        : `<section class="card joined">
      <div class="big-code small-code"><span class="tb-label">你已上船</span><strong>${esc(v.code)}</strong></div>
      <details class="invite"><summary>還有人要加入？顯示 QR Code</summary>
        ${v.qrSvg ? `<div class="qr">${v.qrSvg}</div>` : ''}<p class="join-url">${esc(v.joinUrl)}</p>
      </details>
    </section>`
    }
    <section class="card">
      <h2>船員（${n}／10）</h2>
      <ul class="players">${players}</ul>
    </section>
    <section class="card bag-card">
      <h2>上船前，你會多帶一樣什麼？</h2>
      <p class="muted small">大家都看得到；可以跳過。</p>
      <div class="chips">${prefBtns}</div>
      ${myPref && myPref.note ? `<p class="muted small">${esc(myPref.note)}——說不定用得上。</p>` : ''}
    </section>
    <section class="card howto">
      <h2>怎麼玩</h2>
      <ol class="howto-list pics">
        <li>${art.item('麥子', 36)}<span>風暴來了，船太重：一起決定丟什麼。</span></li>
        <li>${art.need('力氣', true, 36)}<span>每個人只知道一部分，開口問、互看手機。</span></li>
        <li>${art.role('eng', 36)}<span>天黑時，大家形容記號，幫木匠補船。</span></li>
      </ol>
    </section>
    ${action ? `<div class="action-end">${action}</div>` : '<p class="waiting">等房主開船…</p>'}
  </main>`;
}

// ───────── 船上（開局、規劃、重新規劃） ─────────

function skyOf(v) {
  if (v.phase === 'intro') return 'harbor';
  if (v.phase === 'planning') return 'storm';
  if (v.phase === 'replanning') return v.ship && v.ship.dawnAt && now() < v.ship.dawnAt ? 'night' : 'night';
  return 'storm';
}

function sceneOpts(v) {
  const s = v.ship;
  const onDeck = s.items.filter((i) => i.onShip).map((i) => i.id);
  const afloat = s.items.filter((i) => !i.onShip && !i.gone).map((i) => i.id);
  return {
    sky: skyOf(v),
    onDeck,
    afloat,
    justThrown: ui.justThrown,
    justRescued: ui.justRescued,
    load: { weight: s.weight, cap: s.cap },
    rock: v.phase === 'intro' ? 'calm' : 'storm',
  };
}

/** 載重格：一格一單位，超過的變紅。 */
function loadGauge(s) {
  const total = Math.max(s.weight, s.cap);
  let cells = '';
  for (let i = 0; i < total; i++) {
    const filled = i < s.weight;
    const over = i >= s.cap;
    cells += `<span class="cell ${filled ? 'f' : ''} ${over ? 'over' : ''}"></span>`;
  }
  return `<div class="gauge ${s.overweight ? 'bad' : ''}" data-block="load" role="img" aria-label="重量 ${s.weight}，最多 ${s.cap}${s.overweight ? `，超重 ${s.overweight}` : ''}">
    <span class="g-icon" aria-hidden="true">⚖️</span><span class="cells">${cells}</span>
    <strong>${s.weight}<small>／${s.cap}</small></strong>${s.overweight ? `<span class="g-over">超重 ${s.overweight}</span>` : ''}
  </div>`;
}

/** 上岸三件事：危機前是問號（要問隊友），危機後即時亮起。 */
function needsRow(v) {
  const s = v.ship;
  const ids = ['力氣', '船身', '天亮'];
  const items = ids
    .map((id) => {
      const n = s.needs && s.needs.find((x) => x.id === id);
      const lit = !!(n && n.lit);
      return `<span class="need ${s.needs ? (lit ? 'lit' : 'dim') : 'unknown'}" data-need="${id}">${art.need(id, lit, 30)}<small>${esc(NEED_LABEL[id])}${s.needs ? (lit ? ' ✓' : '') : ' ?'}</small></span>`;
    })
    .join('');
  return `<div class="needs" aria-label="上岸三件事">${items}</div>`;
}

function cardChips(v) {
  const chips = ['a', 'b']
    .map((k) => v.cards[k])
    .filter(Boolean)
    .map((c) => `<button class="card-chip" data-action="card-open" data-card="${c.id}" aria-label="看故事卡：${esc(c.title)}">
      <span class="cc-art" aria-hidden="true">${art.card(c.id)}</span><span class="cc-t">${esc(c.title)}</span></button>`)
    .join('');
  return chips ? `<div class="card-chips">${chips}</div>` : '';
}

/** 管倉的托盤：按一下＝丟進海裡／撈回來。只有管倉看得到。 */
function itemTray(v) {
  const s = v.ship;
  const btns = s.items
    .filter((i) => !i.gone)
    .map((i) => {
      const blocks = '<i></i>'.repeat(Math.max(0, i.weight));
      return `<button class="tray-item ${i.onShip ? 'on' : 'off'} ${i.pinned ? 'pinned' : ''}" data-action="item" data-item="${esc(i.id)}" data-on="${i.onShip ? '0' : '1'}"
        aria-pressed="${i.onShip}" aria-label="${esc(i.id)}，重 ${i.weight}，${i.onShip ? '在船上，按一下丟進海裡' : '在海裡，按一下撈回來'}${i.pinned ? '（船主不准丟）' : ''}">
        <span class="ti-pic">${art.item(i.id, 40)}${i.pinned ? '<span class="ti-lock" aria-hidden="true">🔒</span>' : ''}</span>
        <span class="ti-name">${esc(i.id)}</span>
        <span class="ti-w" aria-hidden="true">${blocks}</span>
        <span class="ti-state" aria-hidden="true">${i.onShip ? '丟' : '撈回'}</span>
      </button>`;
    })
    .join('');
  return `<section class="tray" data-block="items"><div class="tray-grid">${btns}</div></section>`;
}

function eatCard(v) {
  if (!v.can.eat) return '';
  return `<section class="eat-card">
    <div class="eat-art" aria-hidden="true">${art.item('糧食', 44)}</div>
    <div><button class="btn primary block" data-action="eat" ${v.eatNeedsFood ? 'disabled' : ''}>召集大家吃飯</button>
    ${v.eatNeedsFood ? '<p class="muted small">糧食在海裡：先請管倉撈回來。</p>' : '<p class="muted small">只能吃一次。</p>'}</div>
  </section>`;
}

function nextSteps(v) {
  if (!v.nextSteps.length || v.phase === 'replanning') return '';
  return `<div class="next-step">${v.nextSteps
    .map((s) => `<p><span class="ns-verb">去${esc(s.verb)}</span> <strong>${esc(s.nickname)}</strong>：${esc(s.text)}</p>`)
    .join('')}</div>`;
}

function renderShip(v) {
  const s = v.ship;
  const hint = v.hint ? `<div class="banner hint" role="status"><span aria-hidden="true">💡</span> ${esc(v.hint)}</div>` : '';
  const crisis =
    v.phase === 'replanning' && v.crisis
      ? `<div class="banner crisis-note" role="status">浪更大了：船最多只能留 <strong>${s.cap}</strong>${s.fed ? '' : ''}</div>`
      : '';
  const fedLine = s.fed ? `<div class="banner fed" role="status">${art.need('力氣', true, 22)} ${esc(s.fedBy || '伙房')} 召集大家吃過飯了（27:36）</div>` : '';
  const dawnWait = v.phase === 'replanning' && s.dawnAt && now() < s.dawnAt
    ? `<div class="banner dawn" role="status">⚓ 拋了錨，等天亮：<strong data-cd="dawn">${mmss(s.dawnAt - now())}</strong></div>`
    : '';
  let button = '';
  if (v.can.lock) button = `<button class="btn primary block big" data-action="lock" ${lockOpen(v) ? '' : 'aria-disabled="true"'}>決定好了</button>`;
  if (v.can.depart) button = `<button class="btn primary block big" data-action="depart">衝向海灘</button>`;
  const task = v.myTask ? `<p class="my-task">${esc(v.myTask)}</p>` : '';
  return `<main class="screen ship ${button ? 'has-bar' : ''}">
    <div class="ship-meta">${loadGauge(s)}${needsRow(v)}</div>
    ${cardChips(v)}
    ${hint}${crisis}${fedLine}${dawnWait}
    ${v.can.items ? itemTray(v) : ''}
    ${eatCard(v)}
    ${task}
    ${nextSteps(v)}
    <section class="clues" aria-label="你的線索">${clueCards(v)}</section>
    <button class="btn ghost small zoom-btn" data-action="zoom">放大給隊友看</button>
  </main>
  ${actionBar(v, button)}`;
}

// ───────── 黑暗中補船 ─────────

function renderBlackout(v) {
  const r = v.repair;
  const c = v.crisis;
  const base = slotBase(v);
  const total = r ? r.order.length : 0;
  let body = '';
  if (r && r.done) {
    body = `<section class="bo-card done"><h2>補好了！</h2></section>`;
  } else if (r) {
    if (v.can.eliminate) {
      body += `<section class="bo-card torch">${art.pref('lamp', 36)}<div><h2>你有油燈</h2><p class="muted small">照亮木匠現在那一格，灰掉兩個錯的。只能一次。</p>
        <button class="btn secondary block" data-action="eliminate">照亮面板</button></div></section>`;
    }
    if (r.panel) body += engineerPanel(v, base);
    for (const s of r.mySymbols) {
      const show = ui.holding === String(s.slot);
      body += `<section class="bo-card">
          <h2>第 ${s.slot + base} 格的記號在你手上</h2>
          <button class="hold ${show ? 'show' : ''}" data-hold="${s.slot}" ${show ? `data-sym="${esc(s.id)}"` : ''} aria-label="按住顯示第 ${s.slot + base} 格記號">
            ${show ? holdInner(v, s.slot) : HOLD_COVER}
          </button>
          <p class="muted small">按住看，用說的讓木匠 <strong>${esc(r.engineerNickname)}</strong> 找出來：形狀？幾個缺口？開口朝哪？</p>
        </section>`;
    }
    if (r.myEliminationClue) {
      body += `<section class="bo-card"><h2>你的排除線索</h2><p class="lead">${esc(r.myEliminationClue)}</p>
        <p class="muted small">告訴木匠 ${esc(r.engineerNickname)}。</p></section>`;
    }
    if (!v.can.eliminate && v.preferenceHint) body += `<p class="bo-pref">${art.pref('lamp', 20)} ${esc(v.preferenceHint)}</p>`;
    if (!r.panel) {
      const order = r.order.map((o) => `<span class="ord"><b>${o.slot + base}</b> ${esc(o.nickname)}</span>`).join('<span aria-hidden="true">→</span>');
      body += `<p class="bo-order">木匠 <strong>${esc(r.engineerNickname)}</strong> 的順序：${order}</p>`;
    }
  }
  const assist = r
    ? r.assistLevel > 0
      ? `<span class="assist on">協助：部分錯誤選項已灰掉</span>`
      : `<span class="assist">協助 <strong data-cd="assist">${mmss(r.assistAt - now())}</strong> 後開啟</span>`
    : '';
  return `<div class="blackout ${ui.noFlicker ? 'no-flicker' : ''}" role="alert">
    <div class="bo-bg" aria-hidden="true">${art.darkness()}</div>
    <div class="bo-head">
      <h1>天黑了</h1>
      <button class="btn tiny ghost" data-action="flicker" aria-label="${ui.noFlicker ? '開啟閃電' : '關閉閃電'}">${ui.noFlicker ? '閃電：關' : '閃電：開'}</button>
    </div>
    ${v.story ? `<p class="bo-story">${esc(v.story.text)}<cite>${esc(v.story.ref)}</cite></p>` : ''}
    ${c ? `<p class="bo-reveal">${c.cause === 'lock' ? '你們決定的' : '時間到時的'}留法，原本顧好 <strong>${c.starsBefore}</strong>／3 件；現在浪更大了，船只能留 4。</p>` : ''}
    ${
      r
        ? `<div class="bo-timer"><span>補船 <strong data-cd="repair">${mmss(r.startedAt + r.limitMs - now())}</strong></span><span>進度 <strong>${r.progress}／${total}</strong></span></div>
          <div class="bo-assist">${assist}</div>`
        : ''
    }
    ${body}
  </div>`;
}

function engineerPanel(v, base) {
  const r = v.repair;
  const slots = r.panel.slots;
  const cur = slots.find((s) => !s.done);
  const pills = slots
    .map((s) => `<span class="pill ${s.done ? 'ok' : cur && s.index === cur.index ? 'cur' : ''}">${s.done ? '✓ ' : ''}第 ${s.index + base} 格</span>`)
    .join('');
  if (!cur) return `<section class="bo-card"><h2>全部選好了！</h2><div class="pills">${pills}</div></section>`;
  const opts = cur.options
    .map(
      (o) => `<button class="opt ${o.grayed ? 'gray' : ''}" data-action="pick" data-opt="${esc(o.id)}" ${o.grayed ? 'disabled aria-disabled="true"' : ''}>${symbolSvg(o.id, {
        size: 64,
        title: '選項',
      })}${r.assistLevel > 0 ? `<span>${esc(o.desc || describeSymbol(o.id))}</span>` : ''}</button>`,
    )
    .join('');
  const wrong = Date.now() < ui.wrongUntil;
  return `<section class="bo-card eng">
    <div class="pills">${pills}</div>
    <h2>${art.role('eng', 26)} 第 ${cur.index + base} 格：請問 <span class="ask">${esc(cur.askNickname)}</span></h2>
    ${wrong ? '<p class="soft-warn" role="status">不是這個，再問問看。</p>' : ''}
    <div class="opts">${opts}</div>
  </section>`;
}

// ───────── 結尾 ─────────

function momentIcon(m) {
  const { kind, ids } = m.icon;
  const one = (id) => {
    if (kind === 'card') return `<span class="mi-card">${art.card(id)}</span>`;
    if (kind === 'item') return art.item(id, 28);
    if (kind === 'need') return art.need(id, true, 28);
    if (kind === 'role') return art.role(id, 28);
    if (kind === 'pref') return art.pref(id, 28);
    if (id === 'meal') return art.need('力氣', true, 28);
    if (id === 'landing') return art.need('天亮', true, 28);
    return '';
  };
  return `<span class="m-icon" aria-hidden="true">${ids.map(one).join('')}</span>`;
}

function renderResult(v) {
  const res = v.result;
  if (!res) return `<main class="screen center"><p class="muted">結算中…</p></main>`;
  const needs = ['力氣', '船身', '天亮']
    .map((id, i) => `<span class="need big ${res.lit[id] ? 'lit' : 'dim'}" style="--d:${0.3 + i * 0.5}s">${art.need(id, res.lit[id], 54)}<small>${esc(NEED_LABEL[id])}</small></span>`)
    .join('');
  const moments = (res.moments || []).map((m) => `<li>${momentIcon(m)}<span>${esc(m.text)}</span></li>`).join('');
  const others = v.players.filter((p) => p.id !== v.me.id && p.roles.length > 0);
  const thankBtns = others
    .map((p) => {
      const on = res.myThanks === p.id;
      return `<button class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-action="thank" data-to="${esc(p.id)}">${on ? '♥ ' : ''}${esc(p.nickname)}</button>`;
    })
    .join('');
  const thanks = res.thanks.length
    ? `<ul class="thanks">${res.thanks.map((t) => `<li>${esc(nickOf(v, t.from))} <span aria-label="謝謝">→</span> ${esc(nickOf(v, t.to))}</li>`).join('')}</ul>`
    : '';
  const action = v.can.next ? `<button class="btn primary block" data-action="next">再來一局：新的故事卡</button>` : '';
  return `<main class="screen result">
    <section class="card result-hero">
      <h1>${esc(res.title)}</h1>
      <div class="result-needs" aria-label="${res.stars}／3 件顧好">${needs}</div>
      <p class="saved">船上 276 人，全都得救上了岸<cite>徒 27:37、44</cite></p>
    </section>
    <section class="card"><h2>這局發生的事</h2><ul class="moments">${moments}</ul>
      <p class="bible-cmp">${esc(res.bible)}</p></section>
    <section class="card verse-card">
      <blockquote>${esc(res.verse.text)}<cite>${esc(res.verse.ref)}</cite></blockquote>
      <p class="fact"><span class="tip-k">你知道嗎？</span>${esc(res.fact)}</p>
    </section>
    <section class="card">
      <h2>謝謝誰？</h2>
      <div class="chips">${thankBtns || '<span class="muted">沒有其他隊友</span>'}</div>
      ${thanks}
      ${res.question ? `<p class="ask-q">隨口聊聊：${esc(res.question)}</p>` : ''}
    </section>
    ${action ? `<div class="action-end">${action}</div>` : `<p class="waiting">等房主開下一局</p>`}
  </main>`;
}

function renderSpectator(v) {
  const list = v.players.map((p) => `<li class="player ${p.connected ? '' : 'off'}"><span class="dot"></span><span class="pname">${esc(p.nickname)}</span></li>`).join('');
  return `<main class="screen">
    <section class="card"><h2>這局已經開船了</h2><p>你會在下一局加入。先看看大家怎麼合作！</p></section>
    <section class="card"><h2>船員</h2><ul class="players">${list}</ul></section>
  </main>`;
}

function renderZoom(v) {
  const roles = v.me.roles.map((r) => `<div class="zoom-role">${art.role(r.id, 40)} ${esc(r.name)}</div>`).join('');
  return `<div class="zoom" role="dialog" aria-modal="true" aria-label="放大的線索">
    <div class="zoom-inner">
      <div class="zoom-nick">${esc(v.me.nickname)}</div>
      ${roles}
      ${v.clues
        .map((c) => `<div class="zoom-clue">${c.item ? art.item(c.item, 48) : ''}${c.need ? art.need(c.need, true, 48) : ''}<div class="zoom-title">${esc(c.title)}</div><p>${esc(c.text)}</p></div>`)
        .join('')}
    </div>
    <button class="btn primary block zoom-close" data-action="unzoom">收起來</button>
  </div>`;
}

// ───────── 疊加層：故事卡、吃飯、上岸 ─────────

function cardOverlay(c, deckLabel) {
  return `<div class="ovl card-ovl" role="dialog" aria-modal="true" aria-label="故事卡：${esc(c.title)}">
    <div class="story-card">
      <div class="sc-deck">${esc(deckLabel)}</div>
      <div class="sc-art">${art.card(c.id)}</div>
      <h2>${esc(c.title)}</h2>
      <blockquote>${esc(c.verse)}<cite>${esc(c.ref)}</cite></blockquote>
      <p class="sc-effect"><span>所以這局</span>${esc(c.effect)}</p>
      <p class="sc-note">卡片效果是遊戲設定；經文記的是事件本身。</p>
      <button class="btn primary block" data-action="card-close">知道了</button>
    </div>
  </div>`;
}

function overlayHtml(v) {
  if (!v || !v.round) return '';
  if (ui.revealAt && Date.now() - ui.revealAt < REVEAL_MS && v.result) {
    return `<div class="ovl landing-ovl" aria-hidden="true">${art.landing({ lit: v.result.lit })}<p class="ovl-cap">天亮了，衝向海灘！<cite>徒 27:39–41</cite></p></div>`;
  }
  if (ui.mealAt && Date.now() - ui.mealAt < MEAL_MS) {
    return `<div class="ovl meal-ovl" aria-hidden="true">${art.meal()}<p class="ovl-cap">於是他們都放下心，也就吃了。<cite>徒 27:36</cite></p></div>`;
  }
  if (ui.cardOpen) {
    const c = [v.cards.a, v.cards.b].find((x) => x && x.id === ui.cardOpen);
    if (c) return cardOverlay(c, c.deck === 'A' ? '起風時發生的事' : '風暴中發生的事');
  }
  return '';
}

/** 疊加層的身分：同一個身分不重畫（SVG 每次產生的 id 不同，動畫才不會重來）。 */
function overlayKey(v) {
  if (!v || !v.round) return '';
  if (ui.revealAt && Date.now() - ui.revealAt < REVEAL_MS && v.result) return 'landing:' + ui.revealAt;
  if (ui.mealAt && Date.now() - ui.mealAt < MEAL_MS) return 'meal:' + ui.mealAt;
  if (ui.cardOpen && [v.cards.a, v.cards.b].some((x) => x && x.id === ui.cardOpen)) return 'card:' + ui.cardOpen;
  return '';
}

/** 新翻開的故事卡自動跳出一次（開局一張、補好船一張）。 */
function autoOpenCard(v) {
  if (!v || !v.round || ui.cardOpen) return;
  if (!['intro', 'planning', 'replanning'].includes(v.phase)) return;
  for (const c of [v.cards.a, v.cards.b]) {
    if (!c) continue;
    const key = `${v.round.no}:${c.id}`;
    if (ui.seenCards.has(key)) continue;
    ui.seenCards.add(key);
    ui.cardOpen = c.id;
    ui.cardOpenAt = Date.now();
    return;
  }
}

// ───────── 主畫面 ─────────

function renderStatus() {
  const el = document.getElementById('conn');
  if (!el) return;
  const bad = ui.status !== 'open';
  el.hidden = !bad;
  el.textContent = ui.status === 'connecting' ? '連線中…' : '連線中斷，正在重新連線…';
}

function render() {
  const v = ui.view;
  const active = document.activeElement;
  const focusId = active && active.id && bodyEl.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  autoOpenCard(v);

  let hud = '';
  let hudKey = '';
  let html;
  if (!v) html = renderHome();
  else if (v.me.spectator && !['lobby', 'settled', 'ended'].includes(v.phase)) {
    hud = renderTopbar(v);
    html = renderSpectator(v);
  } else {
    switch (v.phase) {
      case 'lobby':
        hud = renderTopbar(v);
        html = renderLobby(v);
        break;
      case 'intro':
      case 'planning':
      case 'replanning':
        {
          const opts = sceneOpts(v);
          hudKey = renderTopbar(v).replace(/data-cd="round">[^<]*/, '') + JSON.stringify(opts) + storyLine(v);
          if (hudKey !== lastHud) hud = `${renderTopbar(v)}<div class="stage">${art.scene(opts)}${storyLine(v)}</div>`;
        }
        html = renderShip(v);
        break;
      case 'blackout':
        html = renderBlackout(v);
        break;
      case 'settled':
      case 'ended':
        hud = renderTopbar(v);
        html = renderResult(v);
        break;
      default:
        html = `<main class="screen center"><p class="muted">載入中…</p></main>`;
    }
    if (ui.zoom && v.phase !== 'blackout') html += renderZoom(v);
  }
  if (!hudKey) hudKey = hud.replace(/data-cd="round">[^<]*/, '');
  if (hudKey !== lastHud) {
    hudEl.innerHTML = hud;
    lastHud = hudKey;
  }
  bodyEl.innerHTML = html;
  const ovlKey = overlayKey(v);
  const ovl = ovlKey && ovlKey !== lastOvl ? overlayHtml(v) : null;
  if (ovlKey !== lastOvl) {
    ovlEl.innerHTML = ovl || '';
    lastOvl = ovlKey;
  }
  document.body.classList.toggle('is-blackout', !!v && v.phase === 'blackout');
  document.body.classList.toggle('has-ovl', !!ovlKey);
  if (ui.flash && Date.now() < ui.flash.until) {
    for (const b of ui.flash.blocks) for (const el of root.querySelectorAll(`[data-block="${b}"]`)) el.classList.add('flash');
  }
  if (v) ui.lockOpen = lockOpen(v);
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  renderStatus();
}

// 每 250ms 只更新倒數文字；動畫結束、提示到期時才重畫
setInterval(() => {
  const v = ui.view;
  if (!v) return;
  for (const el of root.querySelectorAll('[data-cd]')) {
    const k = el.getAttribute('data-cd');
    let ms = null;
    if (k === 'round' && v.round) ms = v.round.startedAt + v.round.timeLimitMs - now();
    else if (k === 'repair' && v.repair) ms = v.repair.startedAt + v.repair.limitMs - now();
    else if (k === 'assist' && v.repair) ms = v.repair.assistAt - now();
    else if (k === 'lock' && v.round) ms = v.round.lockOpensAt - now();
    else if (k === 'dawn' && v.ship && v.ship.dawnAt) ms = v.ship.dawnAt - now();
    if (ms != null) {
      el.textContent = mmss(ms);
      el.classList.toggle('low', ms < 30000 && k === 'round');
    }
  }
  let redraw = false;
  if (v.round && ui.lockOpen === false && lockOpen(v)) redraw = true;
  if (v.ship && v.ship.dawnAt && now() >= v.ship.dawnAt && root.querySelector('[data-cd="dawn"]')) redraw = true;
  if (ui.revealAt && Date.now() - ui.revealAt >= REVEAL_MS) {
    ui.revealAt = 0;
    redraw = true;
  }
  if (ui.mealAt && Date.now() - ui.mealAt >= MEAL_MS) {
    ui.mealAt = 0;
    redraw = true;
  }
  if (ui.cardOpen && Date.now() - ui.cardOpenAt > CARD_AUTO_CLOSE_MS) {
    ui.cardOpen = null;
    redraw = true;
  }
  if (ui.note && Date.now() > ui.note.until) {
    ui.note = null;
    redraw = true;
  }
  if (ui.wrongUntil && Date.now() > ui.wrongUntil) {
    ui.wrongUntil = 0;
    redraw = true;
  }
  if (redraw) render();
}, 250);

// ───────── 事件 ─────────

document.addEventListener('input', (e) => {
  const el = e.target;
  const k = el && el.getAttribute && el.getAttribute('data-model');
  if (!k) return;
  ui[k] = k === 'code' ? el.value.toUpperCase() : el.value;
  if (k === 'code' && el.value !== ui.code) {
    const pos = el.selectionStart;
    el.value = ui.code;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* 忽略 */
    }
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.getAttribute('data-form');
  if (kind === 'create' || kind === 'join') {
    const nickname = ui.nick.trim();
    if (!nickname) return toast('先輸入暱稱，隊友才知道怎麼叫你。');
    if (kind === 'join') {
      const code = ui.code.trim().toUpperCase();
      if (!code) return toast('請輸入房號。');
      conn.send({ t: 'join', code, nickname });
    } else {
      conn.send({ t: 'create', nickname });
    }
    clearSession();
    ui.left = false;
    ui.busy = true;
    render();
  }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.getAttribute('data-action');
  const v = ui.view;
  switch (a) {
    case 'home-mode':
      ui.homeMode = el.getAttribute('data-mode');
      render();
      break;
    case 'forget':
      clearSession();
      ui.hadSession = false;
      render();
      break;
    case 'pref': {
      const val = el.getAttribute('data-value');
      ui.prefSkipped = !val;
      render();
      conn.send({ t: 'pref', value: val ? val : null });
      break;
    }
    case 'start':
      conn.send({ t: 'start' });
      break;
    case 'zoom':
      ui.zoom = true;
      render();
      break;
    case 'unzoom':
      ui.zoom = false;
      render();
      break;
    case 'card-open':
      ui.cardOpen = el.getAttribute('data-card');
      ui.cardOpenAt = Date.now();
      render();
      break;
    case 'card-close':
      ui.cardOpen = null;
      render();
      break;
    case 'item':
      if (v && v.can.items) conn.act({ type: 'setItem', item: el.getAttribute('data-item'), on: el.getAttribute('data-on') === '1' });
      break;
    case 'note-close':
      ui.note = null;
      render();
      break;
    case 'lock':
      conn.act({ type: 'lock' });
      break;
    case 'depart':
      conn.act({ type: 'depart' });
      break;
    case 'eat':
      conn.act({ type: 'eat' });
      break;
    case 'pick':
      conn.act({ type: 'repairPick', option: el.getAttribute('data-opt') });
      break;
    case 'eliminate':
      conn.act({ type: 'useEliminate' });
      break;
    case 'flicker':
      ui.noFlicker = !ui.noFlicker;
      writeFlag('im.noFlicker', ui.noFlicker);
      render();
      break;
    case 'thank': {
      const to = el.getAttribute('data-to');
      const cur = v && v.result ? v.result.myThanks : null;
      conn.send({ t: 'thank', to: cur === to ? null : to });
      break;
    }
    case 'next':
      conn.send({ t: 'next' });
      break;
    case 'leave':
      ui.leaveConfirm = true;
      render();
      break;
    case 'leave-cancel':
      ui.leaveConfirm = false;
      render();
      break;
    case 'leave-yes':
      conn.send({ t: 'leave' });
      conn.clearPending();
      clearSession();
      ui.view = null;
      ui.left = true;
      ui.hadSession = false;
      ui.leaveConfirm = false;
      ui.zoom = false;
      render();
      break;
  }
});

// 長按才顯示記號：按下顯示、放開就隱藏。就地更新，不重畫整頁。
function holdInner(v, slot) {
  const s = v && v.repair ? v.repair.mySymbols.find((x) => String(x.slot) === String(slot)) : null;
  if (!s) return '';
  const assist = v.repair.assistLevel > 0;
  return `<span class="hold-sym">${symbolSvg(s.id, { size: 150, title: '你的記號' })}</span>${assist ? `<span class="hold-desc">${esc(s.desc || describeSymbol(s.id))}</span>` : ''}`;
}
const HOLD_COVER = '<span class="hold-cover">按住這裡<br>才會顯示記號</span>';
function setHolding(slot) {
  if (ui.holding === slot) return;
  ui.holding = slot;
  for (const el of root.querySelectorAll('[data-hold]')) {
    const on = slot != null && el.getAttribute('data-hold') === slot;
    el.classList.toggle('show', on);
    el.innerHTML = on ? holdInner(ui.view, slot) : HOLD_COVER;
    const s = on && ui.view && ui.view.repair ? ui.view.repair.mySymbols.find((x) => String(x.slot) === String(slot)) : null;
    if (s) el.setAttribute('data-sym', s.id);
    else el.removeAttribute('data-sym');
  }
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-hold]');
  if (!el) return;
  e.preventDefault();
  setHolding(el.getAttribute('data-hold'));
});
for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) document.addEventListener(t, () => setHolding(null));
window.addEventListener('blur', () => setHolding(null));
document.addEventListener('visibilitychange', () => setHolding(null));
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest && e.target.closest('[data-hold]')) e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  const el = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-hold]');
  if (el && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    if (!e.repeat) setHolding(el.getAttribute('data-hold'));
  } else if (e.key === 'Escape') {
    if (ui.cardOpen) ui.cardOpen = null;
    else if (ui.zoom) ui.zoom = false;
    render();
  }
});
document.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && ui.holding != null) setHolding(null);
});

// reduced-motion：動畫層直接跳過（art.css 也會把動畫關掉）
if (reduceMotion()) {
  /* 上岸／吃飯仍會顯示靜態圖，時間照常 */
}

render();
