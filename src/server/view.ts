// 伺服器 → 手機的「個人化畫面資料」與 WebSocket 協定。前端只照這份資料畫圖，不自己算規則。
// 2026-11-15 v0.7：第一關保羅海難。不是自己能操作的東西不送 can（前端不畫按鈕）。

import type { RoleId, Preference } from './content.ts';
import type { CardId, DialId, ItemId, NeedId, UseId } from '../engine/seeds.ts';
import type { LeaderEntry } from './leaderboard.ts';

/** 手機 → 伺服器 */
export type ClientMessage =
  /** practice：單機試玩（solo.html）開的練習房，不能登記排行榜。 */
  | { t: 'create'; nickname: string; practice?: boolean }
  | { t: 'join'; code: string; nickname: string }
  | { t: 'resume'; playerId: string; token: string }
  | { t: 'pref'; value: Preference | null }
  | { t: 'start' } // 房主；至少 3 人
  | { t: 'act'; id: string; ev: Action } // id：手機產生的唯一代號，重送不會重複執行
  | { t: 'thank'; to: string | null }
  | { t: 'next' } // 房主：再來一局（新的故事卡）
  /** 房主：把這局登記上排行榜（每局一次、練習房不行）。 */
  | { t: 'submitScore'; name: string }
  /** 查排行榜前 10 名（也可以用 HTTP GET /api/leaderboard）。 */
  | { t: 'leaderboard' }
  | { t: 'leave' }
  /** 心跳：每 20 秒一次，讓雲端伺服器保持清醒。 */
  | { t: 'ping' };

export type Action =
  | { type: 'setItem'; item: ItemId; on: boolean }
  | { type: 'lock' }
  | { type: 'repairPick'; option: string }
  | { type: 'useEliminate' }
  | { type: 'use'; use: UseId } // 補好船後：吃飯／拋錨／捆船底（全隊只來得及一件）
  | { type: 'undoUse' } // 按下後 3 秒內本人取消
  | { type: 'depart' };

/** 伺服器 → 手機 */
export type ServerMessage =
  | { t: 'welcome'; playerId: string; token: string; code: string }
  | { t: 'state'; view: View }
  | { t: 'ack'; id: string }
  /** 只送給按的那支手機：這個動作被規則擋下了，附原因與下一步。 */
  | ({ t: 'rejected'; id: string } & Rejection)
  | { t: 'error'; msg: string }
  /** 只送給房主：登記結果（rank＝這一隊現在第幾名；best＝這次是不是這隊最好成績）。 */
  | { t: 'submitted'; name: string; rank: number; best: boolean; bestScore: number }
  | { t: 'leaderboard'; entries: LeaderEntry[]; formula: string; trial: true }
  | { t: 'pong' };

export interface Rejection {
  action: Action['type'];
  reasons: { code: string; text: string }[];
}

export type ViewPhase = 'lobby' | 'intro' | 'planning' | 'blackout' | 'replanning' | 'settled' | 'ended';

export interface CardView {
  id: CardId;
  deck: 'A' | 'B';
  title: string;
  ref: string;
  verse: string;
  effect: string;
  tone: 'good' | 'bad' | 'mixed';
}

export interface MomentView {
  /** 圖：故事卡、東西、三件事、職能、背包、或場景（meal／landing／repair）。 */
  icon: { kind: 'card' | 'item' | 'need' | 'role' | 'pref' | 'scene'; ids: string[] };
  text: string;
}

export interface View {
  code: string;
  joinUrl: string;
  qrSvg: string | null; // 只有大廳時提供
  serverNow: number;
  me: {
    id: string;
    nickname: string;
    isHost: boolean;
    pref: Preference | null;
    roles: { id: RoleId; name: string; icon: string; job: string }[];
    spectator: boolean; // 開局後才加入，等下一局
  };
  players: { id: string; nickname: string; connected: boolean; isHost: boolean; pref: Preference | null; roles: string[]; roleIds: RoleId[] }[];
  phase: ViewPhase;
  round: null | {
    no: number;
    seedId: string;
    seedTitle: string;
    firstRound: boolean;
    startedAt: number; // 伺服器時間
    elapsedMs: number;
    timeLimitMs: number;
    introMs: number;
    lockOpensAt: number; // 伺服器時間
    crisisAt: number; // 伺服器時間：最晚起風暴的時間（含 A2）
  };
  /** 這局的故事（一句＋章節），依階段換。 */
  story: null | { text: string; ref: string };
  /** 這局抽到的故事卡；b 在補好船前為 null。 */
  cards: { a: CardView | null; b: CardView | null };
  /** 全隊共用的船。 */
  ship: null | {
    /** 6 樣東西的狀態：onShip＝還留在船上；gone＝被故事卡、用掉或浪捲走（不在海上也不在船上）；swept＝被浪捲走。 */
    items: { id: ItemId; weight: number; onShip: boolean; gone: boolean; pinned: boolean; swept: boolean }[];
    /** 這局有沒有「風暴捲走」（首局沒有）。 */
    sweep: boolean;
    /** 捲走前 10 秒提醒：風暴幾點來（伺服器時間）、漂著的東西。 */
    sweepWarning: null | { stormAt: number; floating: ItemId[] };
    /** 今晚三件事各靠哪一樣：補好船後才公開（危機前要問隊友）。 */
    provides: Record<NeedId, ItemId> | null;
    weight: number;
    cap: number;
    overweight: number;
    /** 三件事：危機前不顯示亮不亮（null），危機後即時。 */
    needs: { id: NeedId; lit: boolean }[] | null;
    stars: number | null; // 同上
    reasons: string[]; // 中文短句；空＝可以「決定好了」／衝向海灘
    reasonCodes: string[];
    advice: string[]; // 原因＋下一步（依看的人換成「你」或隊友暱稱）
    locked: boolean;
    /** 天亮前用掉的那一件（所有手機播動畫）；at 為伺服器時間。 */
    used: null | { id: UseId; item: ItemId; at: number; by: string; mine: boolean; undoUntil: number };
    dawnAt: number | null; // 伺服器時間：幾點起可以衝向海灘
    lastRejection: null | { at: number; action: Action['type']; reasons: string[] };
  };
  /** 我這局的任務（一句）：給沒有按鈕的人知道自己要做什麼。 */
  myTask: string | null;
  /** 開局下一步：例 { verb: '問', nickname: '大衛', text: '糧食要留嗎？' } */
  nextSteps: { verb: '問' | '告訴' | '找'; nickname: string; text: string }[];
  /** 我能做的操作（只有 true 的才畫按鈕） */
  can: {
    start: boolean;
    items: boolean;
    lock: boolean;
    depart: boolean;
    repair: boolean;
    eliminate: boolean;
    next: boolean;
    /** 房主：可以把這局登記上排行榜（練習房、已登記過＝false）。 */
    submit: boolean;
    /** 我今晚能做的用掉（只有今晚真的做得到、且輪到我的才有）；ready＝那樣東西還在船上。 */
    uses: { id: UseId; label: string; icon: string; ref: string; need: NeedId; item: ItemId; ready: boolean }[];
    /** 我剛用掉，3 秒內可以取消。 */
    undo: boolean;
  };
  /** 我手上的見聞（每局不同）。tag＝「遊戲設定」：遊戲自創的細節，不附章節（DECISIONS 15）。 */
  tonight: { dial: DialId; value: string; title: string; text: string; ref: string | null; verse: string | null; tag: string | null; item: ItemId | null; use: UseId | null }[];
  clues: { title: string; text: string; role: string; when: 'start' | 'power'; item?: ItemId; need?: NeedId; breakthrough?: number; shared?: boolean }[];
  hint: string | null;
  preferenceHint: string | null; // 油燈：例「帶油燈的 小明 可以照亮面板一次。」
  crisis: null | { at: number; cause: 'lock' | 'timeout'; starsBefore: number };
  repair: null | {
    startedAt: number;
    limitMs: number;
    assistAt: number;
    assistLevel: 0 | 1 | 2;
    progress: number;
    done: boolean;
    panel: null | {
      slots: { index: number; askNickname: string; options: { id: string; desc: string; grayed: boolean }[]; done: boolean }[];
    };
    mySymbols: { slot: number; id: string; desc: string }[];
    myEliminationClue: string | null;
    engineerNickname: string;
    order: { slot: number; nickname: string }[];
    wrongFlash: number;
  };
  result: null | {
    stars: 0 | 1 | 2 | 3;
    title: string;
    lit: Record<NeedId, boolean>;
    cause: 'depart' | 'time_up' | 'ended';
    moments: MomentView[];
    bible: string; // 「經文裡」對照
    tonightLine: string; // 「今晚靠的是……」（不指名誰沒說）
    verse: { text: string; ref: string };
    fact: string;
    question: string;
    thanks: { from: string; to: string }[];
    myThanks: string | null;
    /** 團隊分數（試行；伺服器計算）。四項依序：任務成果、合作順暢、時間、難度加成。 */
    score: null | {
      total: number;
      max: number;
      parts: { id: 'mission' | 'teamwork' | 'time' | 'difficulty'; points: number; max: number; detail: string }[];
      factor: number;
      trial: true;
      formula: string;
      /** 練習房：分數照算，但不計入排行榜。 */
      practice: boolean;
      submitted: null | { name: string; rank: number; best: boolean; bestScore: number };
    };
  };
}
