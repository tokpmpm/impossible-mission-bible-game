// 第一關「保羅海難」（使徒行傳 27 章）的固定數值與故事卡效果。
// 數值必須與 tools/verify_seeds.py 的 SEEDS／CARDS 一致（由 test/golden.test.ts 逐筆比對）。
// 卡片的文字（經文、後果說明）是內容，放在 src/server/content.ts；這裡只放會影響規則的效果。

export type SeedId = 'ship 001';
export type ItemId = '糧食' | '纜索' | '錨' | '麥子' | '器具' | '小船';
export type NeedId = '力氣' | '船身' | '天亮';
export type CardId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5';
export type Deck = 'A' | 'B';

export interface SeedDef {
  id: SeedId;
  title: string;
  capPre: number; // 起風時的安全載重
  capPost: number; // 危機（27:20）後
  /** 船上的東西與重量；順序就是畫面上的順序。 */
  weights: Record<ItemId, number>;
  /** 上岸三件事各靠哪一樣東西。 */
  needs: Record<NeedId, ItemId>;
  /** 吃飯（突破口）會吃掉的東西。 */
  food: ItemId;
}

export interface CardDef {
  id: CardId;
  deck: Deck; // A＝起風（開局翻開）；B＝風暴（補好船時翻開）
  weight?: Partial<Record<ItemId, number>>; // 重量增減
  remove?: ItemId[]; // 自動離船
  done?: NeedId[]; // 已經顧好的事
  pinPre?: ItemId[]; // 危機前丟不掉
  crisisShiftMs?: number; // 危機提早（負值）
  repairBonusMs?: number; // 補船多幾毫秒
  departDelayMs?: number; // 補好船後多久才能衝向海灘
  publicClue?: boolean; // 突破口第一段線索全隊可見（房間層處理）
}

export const ITEMS: ItemId[] = ['糧食', '纜索', '錨', '麥子', '器具', '小船'];
export const NEEDS: NeedId[] = ['力氣', '船身', '天亮'];

export const SEEDS: Record<SeedId, SeedDef> = {
  'ship 001': {
    id: 'ship 001',
    title: '保羅海難',
    capPre: 6,
    capPost: 4,
    weights: { 糧食: 2, 纜索: 1, 錨: 3, 麥子: 3, 器具: 2, 小船: 2 },
    needs: { 力氣: '糧食', 船身: '纜索', 天亮: '錨' },
    food: '糧食',
  },
};

export const CARDS: Record<CardId, CardDef> = {
  A1: { id: 'A1', deck: 'A', pinPre: ['麥子'] },
  A2: { id: 'A2', deck: 'A', crisisShiftMs: -15_000 },
  A3: { id: 'A3', deck: 'A', weight: { 糧食: -1 } },
  A4: { id: 'A4', deck: 'A', remove: ['纜索'], done: ['船身'] },
  A5: { id: 'A5', deck: 'A', repairBonusMs: 10_000 },
  B1: { id: 'B1', deck: 'B', remove: ['器具'], weight: { 麥子: -2 } },
  B2: { id: 'B2', deck: 'B', remove: ['小船'] },
  B3: { id: 'B3', deck: 'B', weight: { 糧食: 1 } },
  B4: { id: 'B4', deck: 'B', publicClue: true },
  B5: { id: 'B5', deck: 'B', departDelayMs: 20_000 },
};

export const DECK_A: CardId[] = ['A1', 'A2', 'A3', 'A4', 'A5'];
export const DECK_B: CardId[] = ['B1', 'B2', 'B3', 'B4', 'B5'];
