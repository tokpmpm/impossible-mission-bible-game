// 團隊計分（試行；docs/13-SCORING.md，2026-11-16 使用者核准）。
// 伺服器權威：只從一局的規則狀態（GameState）取原始資料 → 用公式算分。手機送不進分數。
// 公式只吃「原始計分資料」（ScoreRaw），所以將來改公式時，排行榜可以用存下來的原始資料重算，不必清榜。
// 只排團隊、不排個人；分數與信仰、聖經答題無關。
import { DIFFICULTY, DIFF_MAX, SWEEP_BONUS } from './difficulty.ts';
import { TIME_UP_AT, type GameState } from './game.ts';
import { DIALS, type CardId, type Tonight } from './seeds.ts';

/** 公式版本：改公式就換版本號，舊紀錄可用新版本重算。 */
export const FORMULA_VERSION = 'v1-trial';
export const SCORE_MAX = 1000;

/** 四項的滿分。 */
export const PARTS = { mission: 600, teamwork: 200, time: 100, difficulty: 100 } as const;
/** 任務成果：上岸三件事每顧好一件。 */
export const PER_STAR = 200;
/** 合作順暢：補船速度（線性）＋沒用協助（依協助等級遞減）。 */
export const REPAIR_SPEED_MAX = 140;
export const NO_ASSIST_POINTS: Record<0 | 1 | 2, number> = { 0: 60, 1: 30, 2: 0 };
/** 時間：這個時間（含）以前上岸給滿分，8:00 為 0，中間線性。 */
export const TIME_FULL_AT = 120_000;

/**
 * 人數校正係數（3–10 人）。試行期全部 1.0；等有真人試玩資料再調。
 * 改這張表要同時換 FORMULA_VERSION。
 */
export const PLAYER_FACTOR: Record<number, number> = { 3: 1.0, 4: 1.0, 5: 1.0, 6: 1.0, 7: 1.0, 8: 1.0, 9: 1.0, 10: 1.0 };

/** 一局的原始計分資料（排行榜每筆都存這份）。 */
export interface ScoreRaw {
  formula: string; // 算分當時的公式版本
  stars: 0 | 1 | 2 | 3;
  /** 補船花了幾毫秒；沒補好（時間到還在黑暗中）＝null。 */
  repairMs: number | null;
  /** 這局補船的限時（含首局＋15 秒、A5＋10 秒）。 */
  repairLimitMs: number;
  /** 補好時的協助等級：0＝沒用、1＝逾時進協助、2＝第二段協助。沒補好＝2。 */
  assistLevel: 0 | 1 | 2;
  /** 結束時間（局內毫秒）：上岸時間；時間到＝8:00。 */
  finishedAt: number;
  cards: { a: CardId; b: CardId };
  tonight: Tonight;
  sweep: boolean; // 這局有風暴捲走（第二局起）
  /** 這局局面補好船後有幾種三星解、對應難度分（tools/verify_seeds.py）。 */
  solutions: number;
  difficultyPoints: number;
  playerCount: number;
}

export interface ScoreBreakdown {
  mission: number;
  teamwork: number;
  time: number;
  difficulty: number;
  factor: number;
  total: number;
  /** 試行：還沒有真人試玩資料。 */
  trial: true;
  formula: string;
}

export function difficultyKey(cards: { a: CardId; b: CardId }, tonight: Tonight): string {
  return `${cards.a}|${DIALS.map((d) => tonight[d]).join('/')}|${cards.b}`;
}

/** 從難度表查這局局面（查不到＝0 分；照表抽的局面一定查得到）。 */
export function difficultyOf(cards: { a: CardId; b: CardId }, tonight: Tonight): { solutions: number; points: number } {
  return DIFFICULTY[difficultyKey(cards, tonight)] ?? { solutions: 0, points: 0 };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 從結束的一局取出原始計分資料；還沒結束＝null。 */
export function rawOf(g: GameState): ScoreRaw | null {
  if (g.phase !== 'settled' && g.phase !== 'ended') return null;
  const r = g.repair;
  const done = !!r && r.doneAt !== null;
  const d = difficultyOf(g.cards, g.tonight);
  return {
    formula: FORMULA_VERSION,
    stars: g.result?.stars ?? 0,
    repairMs: done ? r!.doneAt! - r!.startedAt : null,
    repairLimitMs: r?.limitMs ?? 0,
    assistLevel: done ? r!.assistLevel : 2,
    finishedAt: g.result ? g.result.at : TIME_UP_AT,
    cards: { ...g.cards },
    tonight: { ...g.tonight },
    sweep: g.sweep,
    solutions: d.solutions,
    difficultyPoints: d.points,
    playerCount: g.playerCount,
  };
}

/** 公式（只看原始資料）。每項各自封頂，總分上限 1000。 */
export function computeScore(raw: ScoreRaw): ScoreBreakdown {
  const mission = PER_STAR * raw.stars;

  let teamwork = 0;
  if (raw.repairMs !== null && raw.repairLimitMs > 0) {
    const speed = Math.round(REPAIR_SPEED_MAX * clamp01(1 - raw.repairMs / raw.repairLimitMs));
    teamwork = speed + NO_ASSIST_POINTS[raw.assistLevel];
  }

  const time = Math.round(PARTS.time * clamp01((TIME_UP_AT - raw.finishedAt) / (TIME_UP_AT - TIME_FULL_AT)));

  // 難度加成：這局局面的難度分＋風暴捲走加分，再乘「顧好幾件 ÷ 3」（沒顧好事情就拿不到難度加成）
  const base = Math.min(DIFF_MAX, Math.max(0, raw.difficultyPoints)) + (raw.sweep ? SWEEP_BONUS : 0);
  const difficulty = Math.round(Math.min(PARTS.difficulty, base) * (raw.stars / 3));

  const factor = PLAYER_FACTOR[raw.playerCount] ?? 1;
  const total = Math.min(SCORE_MAX, Math.max(0, Math.round((mission + teamwork + time + difficulty) * factor)));
  return { mission, teamwork, time, difficulty, factor, total, trial: true, formula: FORMULA_VERSION };
}

export function scoreOf(g: GameState): { raw: ScoreRaw; score: ScoreBreakdown } | null {
  const raw = rawOf(g);
  return raw ? { raw, score: computeScore(raw) } : null;
}
