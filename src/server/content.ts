// 職能、各人數的職能組合、每個種子的職能線索、結尾經文。
// 這些是內容資料（暫定，未經真人試玩），不是規則；規則在 src/engine。
import type { SeedId } from '../engine/seeds.ts';

export type RoleId = 'nav' | 'supply' | 'comms' | 'eng' | 'medic' | 'observer' | 'scout' | 'liaison' | 'store' | 'backup';

export const ROLES: Record<RoleId, { name: string; icon: string; job: string }> = {
  nav: { name: '導航', icon: '🧭', job: '選路線' },
  supply: { name: '補給', icon: '📦', job: '把物資裝上車' },
  comms: { name: '通訊', icon: '📡', job: '掌握村莊需求，負責對外聯絡' },
  eng: { name: '工程', icon: '🔧', job: '停電時修好備援電力' },
  medic: { name: '醫護', icon: '🩺', job: '判斷誰最急' },
  observer: { name: '觀測', icon: '🔭', job: '看天氣和洪水' },
  scout: { name: '道路偵察', icon: '🥾', job: '掌握危機後的路況' },
  liaison: { name: '村民聯絡', icon: '🏘️', job: '掌握各村最新的優先順序' },
  store: { name: '倉儲管理', icon: '🗄️', job: '掌握工具的重量' },
  backup: { name: '備援觀察', icon: '💡', job: '協助判讀修復面板' },
};

/** 01-GAME_DESIGN 的 3–10 人職能組合。 */
export const ROLE_BUNDLES: Record<number, RoleId[][]> = {
  3: [['nav', 'observer'], ['supply', 'medic'], ['comms', 'eng']],
  4: [['nav', 'observer'], ['supply'], ['comms', 'medic'], ['eng']],
  5: [['nav'], ['supply'], ['comms'], ['eng'], ['medic', 'observer']],
  6: [['nav'], ['supply'], ['comms'], ['eng'], ['medic'], ['observer']],
  7: [['nav'], ['supply'], ['comms'], ['eng'], ['medic'], ['observer'], ['scout']],
  8: [['nav'], ['supply'], ['comms'], ['eng'], ['medic'], ['observer'], ['scout'], ['liaison']],
  9: [['nav'], ['supply'], ['comms'], ['eng'], ['medic'], ['observer'], ['scout'], ['liaison'], ['store']],
  10: [['nav'], ['supply'], ['comms'], ['eng'], ['medic'], ['observer'], ['scout'], ['liaison'], ['store'], ['backup']],
};

/** 拆出的職能不在場時，資訊回到原職能。 */
export const SPLIT_FROM: Partial<Record<RoleId, RoleId>> = {
  scout: 'nav',
  liaison: 'comms',
  store: 'supply',
  backup: 'eng',
};

export type ClueWhen = 'start' | 'crisis' | 'power';

export interface Clue {
  role: RoleId;
  when: ClueWhen; // start＝開局就有；crisis＝危機後；power＝恢復供電後（突破口；標題刻意不寫「突破口」，讓三星保持隱藏）
  title: string;
  text: string;
  breakthrough?: 1 | 2 | 3; // 突破口第幾段
  /** 恢復供電後就用不到的線索（講停電怎麼修的），之後收起來，畫面才放得下新線索。 */
  untilPower?: boolean;
}

export const CLUES: Record<SeedId, Clue[]> = {
  'seed 001': [
    { role: 'nav', when: 'start', title: '路線', text: '紅線吊橋 3 分鐘，要帶繩子；藍線隧道 4 分鐘，要帶燈具；綠線山路 6 分鐘，不用工具。' },
    { role: 'store', when: 'start', title: '工具重量', text: '繩子 1 kg、燈具 3 kg。工具也算在車子的載重裡。' },
    { role: 'supply', when: 'start', title: '物資重量', text: '藥品 1 kg、飲水 2 kg、毛毯 3 kg、食物 2 kg。救援車最多載 7 kg（含工具）。' },
    { role: 'comms', when: 'start', title: '村莊需求', text: '東村要藥品，西村要飲水，北村要毛毯。' },
    { role: 'liaison', when: 'start', title: '優先順序', text: '北村的毛毯明天補送也可以；東村、西村今晚就要。' },
    { role: 'medic', when: 'start', title: '急迫', text: '東村有病人，藥品今晚一定要送到。' },
    { role: 'observer', when: 'start', title: '天候', text: '洪水第 5 分鐘會淹到低窪路段，路程要少於 5 分鐘才來得及。西村的水源被洪水污染了，今晚急需飲水。' },
    { role: 'eng', when: 'start', untilPower: true, title: '備援電力', text: '如果停電，你要依隊友的描述選出正確的符號。電力恢復後，備援面板會顯示一些重要資訊。' },
    { role: 'backup', when: 'start', untilPower: true, title: '修復面板', text: '修復時，每一格的選項都很像。先用排除線索刪掉不可能的，再請隊友描述。' },
    { role: 'scout', when: 'start', title: '路況', text: '吊橋年久失修，暴雨裡晃得厲害；隧道入口很暗，沒有燈進不去；山路本身穩，怕的是洪水。' },
    { role: 'scout', when: 'crisis', title: '路況', text: '吊橋斷了，紅線不能走。隧道還通，但燈具比繩子重。山路本身安全，問題只在洪水。' },
    { role: 'observer', when: 'power', title: '新消息', text: '上游有一座分洪閘門。開啟後，綠線山路的安全時間可以從第 5 分鐘延到第 7 分鐘。', breakthrough: 1 },
    { role: 'comms', when: 'power', title: '面板', text: '你的面板有「啟動分洪閘門」，但需要輸入授權頻道。', breakthrough: 2 },
    { role: 'eng', when: 'power', title: '備援面板', text: '備援面板恢復了：授權頻道是 {channel}。', breakthrough: 3 },
  ],
  'seed 002': [
    { role: 'nav', when: 'start', title: '路線', text: '紅線吊橋 3 分鐘，要帶長繩；藍線隧道 4 分鐘，要帶頭燈；綠線山路 6 分鐘，不用工具。' },
    { role: 'store', when: 'start', title: '工具重量', text: '長繩 3 kg、頭燈 1 kg。工具也算在車子的載重裡。' },
    { role: 'supply', when: 'start', title: '物資重量', text: '食物 2 kg、藥品 1 kg、飲水 2 kg、毛毯 3 kg。救援車最多載 6 kg（含工具）。' },
    { role: 'comms', when: 'start', title: '村莊需求', text: '東村要食物，西村要藥品，北村要飲水。' },
    { role: 'liaison', when: 'start', title: '優先順序', text: '北村的水車明天早上會到；東村、西村今晚就要。' },
    { role: 'medic', when: 'start', title: '急迫', text: '西村有傷患，藥品今晚一定要送到。' },
    { role: 'observer', when: 'start', title: '天候', text: '洪水第 5 分鐘會淹到低窪路段；綠線山路今晚怎樣都來不及。東村倉庫進水，今晚急需食物。' },
    { role: 'eng', when: 'start', untilPower: true, title: '備援電力', text: '如果停電，你要依隊友的描述選出正確的符號。' },
    { role: 'backup', when: 'start', untilPower: true, title: '修復面板', text: '修復時，每一格的選項都很像。先用排除線索刪掉不可能的，再請隊友描述。' },
    { role: 'scout', when: 'start', title: '路況', text: '山上一直有小石頭滾下來，開車要小心；紅線、藍線目前都通。' },
    { role: 'scout', when: 'crisis', title: '路況', text: '落石沒有擋住路，紅線、藍線都還能走；是車子被砸凹了，載重變小。' },
    { role: 'medic', when: 'power', title: '新消息', text: '淨水錠一盒 1 kg，能把井水處理成可以喝的水。', breakthrough: 1 },
    { role: 'supply', when: 'power', title: '倉庫清單', text: '倉庫有淨水錠，但清單註明：「確認當地有可用水源才發放」。', breakthrough: 2 },
    { role: 'comms', when: 'power', title: '對外聯絡', text: '電力恢復了，你可以向一個村發一則詢問——只有一次機會，先聽聽隊友怎麼說。', breakthrough: 3 },
  ],
};

export const QUERY_QUESTIONS = {
  well: '井還能用嗎？',
  road: '路況怎麼樣？',
  needs: '最缺什麼？',
} as const;

/** seed 002 詢問的回覆。成功的那一則會讓淨水錠發放。 */
export const QUERY_REPLIES: Record<string, string> = {
  '北村:well': '北村：「井還能用！只是水有點濁。」——倉庫立刻發放了淨水錠。',
  '北村:road': '北村：「村口有點積水，但車進得來。」',
  '北村:needs': '北村：「我們缺乾淨的水，不過明天早上水車會到。」',
  '東村:well': '東村：「我們村沒有井耶。」',
  '東村:road': '東村：「路還好，快來！」',
  '東村:needs': '東村：「倉庫進水了，最缺食物。」',
  '西村:well': '西村：「井被洪水污染了，不能用。」',
  '西村:road': '西村：「橋邊有點滑，小心開。」',
  '西村:needs': '西村：「有人受傷，最缺藥品。」',
};

export const HINT_ROLE: Record<SeedId, RoleId> = { 'seed 001': 'supply', 'seed 002': 'nav' };

/** 哥林多前書 12 章（和合本，公版）。 */
export const VERSES = {
  12: '就如身子是一個，卻有許多肢體；而且肢體雖多，仍是一個身子；基督也是這樣。',
  14: '身子原不是一個肢體，乃是許多肢體。',
  21: '眼不能對手說：「我用不著你」；頭也不能對腳說：「我用不著你」。',
  22: '不但如此，身上肢體人以為軟弱的，更是不可少的。',
  25: '免得身上分門別類，總要肢體彼此相顧。',
  26: '若一個肢體受苦，所有的肢體就一同受苦；若一個肢體得榮耀，所有的肢體就一同快樂。',
  27: '你們就是基督的身子，並且各自作肢體。',
} as const;

export const PREFERENCES = {
  planner: '旅行規劃派',
  casual: '隨性派',
  either: '都可以',
} as const;
export type Preference = keyof typeof PREFERENCES;

/**
 * 開局「下一步」：依線索互補關係，告訴每個人該去找誰、問什麼（暫定，ADR-0003 第 25 條）。
 * 依序挑第一個「不是自己」的對象；每個職能最多給一句，不直接給答案。
 */
export const ASKS: Record<RoleId, { to: RoleId; verb: '問' | '告訴' | '找'; text: string }[]> = {
  nav: [
    { to: 'observer', verb: '問', text: '洪水第幾分鐘會到？' },
    { to: 'store', verb: '問', text: '工具各多重？' },
  ],
  supply: [
    { to: 'comms', verb: '問', text: '各村需要什麼？' },
    { to: 'medic', verb: '問', text: '哪一村今晚最急？' },
  ],
  comms: [
    { to: 'supply', verb: '問', text: '車子最多能載多重？' },
    { to: 'nav', verb: '問', text: '有哪幾條路、各要多久？' },
  ],
  eng: [
    { to: 'nav', verb: '問', text: '有哪幾條路、各要帶什麼工具？' },
    { to: 'supply', verb: '問', text: '車子最多能載多重？' },
  ],
  medic: [
    { to: 'supply', verb: '告訴', text: '哪一村今晚一定要送到' },
    { to: 'comms', verb: '告訴', text: '哪一村今晚一定要送到' },
  ],
  observer: [
    { to: 'nav', verb: '告訴', text: '洪水第幾分鐘會到' },
    { to: 'supply', verb: '告訴', text: '洪水第幾分鐘會到、哪一村急需什麼' },
  ],
  scout: [{ to: 'nav', verb: '告訴', text: '每條路的路況' }],
  liaison: [{ to: 'supply', verb: '告訴', text: '哪一村可以明天再補送' }],
  store: [
    { to: 'nav', verb: '告訴', text: '每種工具多重' },
    { to: 'supply', verb: '告訴', text: '工具也算在車子的載重裡' },
  ],
  backup: [{ to: 'eng', verb: '找', text: '停電時你們要一起看修復面板，先打聲招呼' }],
};
