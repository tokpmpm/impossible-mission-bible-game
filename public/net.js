// WebSocket 連線：自動重連（指數退避，最多 5 秒）、resume、會改變狀態的訊息都去重重送。
// 2026-11-22 連線加強（docs/16）：心跳逾時（25 秒沒收到任何東西＝連線已死，馬上重連）、連線逾時（6 秒沒接通就重來）、
// 回前景／網路恢復時立刻檢查連線、房間不見（ROOM_GONE）交給畫面處理。
// 協定見 src/server/view.ts。

// ?seat=N：單機試玩（solo.html）時，同一個瀏覽器裡每一格各自是一位玩家。
const SEAT = new URLSearchParams(location.search).get('seat');
const STORE_KEY = 'impossible-mission.session' + (SEAT ? '.' + SEAT.replace(/[^0-9a-z]/gi, '') : '');

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.playerId && s.token) return s;
  } catch {
    /* 私密模式或被封鎖：當作沒有 session */
  }
  return null;
}

export function saveSession(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* 存不了就算了，只是重新整理後要重新加入 */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 忽略 */
  }
}

export function newId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 非安全環境（http 區網）可能沒有 randomUUID */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 連線多久沒接通就放棄重來（iOS 回前景後新連線可能永遠卡在「連線中」，WebKit bug 308073）。 */
export const CONNECT_TIMEOUT_MS = 6000;
/** 多久沒收到任何訊息就當作連線已死（網路換手後的「假連線」）。 */
export const SILENCE_MS = 25000;
/** 心跳間隔。 */
export const PING_MS = 10000;
/** 回前景時，連線超過這麼久沒動靜就先試探一下。 */
const STALE_ON_RETURN_MS = 15000;
/** 試探多久沒回應就換一條新連線。 */
const PROBE_MS = 3000;
/** 會改變狀態的一般訊息：帶 mid，伺服器回 ack 前斷線會重送同一個 mid（伺服器去重）。 */
const RELIABLE = new Set(['pref', 'start', 'next', 'vote', 'thank', 'submitScore']);

/**
 * @param {{
 *   onState: (view: any) => void,
 *   onWelcome: (w: any) => void,
 *   onError: (msg: string, ctx: {duringResume: boolean, code?: string, for?: string}) => void,
 *   onStatus: (status: 'connecting'|'open'|'closed', info: {downSince: number|null, timeouts: number}) => void,
 *   onPending?: (n: number) => void,
 *   onSubmitted?: (m: {name: string, rank: number, best: boolean, bestScore: number}) => void,
 *   onLeaderboard?: (m: {entries: any[], formula: string}) => void,
 *   onRejected?: (r: {id: string, action: string, reasons: {code: string, text: string}[]}) => void,
 * }} handlers
 */
export function createConnection(handlers) {
  /** @type {WebSocket|null} */
  let ws = null;
  let gen = 0; // 每條連線的流水號：舊連線晚到的事件一律忽略
  let attempt = 0;
  let retryTimer = null;
  let connectTimer = null;
  let probeTimer = null;
  let queue = []; // 還沒送出的一般訊息（create/join/leave/leaderboard…）
  /** @type {Map<string, object>} 已送出、還沒收到 ack 的 act 與可靠訊息 */
  const pending = new Map();
  let resuming = false;
  let stopped = false;
  let lastRx = 0;
  /** @type {number|null} 從什麼時候開始沒連上（連上時是 null） */
  let downSince = Date.now();
  let timeouts = 0; // 連續連線逾時幾次（畫面用來決定要不要給「重新整理」按鈕）

  function url() {
    return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
  }

  function status(s) {
    handlers.onStatus(s, { downSince, timeouts });
  }

  function pendingChanged() {
    if (handlers.onPending) handlers.onPending(pending.size);
  }

  function isOpen() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  function rawSend(msg) {
    if (isOpen()) {
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** 放掉目前這條連線，不等它慢慢關（假連線的關閉握手可能卡好幾分鐘）。 */
  function drop() {
    const s = ws;
    ws = null;
    gen++;
    clearTimeout(connectTimer);
    clearTimeout(probeTimer);
    if (downSince === null) downSince = Date.now();
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 送出排隊中的一般訊息與還沒 ack 的訊息（resume 成功或不需要 resume 之後）。 */
  function flushOut() {
    const q = queue;
    queue = [];
    for (const m of q) if (!rawSend(m)) queue.push(m);
    // 斷線前沒收到 ack 的：用同一個 id 重送，伺服器會去重
    for (const m of pending.values()) rawSend(m);
  }

  function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    const my = ++gen;
    status('connecting');
    let sock;
    try {
      sock = new WebSocket(url());
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;
    connectTimer = setTimeout(() => {
      if (my !== gen || sock.readyState !== WebSocket.CONNECTING) return;
      timeouts++;
      drop();
      status('closed');
      scheduleRetry(300); // 已經等了 6 秒，不再加退避
    }, CONNECT_TIMEOUT_MS);
    sock.onopen = () => {
      if (my !== gen) return;
      clearTimeout(connectTimer);
      attempt = 0;
      timeouts = 0;
      lastRx = Date.now();
      downSince = null;
      status('open');
      const s = loadSession();
      if (s) {
        // 先回到原本的房間，成功（welcome）後才補送其他訊息，免得被當成「還沒加入房間」
        resuming = true;
        rawSend({ t: 'resume', playerId: s.playerId, token: s.token });
      } else {
        resuming = false;
        flushOut();
      }
    };
    sock.onmessage = (e) => {
      if (my !== gen) return;
      lastRx = Date.now();
      clearTimeout(probeTimer);
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        saveSession({ playerId: msg.playerId, token: msg.token, code: msg.code });
        const wasResuming = resuming;
        resuming = false;
        handlers.onWelcome(msg);
        if (wasResuming) flushOut();
      } else if (msg.t === 'state') {
        handlers.onState(msg.view);
      } else if (msg.t === 'rejected') {
        // 只有按的那支手機會收到：這個動作被規則擋下了
        if (handlers.onRejected) handlers.onRejected(msg);
      } else if (msg.t === 'ack') {
        if (pending.delete(msg.id)) pendingChanged();
      } else if (msg.t === 'submitted') {
        if (handlers.onSubmitted) handlers.onSubmitted(msg);
      } else if (msg.t === 'leaderboard') {
        if (handlers.onLeaderboard) handlers.onLeaderboard(msg);
      } else if (msg.t === 'error') {
        const duringResume = resuming;
        if (duringResume) {
          resuming = false;
          if (msg.code === 'ROOM_GONE') {
            // 房間不在了：還沒送出的遊戲訊息都沒有意義了
            pending.clear();
            pendingChanged();
          }
          flushOut();
        }
        handlers.onError(msg.msg, { duringResume, code: msg.code, for: msg.for });
      }
    };
    sock.onclose = () => {
      if (my !== gen) return;
      ws = null;
      clearTimeout(connectTimer);
      clearTimeout(probeTimer);
      if (downSince === null) downSince = Date.now();
      status('closed');
      scheduleRetry();
    };
    sock.onerror = () => {
      /* onclose 會接著處理 */
    };
  }

  function scheduleRetry(delay) {
    if (stopped) return;
    clearTimeout(retryTimer);
    const d = delay ?? Math.min(5000, 300 * Math.pow(2, attempt));
    attempt++;
    retryTimer = setTimeout(connect, d);
  }

  /** 馬上換一條新連線（不等退避）。 */
  function reconnectNow() {
    drop();
    status('closed');
    attempt = 0;
    connect();
  }

  /**
   * 回前景、網路恢復、從上一頁快取回來時：確認連線真的活著。
   * 沒連著＝立刻重連；連著但很久沒動靜＝送 ping 試探，3 秒沒回應就換新連線。
   */
  function ensureFresh() {
    if (stopped) return;
    if (!ws) {
      attempt = 0;
      connect();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) return; // 連線逾時會處理
    if (ws.readyState !== WebSocket.OPEN) return reconnectNow();
    if (Date.now() - lastRx < STALE_ON_RETURN_MS) return;
    rawSend({ t: 'ping' });
    clearTimeout(probeTimer);
    const my = gen;
    probeTimer = setTimeout(() => {
      if (my === gen && Date.now() - lastRx >= PROBE_MS) reconnectNow();
    }, PROBE_MS);
  }

  /** 回到畫面上：斷線秒數從現在算（不然一打開就看到「斷了 30 秒＋重新整理」），再檢查連線。 */
  function onReturn() {
    if (!isOpen() && downSince !== null) {
      downSince = Date.now();
      timeouts = 0;
    }
    ensureFresh();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onReturn();
  });
  window.addEventListener('online', ensureFresh);
  window.addEventListener('focus', ensureFresh);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) onReturn();
  });
  document.addEventListener('resume', onReturn); // Chrome：頁面從凍結恢復

  // 心跳：每 10 秒送一次（伺服器 45 秒沒收到就當你斷線）；25 秒沒收到任何東西＝這條連線已死，馬上換一條
  setInterval(() => {
    if (!isOpen()) return;
    if (Date.now() - lastRx > SILENCE_MS) return reconnectNow();
    rawSend({ t: 'ping' });
  }, PING_MS);
  // 背景時計時器會被瀏覽器放慢；另外每 2 秒檢查一次沉默時間，回前景後能更快發現
  setInterval(() => {
    if (isOpen() && Date.now() - lastRx > SILENCE_MS) reconnectNow();
  }, 2000);

  connect();

  return {
    /** 一般訊息。會改變狀態的（pref/start/next/vote/thank/submitScore）自動帶 mid、沒 ack 前斷線會重送。 */
    send(msg) {
      if (RELIABLE.has(msg.t)) {
        const mid = newId();
        const m = { ...msg, mid };
        pending.set(mid, m);
        pendingChanged();
        if (!resuming) rawSend(m);
        return mid;
      }
      if (resuming || !rawSend(msg)) queue.push(msg);
      return null;
    },
    /** 遊戲操作：附唯一 id，未 ack 前斷線會重送同一個 id。 */
    act(ev) {
      const id = newId();
      const msg = { t: 'act', id, ev };
      pending.set(id, msg);
      pendingChanged();
      if (!resuming) rawSend(msg);
      return id;
    },
    clearPending() {
      pending.clear();
      queue = [];
      pendingChanged();
    },
    isOpen,
    /** 還有幾個訊息等著送出（沒收到 ack）。 */
    pendingCount() {
      return pending.size;
    },
    reconnectNow,
  };
}
