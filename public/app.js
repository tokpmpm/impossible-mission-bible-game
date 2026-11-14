// 《不可能的任務》第一關「暴風雨救援」手機前端。
// 原則：只照伺服器送來的 view（src/server/view.ts）畫圖，不自己算規則。
import { createConnection, loadSession, clearSession } from './net.js';
import { symbolSvg, describeSymbol } from './symbols.js';

const PREFS = [
  { value: 'planner', label: '旅行規劃派' },
  { value: 'casual', label: '隨性派' },
  { value: 'either', label: '都可以' },
];
const ROUTE_STYLE = {
  // 不只靠顏色：每條線有不同的記號與線型（實線／虛線／點線）
  紅: { cls: 'r-red', mark: '━', dash: '' },
  藍: { cls: 'r-blue', mark: '╍', dash: '10 7' },
  綠: { cls: 'r-green', mark: '┈', dash: '2 7' },
};
const VILLAGES = ['東村', '西村', '北村'];

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
const params = new URLSearchParams(location.search);

const ui = {
  view: null,
  status: 'connecting',
  offset: 0, // 伺服器時間 − 本機時間
  hadSession: !!loadSession(),
  left: false,
  busy: false,
  homeMode: params.get('room') ? 'join' : 'create',
  nick: (params.get('nick') || '').slice(0, 12),
  code: (params.get('room') || '').toUpperCase().slice(0, 8),
  introTab: 'me',
  zoom: false,
  holding: null, // 正在長按的符號格
  seenWrong: null,
  wrongUntil: 0,
  seenFloodWrong: null,
  floodWrongUntil: 0,
  channel: '',
  qVillage: null,
  qQuestion: null,
  qConfirm: false,
  leaveConfirm: false,
  prefSkipped: false,
  noFlicker: readFlag('im.noFlicker'),
};

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
    trackFlashes(view);
    const prevPhase = ui.view && ui.view.phase;
    ui.view = view;
    if (prevPhase !== view.phase) onPhaseChange(prevPhase, view.phase);
    render();
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

function trackFlashes(v) {
  const wf = v.repair ? v.repair.wrongFlash : null;
  if (wf != null) {
    if (ui.seenWrong != null && wf > ui.seenWrong) ui.wrongUntil = Date.now() + 3500;
    ui.seenWrong = wf;
  } else ui.seenWrong = null;
  const ff = v.breakthrough ? v.breakthrough.floodgateWrongCount : null;
  if (ff != null) {
    if (ui.seenFloodWrong != null && ff > ui.seenFloodWrong) ui.floodWrongUntil = Date.now() + 4500;
    ui.seenFloodWrong = ff;
  } else ui.seenFloodWrong = null;
}

function onPhaseChange(prev, next) {
  ui.holding = null;
  ui.qConfirm = false;
  ui.leaveConfirm = false;
  if (next === 'intro') ui.introTab = 'me';
  if (next === 'blackout') ui.zoom = false;
  if (prev && next !== prev) window.scrollTo(0, 0);
}

// ───────── 共用元件 ─────────

function slotBase(v) {
  // 格子編號可能從 0 或 1 起算；畫面一律顯示「第 1 格」起
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

function roleChips(v) {
  return v.me.roles
    .map((r) => `<span class="role-chip"><span aria-hidden="true">${esc(r.icon)}</span>${esc(r.name)}</span>`)
    .join('');
}

function renderTopbar(v) {
  const leave = ui.leaveConfirm
    ? `<div class="leave-confirm"><span>確定離開房間？</span>
        <button class="btn small ghost" data-action="leave-cancel">留下</button>
        <button class="btn small danger" data-action="leave-yes">離開</button></div>`
    : `<button class="btn small ghost" data-action="leave">離開</button>`;
  return `<header class="topbar">
    <div class="tb-room"><span class="tb-label">房號</span><strong>${esc(v.code)}</strong></div>
    <div class="tb-me"><span class="tb-nick">${esc(v.me.nickname)}</span>${roleChips(v)}</div>
    ${leave}
  </header>`;
}

function clueCards(v, opt = {}) {
  if (!v.clues.length) return `<p class="muted">目前還沒有線索。</p>`;
  return v.clues
    .map(
      (c) => `<article class="clue ${c.breakthrough ? 'clue-bt' : ''} ${opt.big ? 'big' : ''}">
      <div class="clue-head"><span class="clue-title">${esc(c.title)}</span>${
        c.breakthrough ? `<span class="tag gold">突破口 ${c.breakthrough}／3</span>` : ''
      }<span class="tag">${esc(c.role)}</span></div>
      <p>${esc(c.text)}</p></article>`,
    )
    .join('');
}

function timerBar(v, label) {
  if (!v.round) return '';
  return `<div class="timerbar" role="timer">
    <div><span class="tb-label">${esc(label)}</span><span class="seed">第 ${v.round.no} 局・${esc(v.round.seedTitle)}</span></div>
    <div class="countdown"><span class="tb-label">房間倒數</span><strong data-cd="round">${mmss(
      v.round.startedAt + v.round.timeLimitMs - now(),
    )}</strong></div>
  </div>`;
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
      <div class="hero-badge">第一關</div>
      <h1 class="logo">不可能的任務</h1>
      <p class="hero-sub">暴風雨救援・每人一支手機，一起把物資送到村莊</p>
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
      <button class="btn primary block" type="submit" ${ui.busy ? 'disabled' : ''}>${
        ui.busy ? '連線中…' : isJoin ? '加入房間' : '建立房間'
      }</button>
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
      return `<button class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-action="pref" data-value="${p.value ?? ''}">${esc(
        p.label,
      )}</button>`;
    })
    .join('');
  const players = v.players
    .map(
      (p) => `<li class="player ${p.connected ? '' : 'off'}">
      <span class="dot" aria-hidden="true"></span>
      <span class="pname">${esc(p.nickname)}${p.id === v.me.id ? '（你）' : ''}</span>
      ${p.isHost ? '<span class="tag gold">房主</span>' : ''}
      ${p.connected ? '' : '<span class="tag">離線</span>'}
    </li>`,
    )
    .join('');
  const n = v.players.length;
  let action;
  if (v.me.isHost) {
    action = `<button class="btn primary block" data-action="start" ${v.can.start ? '' : 'disabled'}>${
      n < 3 ? `開始（至少 3 人，還差 ${3 - n} 人）` : '開始任務'
    }</button>`;
  } else {
    action = '';
  }
  return `${renderTopbar(v)}
  <main class="screen lobby">
    <section class="card join-card">
      <div class="big-code"><span class="tb-label">房號</span><strong>${esc(v.code)}</strong></div>
      ${v.qrSvg ? `<div class="qr">${v.qrSvg}</div>` : ''}
      <p class="join-url">${esc(v.joinUrl)}</p>
      <p class="muted small">用手機相機掃描，或輸入房號加入。入房不計時。</p>
    </section>
    <section class="card">
      <h2>隊員（${n}／10）</h2>
      <ul class="players">${players}</ul>
    </section>
    <section class="card">
      <h2>旅行的時候，你比較像…</h2>
      <p class="muted small">可以跳過，不影響遊戲。</p>
      <div class="chips">${prefBtns}</div>
    </section>
    ${action ? `<div class="action-bar">${action}</div>` : '<p class="waiting">等房主開始…</p>'}
  </main>`;
}

// ───────── 開局介紹 ─────────

function renderIntro(v) {
  const r = v.round;
  const tabs = `<div class="seg" role="tablist">
    <button role="tab" aria-selected="${ui.introTab === 'me'}" class="seg-btn ${ui.introTab === 'me' ? 'on' : ''}" data-action="intro-tab" data-tab="me">你是誰</button>
    <button role="tab" aria-selected="${ui.introTab === 'plan'}" class="seg-btn ${ui.introTab === 'plan' ? 'on' : ''}" data-action="intro-tab" data-tab="plan">共享方案</button>
  </div>`;
  const introLeft = r ? `<p class="intro-cd">認識隊友 <strong data-cd="intro">${mmss(r.startedAt + r.introMs - now())}</strong></p>` : '';
  if (ui.introTab === 'plan') {
    const lock = v.can.lock ? `<div class="action-bar"><button class="btn primary block" data-action="lock">鎖定方案</button></div>` : '';
    return `${renderTopbar(v)}${timerBar(v, '開局')}<main class="screen planning">${tabs}${planningBody(v)}${lock}</main>`;
  }
  const roles = v.me.roles
    .map(
      (ro) => `<div class="role-hero"><div class="role-icon" aria-hidden="true">${esc(ro.icon)}</div>
      <div><div class="role-name">${esc(ro.name)}</div><div class="role-job">${esc(ro.job)}</div></div></div>`,
    )
    .join('');
  return `${renderTopbar(v)}${timerBar(v, '開局')}
  <main class="screen intro">
    ${tabs}
    ${introLeft}
    <section class="card">
      <h2 class="eyebrow">你是誰</h2>
      ${roles || '<p class="muted">（你這局沒有職能）</p>'}
    </section>
    <section class="card next-step">
      <h2 class="eyebrow">下一步</h2>
      <p class="lead">找一位隊友，交換暱稱與情報。</p>
    </section>
    <section class="card">
      <h2 class="eyebrow">我知道什麼</h2>
      ${clueCards(v)}
    </section>
    ${v.preferenceHint ? `<div class="note">${esc(v.preferenceHint)}</div>` : ''}
    <div class="action-bar"><button class="btn primary block" data-action="zoom">放大讓隊友看</button></div>
  </main>`;
}

// ───────── 規劃／重新規劃 ─────────

function routeLine(id, closed) {
  const st = ROUTE_STYLE[id] || ROUTE_STYLE['紅'];
  return `<svg class="route-line" viewBox="0 0 120 24" aria-hidden="true">
    <circle cx="8" cy="12" r="5" class="rl-end"/>
    <path d="M14 12 C40 0, 70 24, 104 12" class="rl-path" ${st.dash ? `stroke-dasharray="${st.dash}"` : ''}/>
    <path d="M104 4 l8 8 -8 8" class="rl-end-arrow"/>
    ${closed ? '<path d="M48 2 L72 22 M72 2 L48 22" class="rl-x"/>' : ''}
  </svg>`;
}

function planSummary(v) {
  const p = v.plan;
  if (!p) return '';
  const route = p.route
    ? `<span class="rmark ${ROUTE_STYLE[p.route.id]?.cls || ''}" aria-hidden="true">${ROUTE_STYLE[p.route.id]?.mark || ''}</span> ${esc(p.route.label)}${
        p.route.closed ? ' <span class="tag warn">封閉</span>' : ''
      }`
    : '<span class="muted">還沒選路線</span>';
  const tool = p.route ? (p.route.tool ? `工具：${esc(p.route.tool)}（跟著路線上車）` : '這條路不用工具') : '';
  const items = p.items.length ? p.items.map(esc).join('、') : '<span class="muted">還沒裝物資</span>';
  const pct = Math.min(100, Math.round((p.weight / Math.max(1, p.cap)) * 100));
  const over = p.overweight > 0;
  const travel = p.route ? p.route.travel : null;
  const story =
    travel != null || p.safeWindow != null
      ? `<div class="story">
        <span class="story-tag">故事時間</span>
        <span>路程 <strong>${travel ?? '—'}</strong> 分鐘</span>
        <span class="vs">${travel != null && p.safeWindow != null ? (travel < p.safeWindow ? '＜' : '≧') : '／'}</span>
        <span>洪水安全窗 <strong>${p.safeWindow ?? '—'}</strong> 分鐘</span>
        <small>路程要少於安全窗才來得及（和房間倒數無關）</small>
      </div>`
      : '';
  return `<section class="card summary" aria-live="polite">
    <div class="sum-head"><h2>共享方案</h2>${p.locked && v.phase !== 'replanning' ? '<span class="tag gold">已鎖定</span>' : ''}</div>
    <div class="reach"><span class="reach-n">${p.reachable}</span><span class="reach-d">／3 村</span><span class="reach-l">目前可送達</span></div>
    <dl class="sum-list">
      <div><dt>路線</dt><dd>${route}${tool ? `<div class="muted small">${tool}</div>` : ''}</dd></div>
      <div><dt>物資</dt><dd>${items}</dd></div>
    </dl>
    <div class="load ${over ? 'over' : ''}">
      <div class="load-row"><span>載重</span><strong>${p.weight}／${p.cap} kg</strong></div>
      <div class="load-bar"><span style="width:${pct}%"></span></div>
    </div>
    ${over ? `<div class="overweight" role="status">超重 ${p.overweight} kg，需要放下一樣</div>` : ''}
    ${story}
  </section>`;
}

function reasonsBlock(v, phase) {
  const p = v.plan;
  if (!p) return '';
  let html = '';
  const rej = p.lastRejection;
  if (rej && rej.reasons.length && now() - rej.at < 20000) {
    html += `<div class="notice soft" role="status"><strong>還不能出發：</strong>${rej.reasons.map(esc).join('；')}<br><span class="small">改一下方案再試一次就好。</span></div>`;
  }
  if (p.reasons.length && !(rej && now() - rej.at < 20000)) {
    const head = phase === 'planning' ? '鎖定前可以再看看：' : '出發前可以再看看：';
    html += `<div class="notice"><strong>${head}</strong><ul>${p.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
  }
  return html;
}

function routeCards(v) {
  const p = v.plan;
  if (!p) return '';
  const cards = p.routes
    .map((r) => {
      const st = ROUTE_STYLE[r.id] || {};
      const sel = p.route && p.route.id === r.id;
      const disabled = !v.can.route || r.closed;
      return `<button class="route ${st.cls || ''} ${sel ? 'sel' : ''} ${r.closed ? 'closed' : ''}" data-action="route" data-route="${esc(
        r.id,
      )}" ${disabled ? 'disabled' : ''} aria-pressed="${sel}">
        <div class="route-top"><span class="rmark ${st.cls || ''}" aria-hidden="true">${st.mark || ''}</span><span class="route-label">${esc(r.label)}</span>
        ${sel ? '<span class="tag gold">✓ 已選</span>' : ''}${r.closed ? '<span class="tag warn">✕ 封閉</span>' : ''}</div>
        ${routeLine(r.id, r.closed)}
        <div class="route-meta"><span>路程 <strong>${r.travel}</strong> 故事分鐘</span><span>${
          r.tool ? `需要：${esc(r.tool)}` : '不需工具'
        }</span></div>
      </button>`;
    })
    .join('');
  const who = v.can.route ? '你負責選路線，點一條試試看。' : '由導航選路線；你可以在旁邊出主意。';
  return `<section class="card"><h2>路線</h2><p class="muted small">${who}</p><div class="routes">${cards}</div></section>`;
}

function itemChips(v) {
  const p = v.plan;
  if (!p) return '';
  const chips = p.itemChoices
    .map((it) => {
      const disabled = !v.can.items || it.locked;
      return `<button class="chip item ${it.on ? 'on' : ''} ${it.locked ? 'locked' : ''}" data-action="item" data-item="${esc(
        it.id,
      )}" data-on="${it.on ? '0' : '1'}" aria-pressed="${it.on}" ${disabled ? 'disabled' : ''}>
        <span class="chk" aria-hidden="true">${it.on ? '✓' : it.locked ? '…' : '＋'}</span>${esc(it.name)}${
          it.locked ? '<small>尚未發放</small>' : ''
        }</button>`;
    })
    .join('');
  const who = v.can.items ? '你負責裝物資，點一下裝上或放下。' : '由補給裝物資；你可以告訴他哪個村需要什麼。';
  return `<section class="card"><h2>物資</h2><p class="muted small">${who}</p><div class="chips">${chips}</div></section>`;
}

function breakthroughCard(v) {
  const b = v.breakthrough;
  if (!b || v.phase !== 'replanning') return '';
  if (b.kind === 'floodgate') {
    if (b.done) {
      return `<section class="card bt done"><h2>分洪閘門已啟動</h2><p>上游的水被引開了，綠線的安全窗變長了。</p></section>`;
    }
    if (!v.can.floodgate) return '';
    const wrong = Date.now() < ui.floodWrongUntil;
    return `<section class="card bt">
      <h2>啟動分洪閘門</h2>
      <p class="muted small">需要輸入授權頻道。可以問問隊友誰知道。</p>
      <form class="row" data-form="floodgate">
        <label class="sr" for="in-channel">授權頻道</label>
        <input id="in-channel" data-model="channel" value="${esc(ui.channel)}" autocomplete="off" placeholder="授權頻道" required>
        <button class="btn secondary" type="submit">啟動分洪閘門</button>
      </form>
      ${wrong ? '<p class="soft-warn" role="status">頻道沒有對上，再問問隊友，可以再試。</p>' : ''}
    </section>`;
  }
  // seed 002：詢問
  if (b.queryReply) {
    return `<section class="card bt done"><h2>詢問的回覆</h2><p class="reply">${esc(b.queryReply)}</p></section>`;
  }
  if (!v.can.query || b.queryUsed) return '';
  const vill = VILLAGES.map(
    (x) =>
      `<button class="chip ${ui.qVillage === x ? 'on' : ''}" aria-pressed="${ui.qVillage === x}" data-action="q-village" data-value="${x}">${x}</button>`,
  ).join('');
  const qs = b.questions
    .map(
      (q) =>
        `<button class="chip ${ui.qQuestion === q.id ? 'on' : ''}" aria-pressed="${ui.qQuestion === q.id}" data-action="q-question" data-value="${esc(
          q.id,
        )}">${esc(q.text)}</button>`,
    )
    .join('');
  const ready = ui.qVillage && ui.qQuestion;
  const qText = ready ? (b.questions.find((q) => q.id === ui.qQuestion) || {}).text : '';
  const send = ui.qConfirm
    ? `<div class="confirm"><p>只有一次機會：確定要問<strong>${esc(ui.qVillage)}</strong>「${esc(qText)}」嗎？</p>
        <div class="row"><button class="btn ghost" data-action="q-cancel">再想想</button><button class="btn secondary" data-action="q-send">確定送出</button></div></div>`
    : `<button class="btn secondary block" data-action="q-ask" ${ready ? '' : 'disabled'}>送出詢問（只有一次）</button>`;
  return `<section class="card bt">
    <h2>向一個村發詢問</h2>
    <p class="muted small">只有一次機會，先聽聽隊友怎麼說。</p>
    <div class="label">問哪個村</div><div class="chips">${vill}</div>
    <div class="label">問什麼</div><div class="chips">${qs}</div>
    ${send}
  </section>`;
}

function planningBody(v) {
  const phase = v.phase;
  const hint = v.hint ? `<div class="hint" role="status"><span aria-hidden="true">💡</span> ${esc(v.hint)}</div>` : '';
  const pref = v.preferenceHint && phase !== 'intro' ? `<div class="note">${esc(v.preferenceHint)}</div>` : '';
  const crisisNote =
    phase === 'replanning' && v.crisis
      ? `<div class="notice"><strong>${esc(v.crisis.title)}</strong> 電力恢復了。重新看看方案吧，已裝的物資都還在。</div>`
      : '';
  return `${hint}${crisisNote}
    ${planSummary(v)}
    ${reasonsBlock(v, phase)}
    ${breakthroughCard(v)}
    ${routeCards(v)}
    ${itemChips(v)}
    <section class="card"><div class="sum-head"><h2>我的線索</h2><button class="btn small ghost" data-action="zoom">放大</button></div>${clueCards(
      v,
    )}</section>
    ${pref}`;
}

function renderPlanning(v) {
  const label = v.phase === 'planning' ? '規劃' : '重新規劃';
  let action = '';
  if (v.phase === 'planning' && v.can.lock) {
    action = `<button class="btn primary block" data-action="lock">鎖定方案</button>`;
  } else if (v.phase === 'replanning' && v.can.depart) {
    action = `<button class="btn primary block" data-action="depart">出發！</button>`;
  }
  return `${renderTopbar(v)}${timerBar(v, label)}
  <main class="screen planning">${planningBody(v)}
    ${action ? `<div class="action-bar">${action}</div>` : ''}
  </main>`;
}

// ───────── 停電 ─────────

function renderBlackout(v) {
  const r = v.repair;
  const c = v.crisis;
  const base = slotBase(v);
  const total = r ? r.order.length : 0;
  let body = '';
  if (r && r.done) {
    body = `<section class="bo-card done"><h2>恢復供電！</h2><p>大家辛苦了，馬上回到規劃畫面。</p></section>`;
  } else if (r) {
    if (r.panel) body += engineerPanel(v, base);
    if (r.mySymbols.length) {
      body += r.mySymbols
        .map((s) => {
          const show = ui.holding === String(s.slot);
          return `<section class="bo-card">
          <h2>你手上有第 ${s.slot + base} 格的符號</h2>
          <p>描述給工程師 <strong>${esc(r.engineerNickname)}</strong> 聽。</p>
          <button class="hold ${show ? 'show' : ''}" data-hold="${s.slot}" aria-label="按住顯示第 ${s.slot + base} 格符號">
            ${show ? holdInner(v, s.slot) : HOLD_COVER}
          </button>
          <p class="muted small">放開就會藏起來。說說外形、有幾個缺口、開口朝哪。</p>
        </section>`;
        })
        .join('');
    }
    if (r.myEliminationClue) {
      body += `<section class="bo-card"><h2>你的排除線索</h2><p class="lead">${esc(r.myEliminationClue)}</p>
        <p class="muted small">告訴工程師 ${esc(r.engineerNickname)}，幫他刪掉不可能的選項。</p></section>`;
    }
    if (v.can.eliminate) {
      body += `<section class="bo-card"><h2>你有排除能力</h2><p class="muted small">可以替工程師目前那一格灰掉兩個錯誤選項。不用也能修好。</p>
        <button class="btn secondary block" data-action="eliminate">使用排除能力（一次）</button></section>`;
    }
    if (!r.panel) {
      const order = r.order
        .map((o) => `<li><span class="slotn">第 ${o.slot + base} 格</span><span>問 ${esc(o.nickname)}</span></li>`)
        .join('');
      body += `<section class="bo-card"><h2>輸入順序</h2><p class="muted small">工程師 ${esc(
        r.engineerNickname,
      )} 會照這個順序一格一格問。</p><ol class="order">${order}</ol></section>`;
    }
  }
  const assist = r
    ? r.assistLevel > 0
      ? `<span class="assist on">協助模式已開啟：部分錯誤選項已灰掉</span>`
      : `<span class="assist">協助模式 <strong data-cd="assist">${mmss(r.assistAt - now())}</strong> 後開啟</span>`
    : '';
  return `<div class="blackout ${ui.noFlicker ? 'no-flicker' : ''}" role="alert">
    <div class="bo-top">
      <span class="bo-code">房號 ${esc(v.code)}・${esc(v.me.nickname)}</span>
      <button class="btn small ghost" data-action="flicker">${ui.noFlicker ? '開啟閃爍' : '關閉閃爍'}</button>
    </div>
    <div class="bo-head">
      <div class="bo-bolt" aria-hidden="true">⚡</div>
      <h1>停電了</h1>
      ${c ? `<h2>${esc(c.title)}</h2><p>${esc(c.text)}</p>${c.extra ? `<p class="bo-extra">${esc(c.extra)}</p>` : ''}` : ''}
    </div>
    ${
      r
        ? `<div class="bo-timer"><div><span class="tb-label">修復倒數</span><strong data-cd="repair">${mmss(
            r.startedAt + r.limitMs - now(),
          )}</strong></div><div><span class="tb-label">進度</span><strong>${r.progress}／${total}</strong></div></div>
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
    .map(
      (s) =>
        `<span class="pill ${s.done ? 'ok' : cur && s.index === cur.index ? 'cur' : ''}">${s.done ? '✓ ' : ''}第 ${s.index + base} 格</span>`,
    )
    .join('');
  if (!cur) {
    return `<section class="bo-card"><h2>全部選好了！</h2><div class="pills">${pills}</div></section>`;
  }
  const opts = cur.options
    .map(
      (o) => `<button class="opt ${o.grayed ? 'gray' : ''}" data-action="pick" data-opt="${esc(o.id)}" ${
        o.grayed ? 'disabled aria-disabled="true"' : ''
      }>${symbolSvg(o.id, { size: 64, title: o.desc })}<span>${esc(o.desc || describeSymbol(o.id))}</span></button>`,
    )
    .join('');
  const wrong = Date.now() < ui.wrongUntil;
  return `<section class="bo-card eng">
    <div class="pills">${pills}</div>
    <h2>第 ${cur.index + base} 格：請問 <span class="ask">${esc(cur.askNickname)}</span></h2>
    <p class="muted small">請隊友描述：外形、幾個缺口、開口朝哪。</p>
    ${wrong ? '<p class="soft-warn" role="status">不是這個，再問問看。</p>' : ''}
    <div class="opts">${opts}</div>
  </section>`;
}

// ───────── 結算 ─────────

function renderResult(v) {
  const res = v.result;
  if (!res) return `${renderTopbar(v)}<main class="screen center"><p class="muted">結算中…</p></main>`;
  const stars =
    res.stars > 0
      ? `<div class="stars" aria-label="${res.stars} 星">${'<span>★</span>'.repeat(res.stars)}</div>`
      : `<p class="handover">另一支救援隊接手了</p>`;
  const served = res.served.length
    ? `<div class="vil ok"><span class="tb-label">送達</span>${res.served.map((x) => `<span class="tag ok">✓ ${esc(x)}</span>`).join('')}</div>`
    : '';
  const unserved = res.unserved.length
    ? `<div class="vil"><span class="tb-label">由另一支救援隊接手</span>${res.unserved
        .map((x) => `<span class="tag">${esc(x)}</span>`)
        .join('')}</div>`
    : '';
  const recap = res.recap
    .map(
      (x) => `<li><p class="ev">${esc(x.event)}</p><blockquote>${esc(x.verse)}<cite>${esc(x.ref)}</cite></blockquote></li>`,
    )
    .join('');
  const others = v.players.filter((p) => p.id !== v.me.id && p.roles.length > 0); // 只有這局的隊員能收感謝卡
  const thankBtns = others
    .map((p) => {
      const on = res.myThanks === p.id;
      return `<button class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-action="thank" data-to="${esc(p.id)}">${
        on ? '♥ ' : ''
      }${esc(p.nickname)}</button>`;
    })
    .join('');
  const thanks = res.thanks.length
    ? `<ul class="thanks">${res.thanks
        .map((t) => `<li>${esc(nickOf(v, t.from))} <span aria-label="謝謝">→</span> ${esc(nickOf(v, t.to))}</li>`)
        .join('')}</ul>`
    : '';
  const action = v.can.next
    ? `<button class="btn primary block" data-action="next">下一局：${esc(res.nextSeedTitle)}</button>`
    : '';
  return `${renderTopbar(v)}
  <main class="screen result">
    <section class="card result-hero">
      <h1>${esc(res.title)}</h1>
      ${stars}
      ${served}${unserved}
      ${res.unserved.length ? '<p class="muted small">沒送到的村，故事裡由另一支救援隊接手。</p>' : ''}
    </section>
    ${recap ? `<section class="card"><h2>這局發生的事</h2><ul class="recap">${recap}</ul></section>` : ''}
    ${
      res.question
        ? `<section class="card"><h2>想聊聊嗎？</h2><p class="lead">${esc(res.question)}</p><p class="muted small">自願回答，想分享再說就好。</p></section>`
        : ''
    }
    <section class="card">
      <h2>感謝卡</h2>
      <p class="muted small">想謝謝哪位隊友？可以跳過，也可以改；再點一次就取消。</p>
      <div class="chips">${thankBtns || '<span class="muted">沒有其他隊友</span>'}</div>
      ${thanks}
    </section>
    ${action ? `<div class="action-bar">${action}</div>` : `<p class="waiting">等房主開始下一局：${esc(res.nextSeedTitle)}</p>`}
  </main>`;
}

// ───────── 旁觀（開局後才加入） ─────────

function renderSpectator(v) {
  const list = v.players
    .map((p) => `<li class="player ${p.connected ? '' : 'off'}"><span class="dot"></span><span class="pname">${esc(p.nickname)}</span></li>`)
    .join('');
  return `${renderTopbar(v)}
  <main class="screen">
    <section class="card"><h2>這局已經開始了</h2><p>你會在下一局加入。先看看大家怎麼合作，也可以幫忙出主意！</p></section>
    <section class="card"><h2>隊員</h2><ul class="players">${list}</ul></section>
  </main>`;
}

// ───────── 放大讓隊友看 ─────────

function renderZoom(v) {
  const roles = v.me.roles.map((r) => `<div class="zoom-role">${esc(r.icon)} ${esc(r.name)}</div>`).join('');
  return `<div class="zoom" role="dialog" aria-modal="true" aria-label="放大的線索">
    <div class="zoom-inner">
      <div class="zoom-nick">${esc(v.me.nickname)}</div>
      ${roles}
      ${v.clues.map((c) => `<div class="zoom-clue"><div class="zoom-title">${esc(c.title)}</div><p>${esc(c.text)}</p></div>`).join('')}
    </div>
    <button class="btn primary block zoom-close" data-action="unzoom">收起來</button>
  </div>`;
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
  // 保留輸入框焦點與游標
  const active = document.activeElement;
  const focusId = active && active.id && root.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  let html;
  if (!v) html = renderHome();
  else if (v.me.spectator && v.phase !== 'lobby' && v.phase !== 'settled' && v.phase !== 'ended') html = renderSpectator(v);
  else {
    switch (v.phase) {
      case 'lobby':
        html = renderLobby(v);
        break;
      case 'intro':
        html = renderIntro(v);
        break;
      case 'planning':
      case 'replanning':
        html = renderPlanning(v);
        break;
      case 'blackout':
        html = renderBlackout(v);
        break;
      case 'settled':
      case 'ended':
        html = renderResult(v);
        break;
      default:
        html = `<main class="screen center"><p class="muted">載入中…</p></main>`;
    }
    if (ui.zoom && v.phase !== 'blackout') html += renderZoom(v);
  }
  root.innerHTML = html;
  document.body.classList.toggle('is-blackout', !!v && v.phase === 'blackout');

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* 有些 input 類型不支援 */
        }
      }
    }
  }
  renderStatus();
}

// 每 250ms 只更新倒數文字，不重畫整頁
setInterval(() => {
  const v = ui.view;
  if (!v) return;
  for (const el of root.querySelectorAll('[data-cd]')) {
    const k = el.getAttribute('data-cd');
    let ms = null;
    if (k === 'round' && v.round) ms = v.round.startedAt + v.round.timeLimitMs - now();
    else if (k === 'intro' && v.round) ms = v.round.startedAt + v.round.introMs - now();
    else if (k === 'repair' && v.repair) ms = v.repair.startedAt + v.repair.limitMs - now();
    else if (k === 'assist' && v.repair) ms = v.repair.assistAt - now();
    if (ms != null) {
      el.textContent = mmss(ms);
      el.classList.toggle('low', ms < 30000 && k !== 'intro');
    }
  }
  // 選錯／輸錯的友善提示時間到就收起
  if ((ui.wrongUntil && Date.now() > ui.wrongUntil) || (ui.floodWrongUntil && Date.now() > ui.floodWrongUntil)) {
    if (Date.now() > ui.wrongUntil) ui.wrongUntil = 0;
    if (Date.now() > ui.floodWrongUntil) ui.floodWrongUntil = 0;
    render();
  }
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
  } else if (kind === 'floodgate') {
    const channel = ui.channel.trim();
    if (!channel) return;
    conn.act({ type: 'floodgate', channel });
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
    case 'intro-tab':
      ui.introTab = el.getAttribute('data-tab');
      render();
      break;
    case 'zoom':
      ui.zoom = true;
      render();
      break;
    case 'unzoom':
      ui.zoom = false;
      render();
      break;
    case 'route':
      conn.act({ type: 'selectRoute', route: el.getAttribute('data-route') });
      break;
    case 'item':
      conn.act({ type: 'setItem', item: el.getAttribute('data-item'), on: el.getAttribute('data-on') === '1' });
      break;
    case 'lock':
      conn.act({ type: 'lock' });
      break;
    case 'depart':
      conn.act({ type: 'depart' });
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
    case 'q-village':
      ui.qVillage = el.getAttribute('data-value');
      ui.qConfirm = false;
      render();
      break;
    case 'q-question':
      ui.qQuestion = el.getAttribute('data-value');
      ui.qConfirm = false;
      render();
      break;
    case 'q-ask':
      ui.qConfirm = true;
      render();
      break;
    case 'q-cancel':
      ui.qConfirm = false;
      render();
      break;
    case 'q-send':
      if (ui.qVillage && ui.qQuestion) conn.act({ type: 'query', village: ui.qVillage, question: ui.qQuestion });
      ui.qConfirm = false;
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

// 長按才顯示符號：按下顯示、放開就隱藏。就地更新按鈕內容，不重畫整頁，避免按住的元素被換掉。
function holdInner(v, slot) {
  const s = v && v.repair ? v.repair.mySymbols.find((x) => String(x.slot) === String(slot)) : null;
  if (!s) return '';
  return `<span class="hold-sym">${symbolSvg(s.id, { size: 150 })}</span><span class="hold-desc">${esc(s.desc || describeSymbol(s.id))}</span>`;
}
const HOLD_COVER = '<span class="hold-cover">按住這裡<br>才會顯示符號</span>';
function setHolding(slot) {
  if (ui.holding === slot) return;
  ui.holding = slot;
  for (const el of root.querySelectorAll('[data-hold]')) {
    const on = slot != null && el.getAttribute('data-hold') === slot;
    el.classList.toggle('show', on);
    el.innerHTML = on ? holdInner(ui.view, slot) : HOLD_COVER;
  }
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-hold]');
  if (!el) return;
  e.preventDefault();
  setHolding(el.getAttribute('data-hold'));
});
for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
  document.addEventListener(t, () => setHolding(null));
}
window.addEventListener('blur', () => setHolding(null));
document.addEventListener('visibilitychange', () => setHolding(null));
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest && e.target.closest('[data-hold]')) e.preventDefault();
});
// 鍵盤：按住空白鍵／Enter 顯示
document.addEventListener('keydown', (e) => {
  const el = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-hold]');
  if (el && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    if (!e.repeat) {
      setHolding(el.getAttribute('data-hold'));
    }
  } else if (e.key === 'Escape' && ui.zoom) {
    ui.zoom = false;
    render();
  }
});
document.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && ui.holding != null) setHolding(null);
});

render();
