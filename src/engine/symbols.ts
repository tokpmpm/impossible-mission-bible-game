// 停電修復用的符號：外形 × 缺口數 × 開口方向，可以用說的描述。
// 產生器用可重現的亂數，方便測試；符號內容不屬於規則引擎，由房間層決定要用哪一組。

export const SHAPES = ['圓', '方', '三角'] as const;
export const GAPS = [1, 2, 3] as const;
export const DIRS = ['上', '下', '左', '右'] as const;

export type Shape = (typeof SHAPES)[number];
export type Dir = (typeof DIRS)[number];

export interface SymbolSpec {
  shape: Shape;
  gaps: number;
  dir: Dir;
}

export function symbolId(s: SymbolSpec): string {
  return `${s.shape}-${s.gaps}-${s.dir}`;
}

export function parseSymbol(id: string): SymbolSpec {
  const [shape, gaps, dir] = id.split('-');
  return { shape: shape as Shape, gaps: Number(gaps), dir: dir as Dir };
}

export function describeSymbol(s: SymbolSpec): string {
  const shapeText = s.shape === '圓' ? '圓形' : s.shape === '方' ? '方形' : '三角形';
  return `${shapeText}，${s.gaps} 個缺口，開口朝${s.dir}`;
}

/** mulberry32：小而可重現的亂數。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

function shuffle<T>(r: () => number, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 一格：正確符號＋8 個相似選項（7 個只差一項特徵、1 個差兩項）。 */
export function makeSlot(r: () => number): { options: string[]; answer: string } {
  const answer: SymbolSpec = { shape: pick(r, SHAPES), gaps: pick(r, GAPS), dir: pick(r, DIRS) };
  const one: SymbolSpec[] = [
    ...SHAPES.filter((x) => x !== answer.shape).map((shape) => ({ ...answer, shape })),
    ...GAPS.filter((x) => x !== answer.gaps).map((gaps) => ({ ...answer, gaps })),
    ...DIRS.filter((x) => x !== answer.dir).map((dir) => ({ ...answer, dir })),
  ];
  const two: SymbolSpec = {
    ...answer,
    shape: pick(r, SHAPES.filter((x) => x !== answer.shape)),
    dir: pick(r, DIRS.filter((x) => x !== answer.dir)),
  };
  const options = shuffle(r, [answer, ...one, two].map(symbolId));
  return { options, answer: symbolId(answer) };
}

export function makeSlots(count: number, seed: number): { options: string[]; answer: string }[] {
  const r = rng(seed);
  const slots: { options: string[]; answer: string }[] = [];
  while (slots.length < count) {
    const s = makeSlot(r);
    if (!slots.some((x) => x.answer === s.answer)) slots.push(s);
  }
  return slots;
}

/**
 * 排除線索：每條是一句真話，說「第 N 格的正確符號不是…」，而且至少排除一個該格的錯誤選項。
 * 會輪流分配到各格，彼此不重複。
 */
export function makeEliminationClues(slots: { options: string[]; answer: string }[], count: number, seed: number): string[] {
  const r = rng(seed ^ 0x9e3779b9);
  const pool: string[][] = slots.map((slot, i) => {
    const ans = parseSymbol(slot.answer);
    const wrong = slot.options.filter((o) => o !== slot.answer).map(parseSymbol);
    const n = i + 1;
    const clues = new Set<string>();
    for (const w of wrong) {
      if (w.shape !== ans.shape) clues.add(`第 ${n} 格的正確符號不是${w.shape === '圓' ? '圓形' : w.shape === '方' ? '方形' : '三角形'}。`);
      if (w.gaps !== ans.gaps) clues.add(`第 ${n} 格的正確符號沒有 ${w.gaps} 個缺口。`);
      if (w.dir !== ans.dir) clues.add(`第 ${n} 格的正確符號開口不朝${w.dir}。`);
    }
    return shuffle(r, [...clues]);
  });
  const out: string[] = [];
  let i = 0;
  while (out.length < count && pool.some((p) => p.length > 0)) {
    const p = pool[i % pool.length];
    const c = p.shift();
    if (c) out.push(c);
    i++;
  }
  return out;
}
