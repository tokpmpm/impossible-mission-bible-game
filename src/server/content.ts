// 職能、各人數的職能組合、線索、故事卡文字、結尾經文。
// 這些是內容資料（暫定，未經真人試玩），不是規則；規則在 src/engine。
// 經文為和合本（公版）。**本環境連不到線上聖經，依記憶寫入，待懂聖經的同工逐字核對**（docs/11）。
import type { CardId, ItemId, NeedId } from '../engine/seeds.ts';

export type RoleId = 'nav' | 'supply' | 'comms' | 'eng' | 'medic' | 'observer' | 'scout' | 'liaison' | 'store' | 'backup';

export const ROLES: Record<RoleId, { name: string; icon: string; job: string }> = {
  nav: { name: '船長', icon: '☸️', job: '決定好了就喊停，天亮時衝向海灘' },
  supply: { name: '管倉', icon: '📦', job: '決定丟什麼、留什麼' },
  comms: { name: '伙房', icon: '🍲', job: '管全船的飯' },
  eng: { name: '木匠', icon: '🔨', job: '黑暗中補船' },
  medic: { name: '醫生', icon: '🩺', job: '照顧大家的身體' },
  observer: { name: '瞭望', icon: '🔭', job: '看天色和風浪' },
  scout: { name: '測水深', icon: '📏', job: '量海有多深' },
  liaison: { name: '船主', icon: '💰', job: '這船貨是你的' },
  store: { name: '水手長', icon: '🪢', job: '管帆具繩具' },
  backup: { name: '舵手', icon: '🧭', job: '幫木匠看補船面板' },
};

/** 3–10 人的職能組合（沿用 01-GAME_DESIGN）。 */
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

/** 拆出的職能不在場時，線索回到原職能。 */
export const SPLIT_FROM: Partial<Record<RoleId, RoleId>> = {
  scout: 'observer',
  liaison: 'nav',
  store: 'supply',
  backup: 'comms',
};

export type ClueWhen = 'start' | 'power';

export interface Clue {
  role: RoleId;
  when: ClueWhen; // start＝開局；power＝補好船後（突破口，標題不寫「突破口」）
  title: string;
  text: string;
  /** 畫面用的圖：哪樣東西 → 顧哪件事。 */
  item?: ItemId;
  need?: NeedId;
  breakthrough?: 1 | 2 | 3;
  /** 補好船就收起來（講黑暗中怎麼做的）。 */
  untilPower?: boolean;
  /** 只有這個職能本人在場才給（不轉給原職能）。 */
  onlyPresent?: boolean;
}

export const CLUES: Clue[] = [
  { role: 'nav', when: 'start', title: '安全載重', text: '船最多只能留 6 重的東西，超過就會進水。' },
  { role: 'liaison', when: 'start', title: '船主的話', item: '麥子', text: '船主要保住麥子：這船就是要把麥子運去義大利的（27:6、11）。' },
  { role: 'supply', when: 'start', title: '上岸三件事', text: '上岸要顧好：力氣、船身、等天亮。哪樣東西顧哪件事，要問隊友。' },
  { role: 'store', when: 'start', title: '器具', item: '器具', text: '器具是開船用的帆具和繩具，很佔重量。' },
  { role: 'comms', when: 'start', title: '伙房', item: '糧食', text: '大家好些日子沒吃什麼了（27:21）。糧食還在倉底。' },
  { role: 'backup', when: 'start', title: '小船', item: '小船', text: '小船是逃生用的，水手都很想留著。' },
  { role: 'eng', when: 'start', title: '纜索', item: '纜索', need: '船身', text: '纜索可以捆綁船底，船身才撐得住（27:17）。' },
  { role: 'eng', when: 'start', untilPower: true, title: '黑暗中', text: '天黑時看不見，要靠隊友形容記號，你來選。' },
  { role: 'medic', when: 'start', title: '力氣', item: '糧食', need: '力氣', text: '人要吃東西才有力氣，上岸時才游得動。' },
  { role: 'observer', when: 'start', title: '風浪', text: '風浪會越來越大，之後船能留的東西會更少。' },
  { role: 'scout', when: 'start', title: '錨', item: '錨', need: '天亮', text: '快靠岸時要從船尾拋錨，才不會撞上石頭，等到天亮（27:29）。' },
  { role: 'backup', when: 'start', untilPower: true, onlyPresent: true, title: '補船小撇步', text: '每格選項都很像：先用排除線索刪掉不可能的，再請隊友形容。' },
  { role: 'medic', when: 'power', breakthrough: 1, title: '十四天', need: '力氣', text: '大家已經十四天沒吃東西了（27:33）。吃了就有力氣——力氣不一定要把糧食留到上岸。' },
  { role: 'supply', when: 'power', breakthrough: 2, title: '倉底', item: '糧食', text: '吃進肚子裡的糧食，就不佔船的重量了。' },
  { role: 'comms', when: 'power', breakthrough: 3, title: '開飯', item: '糧食', text: '你可以召集大家吃飯（糧食要還在船上）。' },
];

/** 方向提示（2:15）：給瞭望。 */
export const HINT_ROLE: RoleId = 'observer';
export const HINT_TEXT = '船上真正保命的東西，好像剛好裝得下。';

/** 故事卡文字：經文（和合本）＋這局因此發生的事。tone 只給畫面配色，不是運氣。 */
export const CARD_TEXT: Record<CardId, { title: string; ref: string; verse: string; effect: string; tone: 'good' | 'bad' | 'mixed' }> = {
  A1: {
    title: '保羅勸他們不要開船',
    ref: '徒 27:10–11',
    verse: '「眾位，我看這次行船，不但貨物和船要受傷損，大遭破壞，連我們的性命也難保。」但百夫長信從掌船的和船主，不信保羅所說的。',
    effect: '船主不准丟麥子：風暴變大以前，麥子丟不掉。',
    tone: 'bad',
  },
  A2: {
    title: '狂風撲下來',
    ref: '徒 27:13–14',
    verse: '這時微微起了南風，他們以為得意，就起了錨，貼近革哩底行去。不多幾時，狂風從島上撲下來，那風名叫友拉革羅。',
    effect: '風暴提早 15 秒來。',
    tone: 'bad',
  },
  A3: {
    title: '朋友的照應',
    ref: '徒 27:3',
    verse: '第二天，到了西頓，猶流寬待保羅，准他往朋友那裡去，受他們的照應。',
    effect: '朋友準備了乾糧：糧食變輕（2→1）。',
    tone: 'good',
  },
  A4: {
    title: '用纜索捆綁船底',
    ref: '徒 27:17',
    verse: '既把小船拉上來，就用纜索捆綁船底；又恐怕在賽耳底沙灘上擱了淺，就落下篷來，任船飄去。',
    effect: '船身已經綁好：船身顧好了，纜索不用再留。',
    tone: 'good',
  },
  A5: {
    title: '亞里達古同去',
    ref: '徒 27:2',
    verse: '有馬其頓的帖撒羅尼迦人亞里達古和我們同去。',
    effect: '多一個幫手：黑暗中補船多 10 秒。',
    tone: 'good',
  },
  B1: {
    title: '把貨和器具拋棄',
    ref: '徒 27:18–19',
    verse: '我們被風浪逼得甚急，第二天眾人就把貨拋在海裡；到第三天，他們又親手把船上的器具拋棄了。',
    effect: '器具已經拋進海裡，麥子也只剩一些（3→1）。',
    tone: 'good',
  },
  B2: {
    title: '水手想坐小船逃走',
    ref: '徒 27:30–32',
    verse: '保羅對百夫長和兵丁說：「這些人若不等在船上，你們必不能得救。」於是兵丁砍斷小船的繩子，由它飄去。',
    effect: '小船漂走了。',
    tone: 'mixed',
  },
  B3: {
    title: '船上共有 276 人',
    ref: '徒 27:37',
    verse: '我們在船上的共有二百七十六個人。',
    effect: '人多，口糧也多：糧食變重（+1）。',
    tone: 'bad',
  },
  B4: {
    title: '保羅說：你們可以放心',
    ref: '徒 27:21–22',
    verse: '眾人多日沒有吃甚麼，保羅就出來站在他們中間，說：「……現在我還勸你們放心；你們的性命一個也不失喪，惟獨失喪這船。」',
    effect: '大家都聽到了：醫生那段「吃了就有力氣」全隊都看得到。',
    tone: 'good',
  },
  B5: {
    title: '探深淺，拋錨盼天亮',
    ref: '徒 27:28–29',
    verse: '就探深淺，探得有十二丈；稍往前行，又探深淺，探得有九丈。恐怕撞在石頭上，就從船尾拋下四個錨，盼望天亮。',
    effect: '要等天亮：補好船後 20 秒才能衝向海灘。',
    tone: 'bad',
  },
};

/** 各階段畫面上的一句故事（附章節）。 */
export const STORY = {
  intro: { text: '佳澳港。保羅勸大家別開船，百夫長卻信了船長。南風微微吹，開船了。', ref: '徒 27:9–13' },
  planning: { text: '狂風撲下來，船被風抓住，只好任風颳去。船太重了！', ref: '徒 27:14–15' },
  blackout: { text: '太陽和星辰多日不顯露，狂風大浪催逼。', ref: '徒 27:20' },
  replanning: { text: '第十四天夜裡，水手覺得快到陸地了。', ref: '徒 27:27' },
  landing: { text: '天亮了，看見一個海灣，就順著風向岸行去。', ref: '徒 27:39–40' },
} as const;

/** 結尾經文。 */
export const ENDING_VERSES = {
  fed: { text: '保羅說了這話，就拿著餅，在眾人面前祝謝了神，擘開吃。於是他們都放下心，也就吃了。', ref: '徒 27:35–36' },
  shore: { text: '其餘的人可以用板子或船上的零碎東西上岸。這樣，眾人都得了救，上了岸。', ref: '徒 27:44' },
} as const;

/** 結尾「經文裡」：和這局的做法並列。 */
export const BIBLE_THROWS = '經文裡：第二天把貨拋在海裡，第三天把器具拋棄（27:18–19）；吃飽了才把麥子拋在海裡，叫船輕一點（27:38）。';

/** 結尾「你知道嗎？」，依局數輪替。 */
export const FACTS = [
  '這是一艘亞歷山大的船，載著麥子要往義大利去（27:6、38）。',
  '他們上岸的島叫米利大（28:1），就是今天的馬爾他。那天又下雨又冷，島上的人生火接待他們（28:2）。',
  '寫這段的人一直說「我們」——他自己也在這艘船上。',
  '保羅是以囚犯的身分被押往羅馬，要在凱撒面前受審（27:1、24）。',
];

/** 結尾可跳過的輕鬆問題（不談信仰、不談隱私）。 */
export const QUESTIONS = ['剛才哪一刻你最緊張？', '如果你在那艘船上，最捨不得丟哪一樣？', '剛才誰說的哪句話最有用？'];

/** 大廳的背包題：上船前多帶一樣什麼（公開、可跳過）。只有油燈有規則效果。 */
export const PREFERENCES = {
  lamp: { name: '油燈', icon: '🪔' },
  coat: { name: '外衣', icon: '🧥' },
  nuts: { name: '乾果', icon: '🌰' },
  song: { name: '一首歌', icon: '🎵' },
} as const;
export type Preference = keyof typeof PREFERENCES;

/** 背包物品在結尾出場（只陳述、不影響規則）。{name} 換成暱稱。 */
export const CAMEOS: Record<Exclude<Preference, 'lamp'>, string> = {
  coat: '{name} 把外衣披在一個發抖的人身上——那天又下雨又冷（28:2）。',
  nuts: '上了岸，大家圍著火，分著吃 {name} 帶的乾果。',
  song: '{name} 在火堆旁哼起歌，大家慢慢暖和起來。',
};

/**
 * 開局「下一步」：去找誰、問什麼（不直接給答案）。依序挑第一個「不是自己」的對象。
 */
export interface Ask { to: RoleId; verb: '問' | '告訴' | '找'; text: string }
export const ASKS: Record<RoleId, Ask[]> = {
  nav: [
    { to: 'supply', verb: '問', text: '船上現在多重？要丟哪些？' },
    { to: 'observer', verb: '問', text: '風浪之後會怎樣？' },
  ],
  supply: [
    { to: 'medic', verb: '問', text: '糧食要留嗎？' },
    { to: 'eng', verb: '問', text: '纜索有什麼用？' },
  ],
  comms: [{ to: 'medic', verb: '問', text: '大家一直沒吃東西，會怎樣？' }],
  eng: [{ to: 'supply', verb: '告訴', text: '纜索能捆綁船底，船身靠它' }],
  medic: [{ to: 'supply', verb: '告訴', text: '糧食顧的是大家的力氣' }],
  observer: [{ to: 'supply', verb: '告訴', text: '錨顧的是等天亮；風浪還會更大' }],
  scout: [{ to: 'supply', verb: '告訴', text: '錨要留，夜裡才不會撞上石頭' }],
  liaison: [{ to: 'nav', verb: '告訴', text: '船主要保住麥子' }],
  store: [{ to: 'supply', verb: '告訴', text: '器具很重，是開船用的' }],
  backup: [{ to: 'eng', verb: '找', text: '天黑時要一起看補船面板，先打聲招呼' }],
};
/** 測水深在場時，瞭望手上沒有錨的線索。 */
export const OBSERVER_ASKS_WITH_SCOUT: Ask[] = [{ to: 'nav', verb: '告訴', text: '風浪會更大，船之後能留的更少' }];
