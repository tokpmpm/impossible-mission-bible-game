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
  note: null, // 底部按鈕上方的非模態提示：{ kind, title, lines, until }
  flash: null, // 被擋下時閃一下的區塊：{ blocks: Set, until }
  folds: new Set(), // 展開了哪些「別人負責」的區塊
  guide: null, // 第一局每階段開頭的一句導引：{ phase, at, mini }
  lockOpen: null, // 上次畫面時是否已過認識隊友時間（跨過時重畫）
};

// 規則代碼 → 被擋下時要閃一下的區塊
const FLASH_BLOCK = {
  OVERWEIGHT: 'items',
  NO_NEEDS: 'items',
  NOT_RELEASED: 'items',
  NO_ROUTE: 'route',
  ROAD_CLOSED: 'route',
  TOO_LATE: 'route',
  GREEN_NOT_LOCKABLE: 'route',
};
const ACTION_LABEL = { lock: '鎖定方案', depart: '出發' };

// 第一局每階段開頭的一句導引（3 秒後縮小）
const GUIDE = {
  intro: '先認識隊友：看看你是誰、知道什麼，再照「下一步」去找隊友聊。',
  planning: '一起排方案：選路線、裝物資，排好就按「鎖定方案」。',
  blackout: '停電了！工程師看不到符號：按住你的符號，說給工程師聽。',
  replanning: '電來了！看看新線索、重新排方案，好了就按「出發」。',
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

/** 底部按鈕上方的提示（不擋畫面、不捲動）。 */
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
    trackFlashes(view);
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
  ui.note = null;
  const v = ui.view;
  ui.guide = v && v.round && v.round.firstRound && GUIDE[next] ? { phase: next, at: Date.now(), mini: false } : null;
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
  // 遊戲進行中：倒數放在頂端同一列，省下一整塊空間
  const live = v.round && ['intro', 'planning', 'replanning'].includes(v.phase);
  const cd = live
    ? `<div class="tb-cd" role="timer"><span class="tb-label">剩下</span><strong data-cd="round">${mmss(v.round.startedAt + v.round.timeLimitMs - now())}</strong></div>`
    : '';
  return `<header class="topbar ${live ? 'live' : ''}">
    <div class="tb-room"><span class="tb-label">房號</span><strong>${esc(v.code)}</strong></div>
    <div class="tb-me"><span class="tb-nick">${esc(v.me.nickname)}</span>${live ? '' : roleChips(v)}</div>
    ${cd}${leave}
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

function guideLine(phase) {
  const g = ui.guide;
  if (!g || g.phase !== phase) return '';
  return `<div class="guide ${g.mini ? 'mini' : ''}" role="status">${esc(GUIDE[phase])}</div>`;
}

function lockOpen(v) {
  // 以伺服器說「認識隊友時間結束」為準（phase 不再是 intro），手機時鐘快一點也不會誤報可以鎖定
  return !!v.round && v.phase !== 'intro';
}

/** 底部固定列：提示（被擋下／不是你的按鈕）＋常駐狀態＋主按鈕。 */
function actionBar(v, button) {
  const n = ui.note && Date.now() < ui.note.until ? ui.note : null;
  const note = n
    ? `<div class="bar-note ${n.kind}" role="alert">
        <div class="bar-note-head"><strong>${esc(n.title)}</strong><button class="note-x" data-action="note-close" aria-label="關閉提示">✕</button></div>
        ${n.lines.length > 1 ? `<ul>${n.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : n.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
      </div>`
    : '';
  return `<div class="action-bar stack">${note}${statusLine(v)}${button}</div>`;
}

function statusLine(v) {
  const p = v.plan;
  if (!p) return '';
  const planning = v.phase === 'planning' || v.phase === 'intro';
  const open = lockOpen(v);
  const over = p.overweight > 0;
  const okNow = p.reasons.length === 0 && (!planning || open);
  let main;
  if (okNow) {
    main = `<span class="sl-ok">${planning ? '可以鎖定了 ✓' : '可以出發了 ✓'}</span><span class="sl-sep">｜</span><span>可送 ${p.reachable} 村</span>`;
  } else {
    const route = p.route ? `${p.route.id}線${p.route.closed ? '（斷了）' : ''}` : '還沒選路線';
    main = `<span>${esc(route)}</span><span class="sl-sep">｜</span><span>${p.weight}／${p.cap} kg${over ? ' 超重' : ''}</span><span class="sl-sep">｜</span><span>可送 ${p.reachable} 村</span>`;
  }
  let sub = '';
  if (planning && !open && v.round) {
    sub = `<div class="status-sub">認識隊友中，<strong data-cd="lock">${mmss(v.round.lockOpensAt - now())}</strong> 後才能鎖定（方案可以先排）</div>`;
  } else if (!okNow && p.advice && p.advice.length) {
    const rej = p.lastRejection;
    const recent = rej && now() - rej.at < 20000 && ACTION_LABEL[rej.action];
    const more = p.advice.length > 1 ? `（還有 ${p.advice.length - 1} 件）` : '';
    sub = `<div class="status-sub advice">${recent ? `剛剛按了「${ACTION_LABEL[rej.action]}」，還不行：` : '還差：'}${esc(p.advice[0])}${more}</div>`;
  }
  return `<div class="status-line ${over ? 'bad' : ''} ${okNow ? 'ok' : ''}" data-block="status" data-lock-open="${open ? '1' : '0'}" aria-live="polite">
    <div class="sl-main">${main}</div>${sub}</div>`;
}

/** 按了不是自己負責的按鈕：告訴他該找誰。 */
function notMine(v, what, roleName, nick) {
  if (!nick) return;
  showNote('info', `${what}要 ${nick}（${roleName}）來按`, [`去告訴 ${nick} 你的想法，或把手機拿給對方看。`], 6000);
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
    ${
      v.me.isHost
        ? `<section class="card join-card">
      <div class="big-code"><span class="tb-label">房號</span><strong>${esc(v.code)}</strong></div>
      ${v.qrSvg ? `<div class="qr">${v.qrSvg}</div>` : ''}
      <p class="join-url">${esc(v.joinUrl)}</p>
      <p class="muted small">請大家用手機相機掃描，或輸入房號加入。入房不計時。</p>
    </section>`
        : `<section class="card joined">
      <div class="big-code small-code"><span class="tb-label">你已加入房間</span><strong>${esc(v.code)}</strong></div>
      <details class="invite"><summary>還有人要加入？點這裡顯示 QR Code</summary>
        ${v.qrSvg ? `<div class="qr">${v.qrSvg}</div>` : ''}<p class="join-url">${esc(v.joinUrl)}</p>
      </details>
    </section>`
    }
    <section class="card howto">
      <h2>怎麼玩</h2>
      ${v.me.isHost ? '<p class="muted small">你是房主，可以直接念給大家聽：</p>' : ''}
      <ol class="howto-list">
        <li>我們是救援隊，要在 8 分鐘內把物資送到三個村。</li>
        <li>每個人手機上只看得到一部分情報，要開口問隊友、互相看手機。</li>
        <li>中途會停電，大家要一起描述符號，幫工程師修好電力。</li>
      </ol>
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

// ───────── 規劃／重新規劃（含開局 60 秒）：一個畫面看完，不切分頁、不用捲來捲去 ─────────

function renderIntro(v) {
  return renderPlanning(v);
}

/** 頂端一條提示：只放此刻最重要的一件事。 */
function banners(v) {
  const out = [];
  if (v.hint) out.push(`<div class="banner hint" role="status"><span aria-hidden="true">💡</span> ${esc(v.hint)}</div>`);
  if (v.phase === 'replanning' && v.crisis) {
    out.push(`<div class="banner crisis"><strong>${esc(v.crisis.title)}</strong> 電來了，重新排方案！</div>`);
  }
  if ((v.phase === 'intro' || v.phase === 'planning') && (v.nextSteps || []).length) {
    const steps = v.nextSteps
      .slice(0, 1) // 一次只給一件事，聊完再看線索
      .map((st) => `<span class="ns">去${esc(st.verb)} <strong class="ns-nick">${esc(st.nickname)}</strong>：${esc(st.text)}</span>`)
      .join('');
    out.push(`<div class="banner next-step"><span class="banner-k">下一步</span>${steps}</div>`);
  }
  return out.slice(0, 2).join('');
}

function routeButtons(v) {
  const p = v.plan;
  return p.routes
    .map((r) => {
      const st = ROUTE_STYLE[r.id] || {};
      const sel = p.route && p.route.id === r.id;
      const [name, place] = String(r.label).split('・');
      // 不再 disabled：不是你負責的也能按，按了會告訴你該找誰
      return `<button class="rt ${st.cls || ''} ${sel ? 'sel' : ''} ${r.closed ? 'closed' : ''}" data-action="route" data-route="${esc(r.id)}" ${
        v.can.route ? 'data-mine="1"' : ''
      } aria-pressed="${sel}">
        <span class="rt-top"><span class="rmark ${st.cls || ''}" aria-hidden="true">${st.mark || ''}</span><b>${esc(name)}</b>${sel ? '<span class="rt-ok">✓</span>' : ''}</span>
        <span class="rt-sub">${esc(place || '')}・${r.travel} 分</span>
        <span class="rt-sub">${r.closed ? '✕ 封閉' : r.tool ? `帶${esc(r.tool)}` : '不用工具'}</span>
      </button>`;
    })
    .join('');
}

function itemButtons(v) {
  return v.plan.itemChoices
    .map(
      (it) => `<button class="chip item ${it.on ? 'on' : ''} ${it.locked ? 'locked' : ''}" data-action="item" data-item="${esc(it.id)}" data-on="${
        it.on ? '0' : '1'
      }" ${it.locked ? 'data-locked="1"' : ''} ${v.can.items ? 'data-mine="1"' : ''} aria-pressed="${it.on}">
        <span class="chk" aria-hidden="true">${it.on ? '✓' : it.locked ? '…' : '＋'}</span>${esc(it.name)}${it.locked ? '<small>未發放</small>' : ''}</button>`,
    )
    .join('');
}

/** 全隊共用的方案板：每個人看到的一樣，自己負責的那一列標「你負責」。 */
function planBoard(v) {
  const p = v.plan;
  if (!p) return '';
  const ops = v.operators || {};
  const who = (mine, nick) => (mine ? '<span class="tag gold">你負責</span>' : `<span class="who">${esc(nick || '隊友')} 負責</span>`);
  const tooLate = (p.reasonCodes || []).includes('TOO_LATE');
  const story = tooLate
    ? `<div class="story" data-block="story">路程 <strong>${p.route ? p.route.travel : '—'}</strong> 分，洪水 <strong>${
        p.safeWindow ?? '—'
      }</strong> 分就到——來不及（故事時間，和房間倒數無關）</div>`
    : '';
  return `<section class="card board">
    <div class="board-row ${v.can.route ? 'mine' : ''}" data-block="route">
      <div class="row-head"><span class="row-k">路線</span>${who(v.can.route, ops.route)}</div>
      <div class="rt-grid">${routeButtons(v)}</div>
    </div>
    <div class="board-row ${v.can.items ? 'mine' : ''}" data-block="items">
      <div class="row-head"><span class="row-k">物資</span>${who(v.can.items, ops.items)}<span class="load-k ${p.overweight > 0 ? 'over' : ''}">${p.weight}／${p.cap} kg</span></div>
      <div class="chips tight">${itemButtons(v)}</div>
    </div>
    ${story}
  </section>`;
}

/** 我知道的：你是誰＋線索，全部攤開、字小一點但不收合。 */
function clueBox(v) {
  const roles = v.me.roles.map((r) => `${esc(r.icon)}<strong>${esc(r.name)}</strong>`).join('・');
  // 偏好能力只在停電時有用，留到停電畫面再講，規劃時不佔版面
  // 危機後：新線索放最上面，開局就知道的舊線索字小一點（都還在，不收起來）
  const fresh = v.crisis ? v.clues.filter((c) => c.when !== 'start') : [];
  const old = v.crisis ? v.clues.filter((c) => c.when === 'start') : v.clues;
  const items = [
    ...fresh.map((c) => `<li class="new"><strong>${esc(c.title)}</strong> ${esc(c.text)}</li>`),
    ...old.map((c) => `<li class="${v.crisis ? 'old' : ''}"><strong>${esc(c.title)}</strong> ${esc(c.text)}</li>`),
  ];
  return `<section class="card clues">
    <div class="sum-head"><span class="me-line">你是 ${roles || '隊員'}</span><button class="btn tiny ghost" data-action="zoom">🔍 放大</button></div>
    <ul class="clue-list">${items.join('') || '<li class="muted">目前還沒有線索。</li>'}</ul>
  </section>`;
}

function planningBody(v) {
  const bt = breakthroughCard(v);
  return `${banners(v)}${bt}${planBoard(v)}${clueBox(v)}`;
}

function renderPlanning(v) {
  let action = '';
  if ((v.phase === 'planning' || v.phase === 'intro') && v.can.lock) {
    action = `<button class="btn primary block" data-action="lock">鎖定方案</button>`;
  } else if (v.phase === 'replanning' && v.can.depart) {
    action = `<button class="btn primary block" data-action="depart">出發！</button>`;
  }
  return `${renderTopbar(v)}
  <main class="screen planning">${planningBody(v)}
    ${action ? actionBar(v, action) : ''}
  </main>`;
}

function breakthroughCard(v) {
  const b = v.breakthrough;
  if (!b || v.phase !== 'replanning') return '';
  if (b.kind === 'floodgate') {
    if (b.done) {
      return `<div class="banner ok">分洪閘門已啟動：上游的水被引開了，洪水會晚一點到。</div>`;
    }
    if (!v.can.floodgate) return '';
    const wrong = Date.now() < ui.floodWrongUntil;
    return `<section class="card bt compact">
      <div class="bt-k">分洪閘門・要輸入授權頻道，誰知道？</div>
      <form class="row" data-form="floodgate">
        <label class="sr" for="in-channel">授權頻道</label>
        <input id="in-channel" data-model="channel" value="${esc(ui.channel)}" autocomplete="off" placeholder="授權頻道" required>
        <button class="btn secondary" type="submit">啟動</button>
      </form>
      ${wrong ? '<p class="soft-warn" role="status">頻道沒有對上，再問問隊友，可以再試。</p>' : ''}
    </section>`;
  }
  // seed 002：詢問
  if (b.queryReply) {
    return `<div class="banner ok">${esc(b.queryReply)}</div>`;
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
    <h2>對外聯絡：向一個村發詢問</h2>
    <p class="muted small">只有一次機會，先聽聽隊友怎麼說。</p>
    <div class="label">問哪個村</div><div class="chips">${vill}</div>
    <div class="label">問什麼</div><div class="chips">${qs}</div>
    ${send}
  </section>`;
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
          <h2>第 ${s.slot + base} 格的符號在你手上</h2>
          <p>按住看清楚，用說的讓工程師 <strong>${esc(r.engineerNickname)}</strong> 找出來。</p>
          <button class="hold ${show ? 'show' : ''}" data-hold="${s.slot}" ${show ? `data-sym="${esc(s.id)}"` : ''} aria-label="按住顯示第 ${s.slot + base} 格符號">
            ${show ? holdInner(v, s.slot) : HOLD_COVER}
          </button>
          <p class="muted small">放開就藏起來。像什麼形狀？缺口在哪？開口朝哪邊？</p>
        </section>`;
        })
        .join('');
    }
    if (r.myEliminationClue) {
      body += `<section class="bo-card"><h2>你的排除線索</h2><p class="lead">${esc(r.myEliminationClue)}</p>
        <p class="muted small">告訴工程師 ${esc(r.engineerNickname)}，幫他刪掉不可能的選項。</p></section>`;
    }
    if (!v.can.eliminate && !r.panel && v.preferenceHint) {
      body += `<p class="bo-pref">${esc(v.preferenceHint)}</p>`;
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
      ? `<span class="assist on">協助模式：部分錯誤選項已灰掉，也會顯示文字說明</span>`
      : `<span class="assist">協助模式 <strong data-cd="assist">${mmss(r.assistAt - now())}</strong> 後開啟</span>`
    : '';
  // 精簡版：一行標題＋一行故事＋一行倒數，把空間留給符號
  return `<div class="blackout ${ui.noFlicker ? 'no-flicker' : ''}" role="alert">
    ${guideLine('blackout')}
    <div class="bo-head">
      <h1><span class="bo-bolt" aria-hidden="true">⚡</span> 停電了${c ? `・${esc(c.title)}` : ''}</h1>
      <button class="btn tiny ghost" data-action="flicker" aria-label="${ui.noFlicker ? '開啟閃爍' : '關閉閃爍'}">${ui.noFlicker ? '閃爍：關' : '閃爍：開'}</button>
    </div>
    ${c ? `<p class="bo-story">${esc(c.text)}${c.extra ? ` <span class="bo-extra">${esc(c.extra)}</span>` : ''}</p>` : ''}
    ${
      r
        ? `<div class="bo-timer"><span>修復 <strong data-cd="repair">${mmss(r.startedAt + r.limitMs - now())}</strong></span><span>進度 <strong>${
            r.progress
          }／${total}</strong></span></div>
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
      }>${symbolSvg(o.id, { size: 64, title: '選項' })}${r.assistLevel > 0 ? `<span>${esc(o.desc || describeSymbol(o.id))}</span>` : ''}</button>`,
    )
    .join('');
  const wrong = Date.now() < ui.wrongUntil;
  return `<section class="bo-card eng">
    <div class="pills">${pills}</div>
    <h2>第 ${cur.index + base} 格：請問 <span class="ask">${esc(cur.askNickname)}</span></h2>
    <p class="muted small">只看得到圖：請隊友形容他的符號，你來找。</p>
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
    ${action ? `<div class="action-end">${action}</div>` : `<p class="waiting">等房主開始下一局：${esc(res.nextSeedTitle)}</p>`}
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
    else if (k === 'lock' && v.round) ms = v.round.lockOpensAt - now();
    if (ms != null) {
      el.textContent = mmss(ms);
      el.classList.toggle('low', ms < 30000 && k !== 'intro' && k !== 'lock');
    }
  }
  let redraw = false;
  // 認識隊友時間一到，狀態列換成「可以鎖定了」
  if (v.round && ui.lockOpen === false && lockOpen(v)) redraw = true;
  // 導引 3 秒後縮小；提示時間到就收起
  if (ui.guide && !ui.guide.mini && Date.now() - ui.guide.at > 3000) {
    // 只改這一行的樣式，不重畫整頁（停電時大家正按著符號）
    ui.guide.mini = true;
    for (const el of root.querySelectorAll('.guide')) el.classList.add('mini');
  }
  if (ui.note && Date.now() > ui.note.until) {
    ui.note = null;
    redraw = true;
  }
  if (redraw) render();
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
    case 'route': {
      if (!v || !v.can.route) {
        notMine(v, '選路線', '導航', v && v.operators && v.operators.route);
        break;
      }
      const r = v.plan && v.plan.routes.find((x) => x.id === el.getAttribute('data-route'));
      if (r && r.closed) {
        showNote('info', `${r.label}封閉了`, ['這條路現在不能走，換一條看看。'], 6000);
        break;
      }
      conn.act({ type: 'selectRoute', route: el.getAttribute('data-route') });
      break;
    }
    case 'item':
      if (!v || !v.can.items) {
        notMine(v, '裝物資', '補給', v && v.operators && v.operators.items);
        break;
      }
      conn.act({ type: 'setItem', item: el.getAttribute('data-item'), on: el.getAttribute('data-on') === '1' });
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

// 「別人負責」的區塊展開／收起：記住狀態，重畫時保持
document.addEventListener(
  'toggle',
  (e) => {
    const el = e.target;
    const k = el && el.getAttribute && el.getAttribute('data-fold');
    if (!k) return;
    if (el.open) ui.folds.add(k);
    else ui.folds.delete(k);
  },
  true,
);

// 長按才顯示符號：按下顯示、放開就隱藏。就地更新按鈕內容，不重畫整頁，避免按住的元素被換掉。
function holdInner(v, slot) {
  const s = v && v.repair ? v.repair.mySymbols.find((x) => String(x.slot) === String(slot)) : null;
  if (!s) return '';
  // 描述型修復：平常只給圖，要自己想辦法形容；協助模式才附文字
  const assist = v.repair.assistLevel > 0;
  return `<span class="hold-sym">${symbolSvg(s.id, { size: 150, title: '你的符號' })}</span>${
    assist ? `<span class="hold-desc">${esc(s.desc || describeSymbol(s.id))}</span>` : ''
  }`;
}
const HOLD_COVER = '<span class="hold-cover">按住這裡<br>才會顯示符號</span>';
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
