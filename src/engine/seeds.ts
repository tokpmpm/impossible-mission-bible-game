// 第一關「保羅海難」（使徒行傳 27 章）的固定數值、見聞與故事卡效果。
// 數值必須與 tools/verify_seeds.py 的 SEEDS／TONIGHT／USES／CARDS 一致（由 test/golden.test.ts 逐筆比對）。
// 卡片與見聞的文字（經文、後果說明）是內容，放在 src/server/content.ts；這裡只放會影響規則的效果。
// 2026-11-16：改為「今晚靠哪一樣」（docs/12-REPLAYABILITY.md 第 3 節；DECISIONS 15、16）。

export type SeedId = 'ship 001';
export type ItemId = '糧食' | '纜索' | '錨' | '麥子' | '器具' | '小船';
export type NeedId = '力氣' | '船身' | '天亮';
export type CardId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5';
export type Deck = 'A' | 'B';

/** 見聞：每局各發一個值，只在持有者的手機上。 */
export interface Tonight {
  食: '糧食' | '麥子'; // 今晚力氣靠哪一樣
  繩: '纜索' | '器具' | '小船'; // 今晚船身靠哪一條繩子
  水: '淺' | '深'; // 淺＝可以拋錨
  胃: '吃得下' | '吃不下'; // 吃不下＝不能吃飯
}
export type DialId = keyof Tonight;
export const DIALS: DialId[] = ['食', '繩', '水', '胃'];
export const TONIGHT_VALUES: { [K in DialId]: Tonight[K][] } = {
  食: ['糧食', '麥子'],
  繩: ['纜索', '器具', '小船'],
  水: ['淺', '深'],
  胃: ['吃得下', '吃不下'],
};
/** 首局固定的經典配置（v0.7 的打法：丟麥子、器具、小船，吃飯）。 */
export const CLASSIC: Tonight = { 食: '糧食', 繩: '纜索', 水: '深', 胃: '吃得下' };

/** 補好船後的三種「用掉」：那樣東西離船、那件事顧好。全隊只來得及做 seed.uses 件。 */
export type UseId = '吃飯' | '捆船底' | '拋錨';
export const USES: Record<UseId, { need: NeedId; blocked?: { dial: DialId; value: string } }> = {
  吃飯: { need: '力氣', blocked: { dial: '胃', value: '吃不下' } },
  捆船底: { need: '船身' },
  拋錨: { need: '天亮', blocked: { dial: '水', value: '深' } },
};
/** 試玩後若要拿掉「捆船底」，從這裡（和 tools/verify_seeds.py 的 USE_ENABLED）拿掉即可。 */
export const USE_ENABLED: UseId[] = ['吃飯', '捆船底', '拋錨'];

export interface SeedDef {
  id: SeedId;
  title: string;
  capPre: number; // 起風時的安全載重
  capPost: number; // 危機（27:20）後
  uses: number; // 天亮前只來得及用掉幾件
  /** 船上的東西與重量；順序就是畫面上的順序。 */
  weights: Record<ItemId, number>;
}

export interface CardDef {
  id: CardId;
  deck: Deck; // A＝起風（開局翻開）；B＝風暴（補好船時翻開）
  weight?: Partial<Record<ItemId, number>>; // 重量增減（最低 0）
  remove?: ItemId[]; // 自動離船
  done?: NeedId[]; // 已經顧好的事
  pinPre?: ItemId[]; // 危機前丟不掉
  eatOnly?: NeedId[]; // 這件事只能靠「用掉」顧好（留著東西不算）
  fix?: Partial<Tonight>; // 這局的見聞固定成這個值（不發這張見聞）
  exclude?: Partial<Tonight>; // 不和這個見聞值同局
  crisisShiftMs?: number; // 危機提早（負值）
  repairBonusMs?: number; // 補船多幾毫秒
  departDelayMs?: number; // 補好船後多久才能衝向海灘（目前沒有卡使用，保留給往後的卡）
  publicClue?: boolean; // 突破口第一段線索全隊可見（房間層處理）
}

export const ITEMS: ItemId[] = ['糧食', '纜索', '錨', '麥子', '器具', '小船'];
export const NEEDS: NeedId[] = ['力氣', '船身', '天亮'];

export const SEEDS: Record<SeedId, SeedDef> = {
  'ship 001': {
    id: 'ship 001',
    title: '保羅海難',
    capPre: 8,
    capPost: 5,
    uses: 1,
    weights: { 糧食: 3, 纜索: 2, 錨: 3, 麥子: 3, 器具: 2, 小船: 2 },
  },
};

/** 今晚上岸三件事各靠哪一樣東西。 */
export function providerOf(t: Tonight): Record<NeedId, ItemId> {
  return { 力氣: t.食, 船身: t.繩, 天亮: '錨' };
}

export const CARDS: Record<CardId, CardDef> = {
  A1: { id: 'A1', deck: 'A', pinPre: ['麥子'] },
  A2: { id: 'A2', deck: 'A', crisisShiftMs: -15_000 },
  A3: { id: 'A3', deck: 'A', weight: { 糧食: -1 } },
  A4: { id: 'A4', deck: 'A', remove: ['纜索'], done: ['船身'], fix: { 繩: '纜索' } },
  A5: { id: 'A5', deck: 'A', repairBonusMs: 10_000 },
  B1: { id: 'B1', deck: 'B', remove: ['器具'], weight: { 麥子: -2 } },
  B2: { id: 'B2', deck: 'B', remove: ['小船'] },
  B3: { id: 'B3', deck: 'B', weight: { 糧食: 2 } },
  B4: { id: 'B4', deck: 'B', publicClue: true },
  B5: { id: 'B5', deck: 'B', remove: ['錨'], done: ['天亮'], eatOnly: ['力氣'], exclude: { 胃: '吃不下' } },
};

export const DECK_A: CardId[] = ['A1', 'A2', 'A3', 'A4', 'A5'];
export const DECK_B: CardId[] = ['B1', 'B2', 'B3', 'B4', 'B5'];
