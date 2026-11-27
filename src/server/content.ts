// 職能、各人數的職能組合、線索、故事卡文字、結尾經文。
// 這些是內容資料（暫定，未經真人試玩），不是規則；規則在 src/engine。
// 經文為新標點和合本「神」版（公版；2026-11-15 使用者選定神版）。2026-11-15 以 GitHub brandonmcconnell/bible 的 zh-Hant/cuvt（標示「新標點和合本」）逐字核對字詞（docs/05）。
import type { CardId, DialId, ItemId, NeedId, Tonight, UseId } from '../engine/seeds.ts';

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

/**
 * 角色卡（2026-11-27 使用者決定，DECISIONS 20：新手引導 v2 三個 A）：每局倒數開始前先看一張大角色卡。
 * line：第一人稱台詞；who／ref：徒 27 章裡對應的人（掌船的、船主、水手、路加醫生；其他寫「船上的人」、不附出處）。
 * 不扮演保羅、不扮演天使或百夫長。word：出處經文裡一定要有的字，由 tools/verify_verses.py 逐節核對。
 * button／when：你負責的按鈕長什麼樣、什麼時候出現（示意文字，不是可以按的按鈕；DECISIONS 11）。know：只有你知道的事。
 */
export interface RoleCardText { line: string; who: string; ref: string; word: string; note?: string; button: string | null; when: string; know: string }
export const ROLE_CARD: Record<RoleId, RoleCardText> = {
  nav: { line: '大家講好了，由我喊出發。', who: '掌船的', ref: '徒 27:11', word: '掌船的', button: '決定好了／衝向海灘', when: '認識隊友結束後', know: '船最多只能留 8' },
  supply: { line: '丟什麼、留什麼，我來按。', who: '船上的人', ref: '', word: '', button: '丟／撈東西', when: '一開始就能按', know: '上岸要顧好三件事' },
  comms: { line: '全船的飯歸我管。', who: '船上的人', ref: '', word: '', button: '召集大家吃飯', when: '補好船以後（第十四天夜裡）', know: '今晚吃的是哪一樣' },
  eng: { line: '天黑了，我來補船。', who: '水手', ref: '徒 27:27', word: '水手', button: '補船面板、捆綁船底', when: '天黑時', know: '船身要靠繩子撐住' },
  medic: { line: '我顧大家的身體。', who: '路加醫生', ref: '西 4:14', word: '醫生路加', note: '傳統認為路加寫了使徒行傳', button: null, when: '', know: '食物要吃下去才有力氣' },
  observer: { line: '我看天色和風浪。', who: '船上的人', ref: '', word: '', button: null, when: '', know: '風浪會變大，船能留的會變少' },
  scout: { line: '海有多深，我來量。', who: '水手', ref: '徒 27:28', word: '探深淺', button: '從船尾拋錨', when: '補好船以後、水淺時', know: '水有多深' },
  liaison: { line: '這船麥子是我的。', who: '船主', ref: '徒 27:11', word: '船主', button: null, when: '', know: '船主要保住麥子' },
  store: { line: '帆具繩具歸我管。', who: '水手', ref: '徒 27:27', word: '水手', button: null, when: '', know: '今晚捆船用哪一條繩子' },
  backup: { line: '我陪木匠補船。', who: '船上的人', ref: '', word: '', button: null, when: '', know: '天黑時一起看補船面板' },
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

// 文字裡的 {食}{繩}{水} 會換成這局拿那張見聞的人的職能名稱（房間層處理）。
export const CLUES: Clue[] = [
  { role: 'nav', when: 'start', title: '安全載重', text: '船最多只能留 8 重的東西，超過了船吃水太深，不能開船。' },
  { role: 'liaison', when: 'start', title: '船主的話', item: '麥子', text: '船主要保住麥子：這船就是要把麥子運去意大利的（27:6、11）。' },
  { role: 'supply', when: 'start', title: '上岸三件事', text: '上岸要顧好：力氣、船身、錨住船。今晚各靠哪一樣東西，每次都不一樣，要問隊友。' },
  { role: 'store', when: 'start', title: '器具', item: '器具', text: '器具是開船用的帆具和繩具，很佔重量；裡面的繩具也捆得了船。' },
  { role: 'comms', when: 'start', title: '伙房', need: '力氣', text: '大家好些日子沒吃什麼了（27:21）。倉底有乾糧，貨艙有麥子。' },
  { role: 'backup', when: 'start', title: '小船', item: '小船', text: '小船是逃生用的，水手都很想留著；小船上的拉繩也是一條好繩子。' },
  { role: 'eng', when: 'start', title: '捆綁船底', need: '船身', text: '要用繩子捆綁船底，船身才撐得住（27:17）。今晚用哪一條繩子，問{繩}。' },
  { role: 'eng', when: 'start', untilPower: true, title: '黑暗中', text: '天黑時看不見，要靠隊友形容記號，你來選。' },
  { role: 'medic', when: 'start', title: '力氣', need: '力氣', text: '人要真的吃下去才有力氣，上岸時才游得動；食物留在船上不吃，不會變成力氣。今晚吃哪一樣，問{食}。' },
  { role: 'observer', when: 'start', title: '風浪', text: '風浪會越來越大，之後船能留的東西會更少（8 → 5）。' },
  { role: 'scout', when: 'start', title: '錨', item: '錨', need: '天亮', text: '快靠岸時要從船尾拋錨，才不會撞上石頭，等到天亮（27:29）。' },
  { role: 'backup', when: 'start', untilPower: true, onlyPresent: true, title: '補船小撇步', text: '每格選項都很像：先用排除線索刪掉不可能的，再請隊友形容。' },
  { role: 'medic', when: 'power', breakthrough: 1, title: '十四天', need: '力氣', text: '大家已經十四天沒吃東西了（27:33）。船上有食物也沒用，要真的吃了才有力氣。' },
  { role: 'supply', when: 'power', breakthrough: 2, title: '用掉就輕了', text: '吃進肚子的食物、拋下去的錨、捆在船底的繩子，都不再佔船的重量。可是出發前只來得及做一件；錨和繩子留在船上，靠岸前還來得及用。' },
  { role: 'comms', when: 'power', breakthrough: 3, title: '開飯', need: '力氣', text: '召集大家吃飯的就是你（今晚的食物要還在船上）。按下去以前要大家都同意。' },
];

/** 見聞：誰拿（不在場時照 SPLIT_FROM 回到原職能）。docs/12 3.2。 */
export const TONIGHT_ROLE: Record<DialId, RoleId> = { 食: 'comms', 繩: 'store', 水: 'scout' };

/**
 * 見聞的文字：「你看到的事」，只陳述、不說好壞。自創細節不附章節、標「遊戲設定」（DECISIONS 15）；有經文的才附章節。
 * item：今晚靠的那樣東西（畫面的圖）；use：和哪一種用掉有關。
 */
export const TONIGHT_TEXT: { [D in DialId]: Record<Tonight[D], { title: string; text: string; ref?: string; verse?: string; item?: ItemId; use?: UseId }> } = {
  食: {
    糧食: { title: '今晚的飯', text: '倉底的乾糧還好好的：今晚煮糧食。', item: '糧食' },
    麥子: { title: '今晚的飯', text: '乾糧泡了海水，壞了：今晚只能煮麥子。', item: '麥子' },
  },
  繩: {
    纜索: { title: '捆船的繩子', text: '纜索完好：捆船底就用纜索。', item: '纜索' },
    器具: { title: '捆船的繩子', text: '纜索磨斷了：捆船底要用器具裡的繩具。', item: '器具' },
    小船: { title: '捆船的繩子', text: '纜索磨斷了：捆船底要用小船上的拉繩。', item: '小船' },
  },
  水: {
    淺: { title: '水深', text: '水變淺了：現在就可以從船尾拋錨。', ref: '徒 27:28', verse: '稍往前行，又探深淺，探得有九丈。', item: '錨', use: '拋錨' },
    深: { title: '水深', text: '還探不到底：錨先留著，等水變淺、快靠岸時再拋。', item: '錨' },
  },
};

/** 補好船後的三種用掉：誰的手機有按鈕、按鈕寫什麼、經文出處（都是船員做的事，不是神蹟）。 */
export const USE_TEXT: Record<UseId, { role: RoleId; label: string; icon: string; ref: string; done: string }> = {
  吃飯: { role: 'comms', label: '召集大家吃飯', icon: '🍞', ref: '徒 27:33–36', done: '大家吃飽了' },
  拋錨: { role: 'scout', label: '從船尾拋錨', icon: '⚓', ref: '徒 27:29', done: '錨從船尾拋下去了' },
  捆船底: { role: 'eng', label: '捆綁船底', icon: '🪢', ref: '徒 27:17', done: '船底捆好了' },
};

/** 方向提示（2:15）：給瞭望。{食}{繩} 換成職能名稱。 */
export const HINT_ROLE: RoleId = 'observer';
export const HINT_TEXT = '今晚靠什麼，{食}和{繩}最清楚。';

/** 故事卡文字：經文（和合本）＋這局因此發生的事。tone 只給畫面配色，不是運氣。 */
export const CARD_TEXT: Record<CardId, { title: string; ref: string; verse: string; effect: string; tone: 'good' | 'bad' | 'mixed' }> = {
  A1: {
    title: '保羅勸他們不要開船',
    ref: '徒 27:10–11',
    verse: '「眾位，我看這次行船，不但貨物和船要受損傷，大遭破壞，連我們的性命也難保。」但百夫長信從掌船的和船主，不信從保羅所說的。',
    effect: '船主不准丟麥子：風暴變大以前，麥子丟不掉。',
    tone: 'bad',
  },
  A2: {
    title: '狂風撲下來',
    ref: '徒 27:13–14',
    verse: '這時，微微起了南風，他們以為得意，就起了錨，貼近克里特行去。不多幾時，狂風從島上撲下來；那風名叫「友拉革羅」。',
    effect: '風暴提早 15 秒來。',
    tone: 'bad',
  },
  A3: {
    title: '朋友的照應',
    ref: '徒 27:3',
    verse: '第二天，到了西頓；猶流寬待保羅，准他往朋友那裏去，受他們的照應。',
    effect: '朋友幫忙把乾糧烤乾、分成小包（遊戲設定）：糧食比較好搬（3→2）。',
    tone: 'good',
  },
  A4: {
    title: '用纜索捆綁船底',
    ref: '徒 27:17',
    verse: '既然把小船拉上來，就用纜索捆綁船底，又恐怕在賽耳底沙灘上擱了淺，就落下篷來，任船飄去。',
    effect: '船身已經綁好：船身顧好了，纜索不用再留（這局沒有「捆船的繩子」見聞）。',
    tone: 'good',
  },
  A5: {
    title: '亞里達古同去',
    ref: '徒 27:2',
    verse: '……有馬其頓的帖撒羅尼迦人亞里達古和我們同去。',
    effect: '多一個幫手：黑暗中補船多 10 秒。',
    tone: 'good',
  },
  B1: {
    title: '把貨和器具拋棄',
    ref: '徒 27:18–19',
    verse: '我們被風浪逼得甚急，第二天眾人就把貨物拋在海裏。到第三天，他們又親手把船上的器具拋棄了。',
    effect: '器具已經拋進海裡，麥子也只剩一些（3→1）。',
    tone: 'good',
  },
  B2: {
    title: '水手想坐小船逃走',
    ref: '徒 27:30–32',
    verse: '水手想要逃出船去，把小船放在海裏……保羅對百夫長和兵丁說：「這些人若不等在船上，你們必不能得救。」於是兵丁砍斷小船的繩子，由它飄去。',
    effect: '小船漂走了。',
    tone: 'mixed',
  },
  B3: {
    title: '吃飽了，把麥子拋在海裡',
    ref: '徒 27:37–38',
    verse: '我們在船上的共有二百七十六個人。他們吃飽了，就把船上的麥子拋在海裏，為要叫船輕一點。',
    effect: '麥子已經拋進海裡了（經文裡是大家吃飽以後才拋）。',
    tone: 'mixed',
  },
  B4: {
    title: '保羅說：你們可以放心',
    ref: '徒 27:21–22',
    verse: '眾人多日沒有吃甚麼，保羅就出來站在他們中間，說：「……現在我還勸你們放心，你們的性命一個也不失喪，惟獨失喪這船。」',
    effect: '大家都聽到了：醫生那段「吃了就有力氣」全隊都看得到。',
    tone: 'good',
  },
  B5: {
    title: '探深淺，拋錨盼天亮',
    ref: '徒 27:28–29',
    verse: '就探深淺，探得有十二丈；稍往前行，又探深淺，探得有九丈。恐怕撞在石頭上，就從船尾拋下四個錨，盼望天亮。',
    effect: '錨已經從船尾拋下去了：錨住船顧好了，錨不在船上。',
    tone: 'good',
  },
};

/** 各階段畫面上的一句故事（附章節）。 */
export const STORY = {
  intro: { text: '佳澳港。保羅勸大家別開船，百夫長卻信從掌船的和船主。南風微微吹，開船了。', ref: '徒 27:8–13' },
  planning: { text: '狂風從島上撲下來，船被風抓住，敵不住風，只好任風颳去。船太重了！', ref: '徒 27:14–15' },
  blackout: { text: '太陽和星辰多日不顯露，又有狂風大浪催逼。', ref: '徒 27:20' },
  replanning: { text: '到了第十四天夜間……水手以為漸近旱地。', ref: '徒 27:27' },
  landing: { text: '到了天亮，但見一個海灣，有岸可登，就順着風向岸行去。', ref: '徒 27:39–40' },
} as const;

/** 結尾經文。 */
export const ENDING_VERSES = {
  fed: { text: '保羅說了這話，就拿着餅，在眾人面前祝謝了神，擘開吃。於是他們都放下心，也就吃了。', ref: '徒 27:35–36' },
  shore: { text: '其餘的人可以用板子或船上的零碎東西上岸。這樣，眾人都得了救，上了岸。', ref: '徒 27:44' },
} as const;

/** 火堆旁（結算，docs/17 v2）：上了岸，下雨又冷，島上的人生火接待（28:2）。 */
export const FIRESIDE_VERSE = { text: '土人看待我們，有非常的情分；因為當時下雨，天氣又冷，就生火接待我們眾人。', ref: '徒 28:2' } as const;

/** 結尾「經文裡」：和這局的做法並列。 */
export const BIBLE_THROWS = '經文裡：第二天把貨物拋在海裏，第三天把器具拋棄（27:18–19）；吃飽了，才把麥子拋在海裏，為要叫船輕一點（27:38）。';

/** 結尾「你知道嗎？」，依局數輪替。 */
export const FACTS = [
  '這是一艘亞歷山大的船，載着麥子要往意大利去（27:6、38）。',
  '他們上岸的島叫馬耳他（28:1；舊版和合本譯作「米利大」）。那天下雨，天氣又冷，島上的人生火接待他們（28:2）。',
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
  coat: '上岸時下雨，天氣又冷（28:2）。{name} 把帶來的外衣披在一個發抖的人身上。',
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
    { to: 'comms', verb: '問', text: '今晚吃的是哪一樣？' },
    { to: 'store', verb: '問', text: '今晚捆船用哪一條繩子？' },
    { to: 'eng', verb: '問', text: '船身要靠什麼撐住？' },
  ],
  comms: [{ to: 'supply', verb: '告訴', text: '今晚吃的是哪一樣' }],
  eng: [
    { to: 'store', verb: '問', text: '今晚捆船用哪一條繩子？' },
    { to: 'supply', verb: '告訴', text: '船身要靠繩子捆綁船底' },
  ],
  medic: [{ to: 'comms', verb: '告訴', text: '食物要吃下去才有力氣，留著不算' }],
  observer: [{ to: 'supply', verb: '告訴', text: '錨要留著才能錨住船；水有多深' }],
  scout: [{ to: 'supply', verb: '告訴', text: '錨要留；水有多深' }],
  liaison: [{ to: 'nav', verb: '告訴', text: '船主要保住麥子' }],
  store: [{ to: 'supply', verb: '告訴', text: '今晚捆船用哪一條繩子' }],
  backup: [{ to: 'eng', verb: '找', text: '天黑時要一起看補船面板，先打聲招呼' }],
};
/** 測水深在場時，瞭望手上沒有錨的線索。 */
export const OBSERVER_ASKS_WITH_SCOUT: Ask[] = [{ to: 'nav', verb: '告訴', text: '風浪會更大，船之後能留的更少' }];
