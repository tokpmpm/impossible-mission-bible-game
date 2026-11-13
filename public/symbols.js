// 停電修復用的符號圖：代號格式「外形-缺口數-方向」，例如「三角-2-左」。
// 三個特徵都要看得出來、能用嘴巴描述：
//   外形：圓／方／三角（輪廓）
//   缺口數：輪廓上切出 1–3 個小缺口
//   開口方向：朝該方向有一個明顯較大的開口，外面再加一個箭頭
// 只畫圖，不涉及任何規則。

const SIZE = 100;
const C = { x: 50, y: 52 };

/** 解析代號；格式不對時回傳 null。 */
export function parseSymbol(id) {
  const parts = String(id).split('-');
  if (parts.length !== 3) return null;
  const [shape, gaps, dir] = parts;
  if (!['圓', '方', '三角'].includes(shape)) return null;
  if (!['上', '下', '左', '右'].includes(dir)) return null;
  const n = Number(gaps);
  if (!(n >= 1 && n <= 3)) return null;
  return { shape, gaps: n, dir };
}

/** 與伺服器 describeSymbol 相同的描述文字。 */
export function describeSymbol(id) {
  const s = parseSymbol(id);
  if (!s) return String(id);
  const shapeText = s.shape === '圓' ? '圓形' : s.shape === '方' ? '方形' : '三角形';
  return `${shapeText}，${s.gaps} 個缺口，開口朝${s.dir}`;
}

function outline(shape) {
  if (shape === '圓') {
    const pts = [];
    const r = 34;
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push([C.x + r * Math.cos(a), C.y + r * Math.sin(a)]);
    }
    return pts;
  }
  if (shape === '方') {
    const h = 31;
    return [
      [C.x - h, C.y - h],
      [C.x + h, C.y - h],
      [C.x + h, C.y + h],
      [C.x - h, C.y + h],
    ];
  }
  // 三角：頂點朝上的正三角形，重心在 C
  const R = 40;
  return [-90, 30, 150].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return [C.x + R * Math.cos(a), C.y + 4 + R * Math.sin(a)];
  });
}

const DIR_VEC = { 上: [0, -1], 下: [0, 1], 左: [-1, 0], 右: [1, 0] };

function buildPerimeter(pts) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, s: total, len });
    total += len;
  }
  return { segs, total };
}

function pointAt(per, s) {
  s = ((s % per.total) + per.total) % per.total;
  for (const seg of per.segs) {
    if (s <= seg.s + seg.len) {
      const t = seg.len ? (s - seg.s) / seg.len : 0;
      return [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t];
    }
  }
  return per.segs[0].a;
}

/** 從 s0 畫到 s1（s1 > s0，可超過一圈長度），經過的頂點都保留，角才會尖。 */
function arcPath(per, s0, s1) {
  const p0 = pointAt(per, s0);
  let d = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}`;
  for (let k = 0; k <= 1; k++) {
    for (const seg of per.segs) {
      const vs = seg.s + k * per.total;
      if (vs > s0 && vs < s1) d += `L${seg.a[0].toFixed(1)} ${seg.a[1].toFixed(1)}`;
    }
  }
  const p1 = pointAt(per, s1);
  d += `L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
  return d;
}

/** 輪廓上最朝向 dir 的位置（周長參數 s）。 */
function facingS(per, dir) {
  const [vx, vy] = DIR_VEC[dir];
  let best = 0;
  let bestDot = -Infinity;
  const steps = 720;
  for (let i = 0; i < steps; i++) {
    const s = (i / steps) * per.total;
    const p = pointAt(per, s);
    const dx = p[0] - C.x;
    const dy = p[1] - C.y;
    const len = Math.hypot(dx, dy) || 1;
    const dot = (dx * vx + dy * vy) / len;
    if (dot > bestDot + 1e-9) {
      bestDot = dot;
      best = s;
    }
  }
  return best;
}

/**
 * 產生符號 SVG 字串。
 * @param {string} id 例如「三角-2-左」
 * @param {{size?: number, title?: string}} [opt]
 */
export function symbolSvg(id, opt = {}) {
  const s = parseSymbol(id);
  const size = opt.size || 88;
  const label = opt.title || describeSymbol(id);
  if (!s) {
    return `<svg class="sym" viewBox="0 0 ${SIZE} ${SIZE}" width="${size}" height="${size}" role="img" aria-label="${label}"><text x="50" y="55" text-anchor="middle" font-size="14" fill="currentColor">?</text></svg>`;
  }
  const per = buildPerimeter(outline(s.shape));
  const P = per.total;
  const open = P * 0.2; // 大開口
  const gap = P * 0.065; // 小缺口
  const center = facingS(per, s.dir);
  const openStart = center + open / 2; // 開口結束處，開始畫實線
  const openEnd = center - open / 2 + P; // 回到開口前
  const avail = openEnd - openStart;
  // 小缺口平均分布在剩下的輪廓上
  const cuts = [];
  for (let k = 1; k <= s.gaps; k++) {
    const mid = openStart + (avail * k) / (s.gaps + 1);
    cuts.push([mid - gap / 2, mid + gap / 2]);
  }
  const paths = [];
  let cur = openStart;
  for (const [a, b] of cuts) {
    paths.push(arcPath(per, cur, a));
    cur = b;
  }
  paths.push(arcPath(per, cur, openEnd));

  // 開口外的箭頭
  const [vx, vy] = DIR_VEC[s.dir];
  const tip = pointAt(per, center);
  const base = [tip[0] + vx * 4, tip[1] + vy * 4];
  const head = [tip[0] + vx * 14, tip[1] + vy * 14];
  const px = -vy;
  const py = vx;
  const arrow = `M${(base[0] + px * 7).toFixed(1)} ${(base[1] + py * 7).toFixed(1)}L${head[0].toFixed(1)} ${head[1].toFixed(1)}L${(base[0] - px * 7).toFixed(1)} ${(base[1] - py * 7).toFixed(1)}Z`;

  return `<svg class="sym" viewBox="-6 -6 ${SIZE + 12} ${SIZE + 12}" width="${size}" height="${size}" role="img" aria-label="${label}">
<title>${label}</title>
<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="butt" stroke-linejoin="round">${paths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</g>
<path d="${arrow}" class="sym-arrow"/>
</svg>`;
}
