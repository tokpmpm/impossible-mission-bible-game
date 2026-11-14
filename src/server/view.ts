// 伺服器 → 手機的「個人化畫面資料」與 WebSocket 協定。前端只照這份資料畫圖，不自己算規則。

import type { RoleId, Preference } from './content.ts';

/** 手機 → 伺服器 */
export type ClientMessage =
  | { t: 'create'; nickname: string }
  | { t: 'join'; code: string; nickname: string }
  | { t: 'resume'; playerId: string; token: string }
  | { t: 'pref'; value: Preference | null }
  | { t: 'start' } // 房主；至少 3 人
  | { t: 'act'; id: string; ev: Action } // id：手機產生的唯一代號，重送不會重複執行
  | { t: 'thank'; to: string | null }
  | { t: 'next' } // 房主：下一局（換另一個種子）
  | { t: 'leave' }
  /** 心跳：每 20 秒一次。雲端伺服器一段時間沒收到訊息會被關掉、房間跟著消失，這樣能讓它保持清醒。 */
  | { t: 'ping' };

export type Action =
  | { type: 'selectRoute'; route: '紅' | '藍' | '綠' }
  | { type: 'setItem'; item: string; on: boolean }
  | { type: 'lock' }
  | { type: 'repairPick'; option: string }
  | { type: 'useEliminate' }
  | { type: 'floodgate'; channel: string }
  | { type: 'query'; village: '東村' | '西村' | '北村'; question: 'well' | 'road' | 'needs' }
  | { type: 'depart' };

/** 伺服器 → 手機 */
export type ServerMessage =
  | { t: 'welcome'; playerId: string; token: string; code: string }
  | { t: 'state'; view: View }
  | { t: 'ack'; id: string }
  /** 只送給按的那支手機：這個動作被規則擋下了，附原因與下一步。 */
  | ({ t: 'rejected'; id: string } & Rejection)
  | { t: 'error'; msg: string }
  | { t: 'pong' };

export interface Rejection {
  action: Action['type'];
  /** code：規則代碼（OVERWEIGHT、TOO_EARLY…）；text：原因＋下一步，例「超重 2 kg，請 大衛（補給）放下一樣」。 */
  reasons: { code: string; text: string }[];
}

export type ViewPhase = 'lobby' | 'intro' | 'planning' | 'blackout' | 'replanning' | 'settled' | 'ended';

export interface View {
  code: string;
  joinUrl: string;
  qrSvg: string | null; // 只有大廳時提供
  serverNow: number; // Date.now()，前端用來校正倒數
  me: {
    id: string;
    nickname: string;
    isHost: boolean;
    pref: Preference | null;
    roles: { id: RoleId; name: string; icon: string; job: string }[];
    spectator: boolean; // 開局後才加入，等下一局
  };
  players: { id: string; nickname: string; connected: boolean; isHost: boolean; roles: string[] }[];
  phase: ViewPhase;
  round: null | {
    no: number;
    seedId: string;
    seedTitle: string;
    firstRound: boolean;
    startedAt: number; // 伺服器時間
    elapsedMs: number;
    timeLimitMs: number; // 480000
    introMs: number; // 60000
    lockOpensAt: number; // 伺服器時間；之前可以排方案但不能鎖定
  };
  /** 全隊共用的方案摘要 */
  plan: null | {
    route: null | { id: '紅' | '藍' | '綠'; label: string; travel: number; tool: string | null; closed: boolean };
    routes: { id: '紅' | '藍' | '綠'; label: string; travel: number; tool: string | null; closed: boolean }[];
    items: string[]; // 已裝物資（顯示名稱）
    itemChoices: { id: string; name: string; on: boolean; locked: boolean }[]; // locked＝尚未發放
    weight: number;
    cap: number;
    overweight: number;
    safeWindow: number | null;
    reachable: number; // 可送達村數
    reasons: string[]; // 中文短句，空＝可以出發／鎖定
    reasonCodes: string[]; // 同上，規則代碼（前端用來決定哪一塊要閃、要不要顯示故事時間）
    advice: string[]; // 同上，原因＋下一步（依看的人換成「你」或隊友暱稱）
    locked: boolean;
    /** 最近一次被擋下的鎖定／出發（at 為伺服器時間），讓其他隊友也知道剛剛有人按了。 */
    lastRejection: null | { at: number; action: Action['type']; reasons: string[] };
  };
  /** 各操作的負責人暱稱：按了不是自己的按鈕時，告訴他該去找誰。 */
  operators: null | { route: string; items: string; comms: string; repair: string };
  /** 開局下一步：例 { verb: '問', nickname: '大衛', text: '車子最多能載多重？' } */
  nextSteps: { verb: '問' | '告訴' | '找'; nickname: string; text: string }[];
  /** 我能做的操作（只是入口分工；資訊大家都能看） */
  can: {
    start: boolean;
    route: boolean;
    items: boolean;
    lock: boolean;
    depart: boolean;
    repair: boolean;
    eliminate: boolean;
    floodgate: boolean;
    query: boolean;
    next: boolean;
  };
  /** 我手上的線索（依階段解鎖） */
  clues: { title: string; text: string; role: string; when: 'start' | 'crisis' | 'power'; breakthrough?: number }[];
  hint: string | null; // 2:15 方向提示（只顯示在持有者手機）
  preferenceHint: string | null; // 例如「找隊上的隨性派」
  crisis: null | { title: string; text: string; at: number; cause: 'lock' | 'timeout'; extra: string | null };
  repair: null | {
    startedAt: number; // 伺服器時間
    limitMs: number;
    assistAt: number; // 伺服器時間
    assistLevel: 0 | 1 | 2;
    progress: number;
    done: boolean;
    /** 工程師看到的面板 */
    panel: null | {
      slots: { index: number; askNickname: string; options: { id: string; desc: string; grayed: boolean }[]; done: boolean }[];
    };
    mySymbols: { slot: number; id: string; desc: string }[]; // 長按才顯示
    myEliminationClue: string | null;
    engineerNickname: string;
    order: { slot: number; nickname: string }[];
    wrongFlash: number; // 選錯次數（前端可用來顯示友善提示）
  };
  breakthrough: null | {
    kind: 'floodgate' | 'query';
    done: boolean;
    queryUsed: boolean;
    queryReply: string | null;
    floodgateWrongCount: number;
    questions: { id: 'well' | 'road' | 'needs'; text: string }[];
  };
  result: null | {
    stars: 0 | 1 | 2 | 3;
    title: string; // 3＝驚喜、2＝任務成功、1＝部分救援、0＝另一支救援隊接手
    served: string[];
    unserved: string[];
    cause: 'depart' | 'time_up' | 'ended';
    recap: { verse: string; ref: string; event: string }[]; // 真實事件配經節
    question: string; // 可自願回答的破冰問題
    thanks: { from: string; to: string }[]; // 只顯示誰謝了誰，不計票
    myThanks: string | null; // 我謝了誰（playerId）
    nextSeedTitle: string;
  };
}
