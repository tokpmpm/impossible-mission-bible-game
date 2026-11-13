// WebSocket 連線：自動重連（指數退避，最多 5 秒）、resume、act 去重重送。
// 協定見 src/server/view.ts。

const STORE_KEY = 'impossible-mission.session';

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

/**
 * @param {{
 *   onState: (view: any) => void,
 *   onWelcome: (w: any) => void,
 *   onError: (msg: string, ctx: {duringResume: boolean}) => void,
 *   onStatus: (status: 'connecting'|'open'|'closed') => void,
 * }} handlers
 */
export function createConnection(handlers) {
  let ws = null;
  let attempt = 0;
  let retryTimer = null;
  let queue = []; // 尚未送出的非 act 訊息
  /** @type {Map<string, object>} 已送出、還沒收到 ack 的 act */
  const pendingActs = new Map();
  let resuming = false;
  let stopped = false;

  function url() {
    return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
  }

  function rawSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    handlers.onStatus('connecting');
    try {
      ws = new WebSocket(url());
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      handlers.onStatus('open');
      const s = loadSession();
      if (s) {
        resuming = true;
        rawSend({ t: 'resume', playerId: s.playerId, token: s.token });
      }
      const q = queue;
      queue = [];
      for (const m of q) rawSend(m);
      // 斷線前沒收到 ack 的 act：用同一個 id 重送，伺服器會去重
      for (const m of pendingActs.values()) rawSend(m);
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        saveSession({ playerId: msg.playerId, token: msg.token, code: msg.code });
        handlers.onWelcome(msg);
      } else if (msg.t === 'state') {
        resuming = false;
        handlers.onState(msg.view);
      } else if (msg.t === 'ack') {
        pendingActs.delete(msg.id);
      } else if (msg.t === 'error') {
        const duringResume = resuming;
        resuming = false;
        handlers.onError(msg.msg, { duringResume });
      }
    };
    ws.onclose = () => {
      handlers.onStatus('closed');
      scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose 會接著處理 */
    };
  }

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retryTimer);
    const delay = Math.min(5000, 300 * Math.pow(2, attempt));
    attempt++;
    retryTimer = setTimeout(connect, delay);
  }

  // 回到前景時立刻重試，不用等退避
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState === WebSocket.CLOSED)) {
      attempt = 0;
      connect();
    }
  });

  connect();

  return {
    /** 一般訊息（create/join/pref/start/thank/next/leave）。 */
    send(msg) {
      if (!rawSend(msg)) queue.push(msg);
    },
    /** 遊戲操作：附唯一 id，未 ack 前斷線會重送同一個 id。 */
    act(ev) {
      const id = newId();
      const msg = { t: 'act', id, ev };
      pendingActs.set(id, msg);
      rawSend(msg);
      return id;
    },
    clearPending() {
      pendingActs.clear();
      queue = [];
    },
    isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}
