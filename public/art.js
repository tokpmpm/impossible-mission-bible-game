// 第一關「保羅海難」（使徒行傳 27 章）的插畫與動畫。
// 全部是純函式，回傳 SVG 字串，可直接塞進 innerHTML；不碰 DOM、零依賴、不用外部圖庫。
// 動畫全部寫在 art.css（keyframes＋class），這裡只負責畫圖與掛 class。
//
// 動畫設計原則：每個會動的元素，「靜止時」的樣子就是動畫的最終狀態，
// keyframes 只描述「從哪裡來」。所以 prefers-reduced-motion 把 animation 關掉時，
// 畫面自然停在最終狀態（東西已漂在海上、人都上了岸、火已生起）。
//
// 注意：會被 CSS 動畫改 transform 的 <g>，絕對不放 transform 屬性（CSS 會蓋掉它），
// 位置一律交給外層或內層另一個 <g transform="...">。

// ───────────────────────── 色彩 ─────────────────────────
const C = {
  navy: '#0b1d3a',
  card: '#13294d',
  card2: '#1b3262',
  gold: '#f2c14e',
  gold2: '#ffd97a',
  goldDeep: '#c9932a',
  ink: '#2a1d00',
  text: '#f4f1e8',
  muted: '#b5c0d9',
  grey: '#8592ad',
  wood: '#9a6337',
  woodDark: '#6b3f1f',
  woodLight: '#c48a52',
  sail: '#efe6d0',
  steel: '#b4c2d4',
  steelDark: '#5d6e86',
  rope: '#d9b37a',
  sack: '#c8a06a',
  bread: '#e3a24f',
  sea: '#1f6696',
  seaDark: '#123f66',
  foam: '#dceefa',
  red: '#ff6b6b',
  sand: '#e9cf96',
};

// 統一的深色描邊，讓圖示在深色背景與木頭甲板上都清楚
const INK = `stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"`;

// 同一頁可能有多個 SVG：漸層等 id 加流水號避免互相干擾
let uidSeq = 0;
const uid = (p) => `art-${p}-${++uidSeq}`;

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/** 帶深色外框的粗線（先畫深色粗線，再畫彩色細線），適合錨、繩子等線狀物。 */
function ol(d, color, w = 3, extra = '') {
  return (
    `<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${w + 2.4}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`
  );
}

function svgOpen({ viewBox, size, label, cls = '', extra = '' }) {
  const dims = size ? `width="${size}" height="${size}"` : 'width="100%"';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="art ${cls}" viewBox="${viewBox}" ${dims} role="img" aria-label="${esc(label)}" ${extra}>`;
}

// ───────────────────────── 1. 船上的東西 ─────────────────────────
// 座標都在 40×40 的方格內。

export const ITEM_ORDER = ['糧食', '纜索', '錨', '麥子', '器具', '小船'];

const ITEM_LABEL = {
  糧食: '糧食：一袋糧食和一個餅',
  纜索: '纜索：一捆繩子',
  錨: '錨',
  麥子: '麥子：麥穗和貨袋',
  器具: '器具：帆、滑輪和索具',
  小船: '小船：一艘小艇',
};

function anchorShape(color = C.steel, w = 3) {
  return (
    ol('M20 11 L20 34', color, w) +
    ol('M12 15 L28 15', color, w) +
    ol('M8 24 Q10 34 20 35 Q30 34 32 24', color, w) +
    `<path d="M5 26 L9 20 L12 27 Z" fill="${color}" ${INK}/>` +
    `<path d="M35 26 L31 20 L28 27 Z" fill="${color}" ${INK}/>` +
    `<circle cx="20" cy="7.5" r="3.6" fill="none" stroke="${C.ink}" stroke-width="${w + 2.4}"/>` +
    `<circle cx="20" cy="7.5" r="3.6" fill="none" stroke="${color}" stroke-width="${w}"/>`
  );
}

function crateShape() {
  return (
    `<rect x="6" y="10" width="28" height="24" rx="2.5" fill="${C.woodLight}" ${INK}/>` +
    `<path d="M6 18 H34 M6 26 H34" stroke="${C.woodDark}" stroke-width="1.2"/>` +
    `<path d="M8 12 L32 32 M32 12 L8 32" stroke="${C.woodDark}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<rect x="6" y="10" width="28" height="24" rx="2.5" fill="none" ${INK}/>`
  );
}

function itemArt(id) {
  switch (id) {
    case '糧食':
      return (
        // 麻袋
        `<path d="M9 14 Q8 10 12 10 L23 10 Q27 10 26 14 L28 30 Q28 35 23 35 L11 35 Q6 35 7 30 Z" fill="${C.sack}" ${INK}/>` +
        `<path d="M13 8 Q17.5 3 22 8 L21 11 L14 11 Z" fill="${C.sack}" ${INK}/>` +
        `<path d="M11 12.5 Q17.5 15 24 12.5" fill="none" stroke="${C.woodDark}" stroke-width="1.8" stroke-linecap="round"/>` +
        `<path d="M11 21 l3 0 M19 25 l3 0 M12 29 l3 0" stroke="${C.woodDark}" stroke-width="1" stroke-linecap="round"/>` +
        // 餅
        `<ellipse cx="26" cy="29" rx="11" ry="7" fill="${C.bread}" ${INK}/>` +
        `<ellipse cx="26" cy="27.5" rx="8" ry="4" fill="#f0bd6c"/>` +
        `<path d="M20.5 28 l2.5 -3 M25.5 28.5 l2.5 -3.5 M30.5 28.5 l2 -3" stroke="${C.ink}" stroke-width="1.3" stroke-linecap="round"/>`
      );
    case '纜索':
      return (
        `<ellipse cx="19" cy="24" rx="15" ry="10.5" fill="${C.rope}" ${INK}/>` +
        `<ellipse cx="19" cy="23.2" rx="10.5" ry="7" fill="none" stroke="${C.ink}" stroke-width="1.2"/>` +
        `<ellipse cx="19" cy="22.6" rx="6" ry="3.8" fill="#6b4a22" ${INK}/>` +
        // 繩子的扭紋
        `<path d="M7 20 l2 2 M10 15.5 l1.5 2.2 M16 13.6 l0.8 2.4 M23 13.8 l-0.6 2.4 M29 16 l-1.5 2 M32 21 l-2 1.5 M9 29 l2 -1.6 M15 32.5 l1 -2.2 M23 32.5 l-0.8 -2.2 M29.5 29.5 l-2 -1.6" stroke="${C.woodDark}" stroke-width="1.1" stroke-linecap="round"/>` +
        // 鬆開的繩頭
        ol('M32 27 Q38 31 34 37', C.rope, 3)
      );
    case '錨':
      return anchorShape();
    case '麥子':
      return (
        // 麥穗從袋口冒出
        ol('M20 14 L15 3', '#d9a83a', 1.4) +
        ol('M20 14 L20 2', '#d9a83a', 1.4) +
        ol('M20 14 L25 3', '#d9a83a', 1.4) +
        [
          [15.5, 4.5, -25],
          [16.8, 7.4, -25],
          [20, 3.2, 0],
          [20, 6.4, 0],
          [24.5, 4.5, 25],
          [23.2, 7.4, 25],
        ]
          .map(
            ([x, y, r]) =>
              `<ellipse cx="${x}" cy="${y}" rx="1.9" ry="3" transform="rotate(${r} ${x} ${y})" fill="${C.gold}" stroke="${C.ink}" stroke-width="0.9"/>`,
          )
          .join('') +
        // 貨袋
        `<path d="M8 17 Q8 13 12 13 L28 13 Q32 13 32 17 L33 32 Q33 36 29 36 L11 36 Q7 36 7 32 Z" fill="#eadcae" ${INK}/>` +
        `<path d="M10 15.5 Q20 18 30 15.5" fill="none" stroke="${C.woodDark}" stroke-width="1.6"/>` +
        // 袋上的麥穗印記
        `<path d="M20 33 L20 21 M20 24 l-3 -2.5 M20 24 l3 -2.5 M20 28 l-3 -2.5 M20 28 l3 -2.5" stroke="${C.goldDeep}" stroke-width="1.6" stroke-linecap="round" fill="none"/>`
      );
    case '器具':
      return (
        // 桅桿＋帆
        ol('M12 4 L12 37', C.woodLight, 2.4) +
        `<path d="M14.5 6 L14.5 31 L33 31 Z" fill="${C.sail}" ${INK}/>` +
        `<path d="M14.5 14 L22 31 M14.5 22 L27 31" stroke="#cbbf9f" stroke-width="1"/>` +
        // 滑輪＋索具
        ol('M12 6 L30 9', C.rope, 1.4) +
        `<rect x="26.5" y="6.5" width="7" height="9" rx="3" fill="${C.woodLight}" ${INK}/>` +
        `<circle cx="30" cy="11" r="2" fill="${C.steelDark}" stroke="${C.ink}" stroke-width="1"/>` +
        ol('M31.5 15.5 L35 31', C.rope, 1.4) +
        ol('M5 37 L35 37', C.woodDark, 2)
      );
    case '小船':
      return (
        // 槳
        ol('M9 9 L29 29', C.woodLight, 2) +
        `<ellipse cx="31.5" cy="31.5" rx="2.6" ry="5" transform="rotate(-45 31.5 31.5)" fill="${C.woodLight}" ${INK}/>` +
        // 小艇
        `<path d="M3 20 L37 20 Q34 32 25 33 L15 33 Q6 32 3 20 Z" fill="#b5713f" ${INK}/>` +
        `<path d="M5.5 25 Q20 27 35 25" fill="none" stroke="${C.woodDark}" stroke-width="1.2"/>` +
        `<path d="M3 20 L37 20" stroke="${C.woodLight}" stroke-width="2.4" stroke-linecap="round"/>` +
        `<path d="M3 20 L37 20 Q34 32 25 33 L15 33 Q6 32 3 20 Z" fill="none" ${INK}/>`
      );
    default:
      return crateShape();
  }
}

/** 船上的東西圖示。未知 id 畫一個箱子。 */
export function item(id, size = 40) {
  const label = ITEM_LABEL[id] || `箱子：${id ?? '未知的東西'}`;
  return `${svgOpen({ viewBox: '0 0 40 40', size, label, cls: 'art-item', extra: `data-item="${esc(id ?? '')}"` })}${itemArt(id)}</svg>`;
}

// ───────────────────────── 2. 上岸三件事 ─────────────────────────

function needArt(id, lit) {
  // 亮：金色實心＋深色描邊；不亮：空心、灰色虛線輪廓（形狀相同，不只靠顏色）
  const f = (light) => (lit ? (light ? C.gold2 : C.gold) : 'none');
  const s = lit
    ? `stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"`
    : `stroke="${C.grey}" stroke-width="1.8" stroke-dasharray="3 2.2" stroke-linejoin="round" stroke-linecap="round"`;
  const line = lit ? C.ink : C.grey;
  switch (id) {
    case '力氣':
      return (
        `<ellipse cx="20" cy="24" rx="15" ry="10" fill="${f(false)}" ${s}/>` +
        `<path d="M8 21 Q20 9 32 21" fill="${f(true)}" ${s}/>` +
        `<path d="M13 22 l3 -4 M19 21 l3 -4.5 M25 22 l3 -4" stroke="${line}" stroke-width="1.6" stroke-linecap="round"/>`
      );
    case '船身':
      return (
        `<path d="M3 15 L37 15 Q35 30 23 32 L17 32 Q5 30 3 15 Z" fill="${f(false)}" ${s}/>` +
        `<path d="M3 15 L37 15" stroke="${line}" stroke-width="2.2" stroke-linecap="round"/>` +
        // 兩道繩子繞過船底
        `<path d="M12 11 Q11 24 14 33" fill="none" stroke="${lit ? C.ink : C.grey}" stroke-width="${lit ? 4.6 : 3}" stroke-linecap="round"/>` +
        `<path d="M27 11 Q28 24 25 33" fill="none" stroke="${lit ? C.ink : C.grey}" stroke-width="${lit ? 4.6 : 3}" stroke-linecap="round"/>` +
        (lit
          ? `<path d="M12 11 Q11 24 14 33 M27 11 Q28 24 25 33" fill="none" stroke="${C.rope}" stroke-width="2.4" stroke-dasharray="2 1.4" stroke-linecap="round"/>`
          : '')
      );
    case '天亮':
      return (
        // 日出（太陽＋光芒）
        `<path d="M11 24 A9 9 0 0 1 29 24 Z" fill="${f(true)}" ${s}/>` +
        `<path d="M20 9 L20 12 M9 14 L11 16 M31 14 L29 16 M5 21 L8 21.5 M35 21 L32 21.5" stroke="${line}" stroke-width="1.8" stroke-linecap="round"/>` +
        `<path d="M3 24 L37 24" stroke="${line}" stroke-width="2" stroke-linecap="round"/>` +
        // 小錨
        `<g transform="translate(13.5 25) scale(0.34)">` +
        `<path d="M20 4 L20 34 M12 13 L28 13 M7 24 Q10 35 20 36 Q30 35 33 24" fill="none" stroke="${lit ? C.ink : C.grey}" stroke-width="${lit ? 6 : 5}" stroke-linecap="round"/>` +
        (lit ? `<path d="M20 4 L20 34 M12 13 L28 13 M7 24 Q10 35 20 36 Q30 35 33 24" fill="none" stroke="${C.gold}" stroke-width="3" stroke-linecap="round"/>` : '') +
        `</g>`
      );
    default:
      return `<circle cx="20" cy="20" r="13" fill="${f(false)}" ${s}/>`;
  }
}

const NEED_LABEL = { 力氣: '大家有力氣（餅）', 船身: '船身撐得住（纜索捆綁船身）', 天亮: '平安等到天亮（錨與日出）' };

/** 上岸三件事圖示。lit=true 金色實心並帶 class need-lit。 */
export function need(id, lit, size = 40) {
  const label = `${NEED_LABEL[id] || id}：${lit ? '已顧好' : '還沒顧好'}`;
  const cls = `art-need ${lit ? 'need-lit' : 'need-off'}`;
  return `${svgOpen({ viewBox: '0 0 40 40', size, label, cls, extra: `data-need="${esc(id)}"` })}${needArt(id, !!lit)}</svg>`;
}

// ───────────────────────── 3. 職能圖示 ─────────────────────────
// 32×32，外圈一個圓形徽章，讓所有職能圖示風格一致、在任何底色上都清楚。

const ROLE_LABEL = {
  nav: '船長（舵輪）',
  supply: '管倉（木箱）',
  comms: '伙房（湯鍋）',
  eng: '木匠（槌子）',
  medic: '醫生（藥袋）',
  observer: '瞭望（望遠鏡）',
  scout: '測水深（鉛錘繩）',
  liaison: '船主（錢袋）',
  store: '水手長（繩結）',
  backup: '舵手（羅盤）',
};

function roleArt(id) {
  switch (id) {
    case 'nav': {
      let spokes = '';
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const x1 = 16 + Math.cos(a) * 2.5;
        const y1 = 16 + Math.sin(a) * 2.5;
        const x2 = 16 + Math.cos(a) * 10.2;
        const y2 = 16 + Math.sin(a) * 10.2;
        spokes += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${C.gold}" stroke-width="1.8" stroke-linecap="round"/>`;
        spokes += `<circle cx="${(16 + Math.cos(a) * 10.6).toFixed(2)}" cy="${(16 + Math.sin(a) * 10.6).toFixed(2)}" r="1.4" fill="${C.gold}"/>`;
      }
      return `${spokes}<circle cx="16" cy="16" r="6.8" fill="none" stroke="${C.gold}" stroke-width="2.2"/><circle cx="16" cy="16" r="2.4" fill="${C.text}"/>`;
    }
    case 'supply':
      return `<g transform="translate(4 3.5) scale(0.6)">${crateShape()}</g>`;
    case 'comms':
      return (
        `<path d="M12 7 q-2 2 0 4 t0 4 M16 6 q-2 2 0 4 t0 4 M20 7 q-2 2 0 4 t0 4" fill="none" stroke="${C.text}" stroke-width="1.4" stroke-linecap="round" opacity="0.9"/>` +
        `<path d="M7 16 L25 16 L23.5 24 Q23 26 21 26 L11 26 Q9 26 8.5 24 Z" fill="${C.steel}" ${INK}/>` +
        `<path d="M5 17.5 H8 M24 17.5 H27" stroke="${C.steel}" stroke-width="2.4" stroke-linecap="round"/>` +
        `<rect x="6" y="14.5" width="20" height="2.6" rx="1.3" fill="${C.gold}" ${INK}/>`
      );
    case 'eng':
      return (
        `<path d="M10 25 L19.5 13.5" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>` +
        `<path d="M10 25 L19.5 13.5" stroke="${C.woodLight}" stroke-width="2.8" stroke-linecap="round"/>` +
        `<g transform="rotate(40 20 12)"><rect x="13" y="8.5" width="14" height="6.5" rx="1.5" fill="${C.steel}" ${INK}/><rect x="13" y="8.5" width="3" height="6.5" fill="${C.steelDark}"/></g>`
      );
    case 'medic':
      return (
        `<path d="M12.5 11 Q12.5 6.5 16 6.5 Q19.5 6.5 19.5 11" fill="none" stroke="${C.text}" stroke-width="1.8"/>` +
        `<rect x="7" y="10.5" width="18" height="14.5" rx="3" fill="#d96a5b" ${INK}/>` +
        `<path d="M16 13.5 V22 M11.8 17.8 H20.2" stroke="${C.text}" stroke-width="3" stroke-linecap="round"/>`
      );
    case 'observer':
      return (
        `<g transform="rotate(-28 16 16)">` +
        `<rect x="4" y="13" width="9" height="7" rx="1.5" fill="${C.gold}" ${INK}/>` +
        `<rect x="12.5" y="13.8" width="8" height="5.4" rx="1" fill="${C.goldDeep}" ${INK}/>` +
        `<rect x="20" y="14.5" width="7" height="4" rx="1" fill="${C.gold}" ${INK}/>` +
        `<ellipse cx="4.6" cy="16.5" rx="1.2" ry="3.2" fill="#8fd0ff" stroke="${C.ink}" stroke-width="1"/>` +
        `</g>`
      );
    case 'scout':
      return (
        `<path d="M5 20 q2.75 -2 5.5 0 t5.5 0 t5.5 0 t5.5 0" fill="none" stroke="#6fb6e8" stroke-width="1.6" stroke-linecap="round"/>` +
        `<path d="M16 5 L16 20" stroke="${C.rope}" stroke-width="1.6"/>` +
        `<path d="M14 8.5 H18 M14 12 H18 M14 15.5 H18" stroke="${C.text}" stroke-width="1.4" stroke-linecap="round"/>` +
        `<path d="M16 20 L12.5 25 Q16 29 19.5 25 Z" fill="${C.steelDark}" stroke="${C.text}" stroke-width="1.3" stroke-linejoin="round"/>`
      );
    case 'liaison':
      return (
        `<path d="M12 9 Q16 6 20 9 L18.5 12 L13.5 12 Z" fill="${C.sack}" ${INK}/>` +
        `<path d="M13.5 12 Q6 17 7.5 23 Q9 27 16 27 Q23 27 24.5 23 Q26 17 18.5 12 Z" fill="${C.sack}" ${INK}/>` +
        `<path d="M12.5 12 H19.5" stroke="${C.woodDark}" stroke-width="2" stroke-linecap="round"/>` +
        `<circle cx="16" cy="20.5" r="3.6" fill="${C.gold}" ${INK}/>` +
        `<path d="M16 18.6 V22.4" stroke="${C.ink}" stroke-width="1.2"/>`
      );
    case 'store':
      // 八字結
      return (
        `<g transform="translate(3 3) scale(0.8125)">` +
        ol('M6 30 Q12 30 16 24 Q22 14 16 9 Q10 4 8 10 Q6 16 16 20 Q26 24 24 30 Q22 36 16 30 Q12 26 17 18 Q20 12 26 10', C.rope, 3.2) +
        `</g>`
      );
    case 'backup':
      return (
        `<circle cx="16" cy="16" r="9.5" fill="${C.text}" ${INK}/>` +
        `<path d="M16 7.5 V9.5 M16 22.5 V24.5 M7.5 16 H9.5 M22.5 16 H24.5" stroke="${C.ink}" stroke-width="1.3"/>` +
        `<path d="M16 9 L19 16 L13 16 Z" fill="${C.red}" stroke="${C.ink}" stroke-width="1"/>` +
        `<path d="M16 23 L19 16 L13 16 Z" fill="${C.steelDark}" stroke="${C.ink}" stroke-width="1"/>` +
        `<circle cx="16" cy="16" r="1.4" fill="${C.ink}"/>` +
        `<text x="16" y="6.8" text-anchor="middle" font-size="4.5" font-weight="700" fill="${C.gold}" font-family="system-ui,sans-serif">N</text>`
      );
    default:
      return `<text x="16" y="21" text-anchor="middle" font-size="14" font-weight="700" fill="${C.gold}" font-family="system-ui,sans-serif">?</text>`;
  }
}

/** 職能圖示（圓形徽章）。 */
export function role(id, size = 32) {
  const label = ROLE_LABEL[id] || `職能 ${id}`;
  return (
    svgOpen({ viewBox: '0 0 32 32', size, label, cls: 'art-role', extra: `data-role="${esc(id)}"` }) +
    `<circle cx="16" cy="16" r="15.2" fill="${C.card2}" stroke="${C.gold}" stroke-width="1.2"/>` +
    roleArt(id) +
    `</svg>`
  );
}

// ───────────────────────── 4. 背包物品 ─────────────────────────

const PREF_LABEL = { lamp: '油燈', coat: '外衣', nuts: '乾果', song: '一首歌（音符）' };

function prefArt(id) {
  switch (id) {
    case 'lamp':
      return (
        `<path d="M16 5 Q19 9 16 12 Q13 9 16 5 Z" fill="${C.gold2}" stroke="${C.goldDeep}" stroke-width="1"/>` +
        `<path d="M6 18 Q6 13 14 13 L19 13 Q26 13 27 16 L22 17 Q24 22 16 23 Q7 23 6 18 Z" fill="${C.woodLight}" ${INK}/>` +
        `<ellipse cx="15" cy="15" rx="2.5" ry="1.2" fill="${C.ink}"/>` +
        `<path d="M11 23 L10 26 H22 L21 23" fill="${C.wood}" ${INK}/>`
      );
    case 'coat':
      return (
        `<path d="M12 6 L20 6 L27 11 L24.5 15 L22 13.5 L23 27 L9 27 L10 13.5 L7.5 15 L5 11 Z" fill="#7a9cc6" ${INK}/>` +
        `<path d="M12 6 Q16 11 20 6" fill="none" stroke="${C.ink}" stroke-width="1.4"/>` +
        `<path d="M16 9.5 V27" stroke="${C.ink}" stroke-width="1.2"/>` +
        `<path d="M10 21 H22" stroke="${C.gold}" stroke-width="1.6"/>`
      );
    case 'nuts':
      return [
        [11, 14, -20],
        [20, 13, 25],
        [15.5, 22, 5],
      ]
        .map(
          ([x, y, r]) =>
            `<g transform="rotate(${r} ${x} ${y})"><path d="M${x} ${y - 6} Q${x + 5} ${y} ${x} ${y + 5} Q${x - 5} ${y} ${x} ${y - 6} Z" fill="#b97a45" ${INK}/>` +
            `<path d="M${x} ${y - 3.5} Q${x + 1} ${y} ${x} ${y + 3}" fill="none" stroke="${C.woodDark}" stroke-width="1"/></g>`,
        )
        .join('');
    case 'song':
      return (
        `<path d="M12 22 V9 L24 6.5 V19.5" fill="none" stroke="${C.gold}" stroke-width="2.2" stroke-linejoin="round"/>` +
        `<path d="M12 9 L24 6.5 L24 10 L12 12.5 Z" fill="${C.gold}"/>` +
        `<ellipse cx="9.5" cy="22.5" rx="3.4" ry="2.6" transform="rotate(-20 9.5 22.5)" fill="${C.gold}"/>` +
        `<ellipse cx="21.5" cy="20" rx="3.4" ry="2.6" transform="rotate(-20 21.5 20)" fill="${C.gold}"/>`
      );
    default:
      return `<text x="16" y="21" text-anchor="middle" font-size="14" font-weight="700" fill="${C.gold}" font-family="system-ui,sans-serif">?</text>`;
  }
}

/** 背包物品圖示（圓角方形徽章）。 */
export function pref(id, size = 32) {
  const label = PREF_LABEL[id] || `背包物品 ${id}`;
  return (
    svgOpen({ viewBox: '0 0 32 32', size, label, cls: 'art-pref', extra: `data-pref="${esc(id)}"` }) +
    `<rect x="0.8" y="0.8" width="30.4" height="30.4" rx="8" fill="${C.card2}" stroke="${C.gold}" stroke-width="1.2"/>` +
    prefArt(id) +
    `</svg>`
  );
}

// ───────────────────────── 共用：小人、船 ─────────────────────────

/**
 * 簡單剪影小人，腳底在 (x, y)，身高 h。不畫臉。
 * opt.raise：舉起一隻手（勸阻）；opt.helmet：頭頂羽冠（百夫長）
 */
function person(x, y, h, color, opt = {}) {
  const r = h * 0.14;
  const hy = y - h + r;
  const top = hy + r + h * 0.04;
  const sw = h * 0.2;
  const bw = h * 0.24;
  let s = '';
  if (opt.raise) {
    const dir = opt.raise === 'left' ? -1 : 1;
    s += `<path d="M${x + dir * sw * 0.6} ${top + h * 0.08} L${x + dir * sw * 1.4} ${top - h * 0.22}" stroke="${color}" stroke-width="${h * 0.09}" stroke-linecap="round"/>`;
    s += `<circle cx="${x + dir * sw * 1.45}" cy="${top - h * 0.26}" r="${h * 0.065}" fill="${color}"/>`;
  }
  if (opt.helmet) {
    s += `<path d="M${x - r * 0.9} ${hy - r * 0.6} Q${x} ${hy - r * 2.4} ${x + r * 0.9} ${hy - r * 0.6} Z" fill="${opt.helmet}"/>`;
  }
  s += `<circle cx="${x}" cy="${hy}" r="${r}" fill="${color}"/>`;
  s += `<path d="M${x - sw} ${top + h * 0.06} Q${x - sw} ${top} ${x - sw * 0.6} ${top} L${x + sw * 0.6} ${top} Q${x + sw} ${top} ${x + sw} ${top + h * 0.06} L${x + bw} ${y} L${x - bw} ${y} Z" fill="${color}"/>`;
  return `<g class="person">${s}</g>`;
}

/** 頭＋肩的小人頭像（用於很多人的畫面）。 */
function bust(x, y, r, color, extra = '') {
  x = +x; y = +y; r = +r;
  const f = (v) => +v.toFixed(2);
  return `<g ${extra}><circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${color}"/><path d="M${f(x - r * 1.6)} ${f(y + r * 2.6)} Q${f(x - r * 1.6)} ${f(y + r * 1.15)} ${f(x)} ${f(y + r * 1.15)} Q${f(x + r * 1.6)} ${f(y + r * 1.15)} ${f(x + r * 1.6)} ${f(y + r * 2.6)} Z" fill="${color}"/></g>`;
}

/** 一般的船身（側面，船頭朝右），局部座標：甲板 y=0、寬 0~w。 */
function simpleHull(w, h, fill = C.wood) {
  return (
    `<path d="M0 -6 L8 0 L${w - 12} 0 L${w} -10 Q${w - 4} ${h * 0.7} ${w - 26} ${h} L22 ${h} Q4 ${h * 0.8} 0 -6 Z" fill="${fill}" ${INK}/>` +
    `<path d="M6 ${h * 0.35} Q${w / 2} ${h * 0.42} ${w - 6} ${h * 0.25}" fill="none" stroke="${C.woodDark}" stroke-width="1.2"/>` +
    `<path d="M14 ${h * 0.7} Q${w / 2} ${h * 0.78} ${w - 20} ${h * 0.62}" fill="none" stroke="${C.woodDark}" stroke-width="1.2"/>`
  );
}

/** 水平方向重複的波浪路徑（往下封閉到 bottom，可當海面填色）。 */
function wavePath(y, amp, period, x0, x1, bottom) {
  let d = `M${x0} ${y}`;
  d += ` q${period / 4} ${-amp} ${period / 2} 0`;
  for (let x = x0 + period / 2; x < x1; x += period / 2) d += ` t${period / 2} 0`;
  if (bottom != null) d += ` L${x1 + period} ${bottom} L${x0} ${bottom} Z`;
  return d;
}

/** 斜雨。用格狀排列，往 (-10, 40) 平移一格就無縫循環。 */
function rain(w, h, color, opacity, cls = 'rain') {
  let s = '';
  const rows = Math.ceil(h / 40) + 2;
  const cols = Math.ceil(w / 18) + 4;
  for (let j = -1; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const jitter = ((i * 37) % 23) - 11; // 只跟 i 有關，平移一列仍無縫
      const x = 18 * i - 10 * j + (j % 2 ? 0 : 0);
      const y = 40 * j + jitter;
      s += `M${x} ${y} l-3 12 `;
    }
  }
  return `<g class="${cls}" opacity="${opacity}"><path d="${s}" stroke="${color}" stroke-width="1.1" stroke-linecap="round"/></g>`;
}

function lightningBolt(x, y, s = 1, cls = 'lightning') {
  return (
    `<g class="${cls}">` +
    `<rect x="-20" y="-20" width="400" height="300" fill="#e8e4ff" opacity="0.18"/>` +
    `<path transform="translate(${x} ${y}) scale(${s})" d="M0 0 L-8 22 L-2 22 L-10 44 L8 16 L1 16 L8 0 Z" fill="#fff8d6" stroke="#cfc6ff" stroke-width="1"/>` +
    `</g>`
  );
}

// ───────────────────────── 5. 故事卡插圖 ─────────────────────────

const CARD_LABEL = {
  A1: '保羅勸他們不要開船，百夫長卻信從船主：船主抱著麥子袋，一個人舉手勸阻',
  A2: '狂風從島上撲下來：島與強風',
  A3: '朋友照應，準備了一籃乾糧',
  A4: '用纜索捆綁船底：繩子繞過船身',
  A5: '亞里達古同去：兩個人並肩',
  B1: '把貨與器具拋在海裡：箱子落海',
  B2: '兵丁砍斷小船的繩子：小船漂走',
  B3: '船上共有 276 人',
  B4: '保羅站在眾人中間說：你們可以放心',
  B5: '探深淺、拋錨盼天亮：鉛錘繩與錨',
};

function cardFrame(bgA, bgB, inner) {
  const g = uid('cardbg');
  const clip = uid('cardclip');
  return (
    `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>` +
    `<clipPath id="${clip}"><rect x="1" y="1" width="158" height="98" rx="10"/></clipPath></defs>` +
    `<g clip-path="url(#${clip})"><rect width="160" height="100" fill="url(#${g})"/>${inner}</g>` +
    `<rect x="1" y="1" width="158" height="98" rx="10" fill="none" stroke="${C.gold}" stroke-width="1.5" opacity="0.85"/>`
  );
}

function seaBand(y, color = C.sea, amp = 2.5) {
  return `<path d="${wavePath(y, amp, 20, -10, 170, 110)}" fill="${color}"/>` +
    `<path d="${wavePath(y + 7, amp * 0.7, 26, -16, 170)}" fill="none" stroke="${C.foam}" stroke-width="1" opacity="0.5"/>`;
}

function cardArt(id) {
  const sil = '#16243f'; // 淺色背景上的深剪影
  const lite = C.text; // 深色背景上的淺剪影
  switch (id) {
    case 'A1':
      return cardFrame(
        '#f1cf8e',
        '#c99a62',
        // 遠方港口的船
        `<g transform="translate(100 56) scale(0.42)">${simpleHull(110, 24, '#7a5236')}<path d="M55 0 V-58" stroke="#5a3a24" stroke-width="3"/><path d="M57 -54 L57 -8 L92 -8 Z" fill="#f6ecd6" opacity="0.9"/></g>` +
          seaBand(64, '#4d7ea3', 1.6) +
          `<rect x="0" y="74" width="160" height="30" fill="#8a6440"/>` +
          `<path d="M0 74 H160" stroke="#6b4a2c" stroke-width="2"/>` +
          // 舉手勸阻的人（保羅）
          person(34, 92, 46, sil, { raise: 'right' }) +
          // 百夫長
          person(78, 92, 48, '#2c3a5a', { helmet: '#b8473b' }) +
          // 船主抱著麥子袋
          person(122, 92, 46, sil) +
          `<g transform="translate(108 58) scale(0.72)">${itemArt('麥子')}</g>`,
      );
    case 'A2': {
      let wind = '';
      [
        [30, 'M28 30 Q60 20 92 34 Q118 46 150 38'],
        [0, 'M34 44 Q66 38 96 50 Q120 60 152 54'],
        [0, 'M20 22 Q52 10 84 20 Q108 28 132 22'],
      ].forEach(([, d], i) => {
        wind += `<path class="card-wind" style="animation-delay:${i * 0.3}s" d="${d}" fill="none" stroke="${C.text}" stroke-width="${2.6 - i * 0.4}" stroke-linecap="round"/>`;
      });
      return cardFrame(
        '#3b3556',
        '#5a5372',
        // 島
        `<path d="M-6 74 L10 44 L22 52 L34 30 L50 58 L62 74 Z" fill="#2c4a3e" stroke="#1a2f27" stroke-width="1.2"/>` +
          `<path d="M28 38 L34 30 L40 40" fill="none" stroke="#e8f1ff" stroke-width="2" opacity="0.6"/>` +
          wind +
          `<path d="M146 34 l6 4 l-7 3 M148 50 l6 4 l-7 3" fill="none" stroke="${C.text}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
          // 被風抓住的船
          `<g transform="translate(96 66) rotate(10) scale(0.42)">${simpleHull(110, 24)}<path d="M55 0 V-50" stroke="${C.woodDark}" stroke-width="4"/></g>` +
          seaBand(72, C.seaDark, 4),
      );
    }
    case 'A3':
      return cardFrame(
        '#f3dcae',
        '#d6ab72',
        `<rect x="0" y="80" width="160" height="20" fill="#a9784a"/>` +
          // 布巾
          `<path d="M30 82 L130 82 L120 92 L40 92 Z" fill="#e9e1cf" stroke="${C.ink}" stroke-width="1.2" stroke-linejoin="round"/>` +
          // 餅
          `<ellipse cx="62" cy="44" rx="15" ry="9" fill="${C.bread}" ${INK}/><path d="M54 43 l3 -4 M61 42 l3 -4.5 M68 43 l3 -4" stroke="${C.ink}" stroke-width="1.3"/>` +
          `<ellipse cx="94" cy="42" rx="15" ry="9" fill="#d99446" ${INK}/><path d="M86 41 l3 -4 M93 40 l3 -4.5 M100 41 l3 -4" stroke="${C.ink}" stroke-width="1.3"/>` +
          `<ellipse cx="78" cy="38" rx="13" ry="8" fill="#ecb065" ${INK}/>` +
          // 小瓶
          `<path d="M112 30 h6 v5 q6 3 6 12 v10 h-18 v-10 q0 -9 6 -12 Z" fill="#7aa6c9" ${INK}/>` +
          // 籃子
          `<path d="M38 48 L122 48 L112 84 L48 84 Z" fill="#b8844a" ${INK}/>` +
          `<path d="M42 58 H118 M45 68 H115 M47 77 H113" stroke="${C.woodDark}" stroke-width="1.4"/>` +
          `<path d="M56 48 L60 84 M72 48 L73 84 M88 48 L87 84 M104 48 L100 84" stroke="${C.woodDark}" stroke-width="1.2"/>` +
          `<path d="M44 48 Q80 6 116 48" fill="none" stroke="${C.ink}" stroke-width="5.4"/>` +
          `<path d="M44 48 Q80 6 116 48" fill="none" stroke="#c99357" stroke-width="3"/>`,
      );
    case 'A4':
      return cardFrame(
        '#4e6d93',
        '#2c4d73',
        `<g transform="translate(22 42)">${simpleHull(118, 36)}</g>` +
          // 三道纜索繞過船底（船下延伸到水中）
          [52, 80, 108]
            .map(
              (x) =>
                `<path d="M${x - 2} 30 Q${x - 4} 62 ${x + 2} 86" fill="none" stroke="${C.ink}" stroke-width="5.6" stroke-linecap="round"/>` +
                `<path d="M${x - 2} 30 Q${x - 4} 62 ${x + 2} 86" fill="none" stroke="${C.rope}" stroke-width="3.2" stroke-dasharray="3 1.6" stroke-linecap="round"/>`,
            )
            .join('') +
          // 兩個人在甲板上拉繩
          person(60, 42, 20, lite) +
          person(100, 42, 20, lite) +
          `<path d="M64 32 L76 30 M96 32 L84 30" stroke="${C.rope}" stroke-width="1.6"/>` +
          `<g opacity="0.85">${seaBand(70, C.sea, 3)}</g>`,
      );
    case 'A5':
      return cardFrame(
        '#f0c98a',
        '#e39a6a',
        `<circle cx="128" cy="26" r="11" fill="#fff1c4" opacity="0.9"/>` +
          seaBand(58, '#4b7fa6', 1.6) +
          `<rect x="0" y="70" width="160" height="30" fill="#8a6440"/><path d="M0 70 H160" stroke="#6b4a2c" stroke-width="2"/>` +
          person(66, 92, 50, sil) +
          person(94, 92, 50, sil) +
          // 搭在肩上的手
          `<path d="M70 58 Q80 52 88 56" fill="none" stroke="${sil}" stroke-width="4.5" stroke-linecap="round"/>` +
          // 行李
          `<rect x="112" y="80" width="18" height="12" rx="2" fill="${C.woodLight}" ${INK}/><path d="M117 80 q4 -5 8 0" fill="none" stroke="${C.ink}" stroke-width="1.4"/>`,
      );
    case 'B1':
      return cardFrame(
        '#3b3556',
        '#5a5372',
        `<g transform="translate(-30 52)">${simpleHull(100, 30)}</g>` +
          `<path d="M54 38 Q88 14 112 52" fill="none" stroke="${C.text}" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.7"/>` +
          `<g transform="translate(70 18) rotate(18) scale(0.55)">${crateShape()}</g>` +
          `<g transform="translate(100 46) rotate(40) scale(0.6)">${itemArt('器具')}</g>` +
          seaBand(70, C.seaDark, 3.5) +
          // 水花
          `<path d="M110 70 l-6 -12 M116 68 l0 -14 M122 70 l6 -12 M104 72 l-9 -4 M128 72 l9 -4" stroke="${C.foam}" stroke-width="2.2" stroke-linecap="round"/>` +
          `<g transform="translate(124 68) rotate(-12) scale(0.5)">${crateShape()}</g>` +
          seaBand(80, C.sea, 2.5),
      );
    case 'B2':
      return cardFrame(
        '#1d2b4f',
        '#2a3c66',
        `<circle cx="134" cy="18" r="6" fill="#e9eefc" opacity="0.8"/>` +
          `<g transform="translate(-40 46)">${simpleHull(100, 30)}</g>` +
          // 船尾垂下的兩段斷繩
          ol('M50 46 Q58 56 62 64', C.rope, 2) +
          // 斷口：鋸齒
          `<path d="M60 60 l3 2 l-1 3 l3 2" fill="none" stroke="${C.text}" stroke-width="1.4"/>` +
          // 小船漂走，帶著另一段斷繩
          `<g transform="translate(104 56) rotate(-6) scale(0.95)">${ol('M2 22 Q-8 26 -16 22', C.rope, 2)}<path d="M-16 20 l-3 2 l1 3" fill="none" stroke="${C.text}" stroke-width="1.4"/>` +
          `<path d="M3 20 L37 20 Q34 32 25 33 L15 33 Q6 32 3 20 Z" fill="#b5713f" ${INK}/><path d="M3 20 L37 20" stroke="${C.woodLight}" stroke-width="2.4"/></g>` +
          // 漂走的動態線
          `<path d="M144 70 h10 M146 78 h8 M142 62 h8" stroke="${C.foam}" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>` +
          seaBand(76, C.seaDark, 3),
      );
    case 'B3': {
      let heads = '';
      const rows = [
        { y: 30, n: 11, r: 4 },
        { y: 44, n: 10, r: 4.6 },
        { y: 59, n: 9, r: 5.2 },
        { y: 75, n: 8, r: 6 },
      ];
      rows.forEach((row, ri) => {
        const span = 150;
        const step = span / row.n;
        for (let i = 0; i < row.n; i++) {
          const x = 5 + step * (i + 0.5) + (ri % 2 ? step * 0.25 : -step * 0.15);
          const shade = ['#2a3e66', '#33507f', '#3d5f95', '#4a70aa'][ri];
          heads += bust(x.toFixed(1), row.y, row.r, shade);
        }
      });
      return cardFrame(
        '#0f2147',
        '#1a3566',
        heads +
          `<rect x="100" y="6" width="54" height="22" rx="11" fill="${C.gold}" stroke="${C.ink}" stroke-width="1.4"/>` +
          `<text x="127" y="22.5" text-anchor="middle" font-size="15" font-weight="800" fill="${C.ink}" font-family="system-ui,sans-serif">276</text>`,
      );
    }
    case 'B4': {
      let ring = '';
      const pts = [
        [30, 78],
        [52, 88],
        [108, 88],
        [130, 78],
        [44, 62],
        [116, 62],
      ];
      pts.forEach(([x, y]) => {
        ring += bust(x, y - 6, 5.2, '#2b3d62');
      });
      return cardFrame(
        '#53607e',
        '#3a4664',
        rain(160, 100, C.text, 0.25, 'card-rain') +
          `<path d="M0 74 Q80 66 160 74 L160 100 L0 100 Z" fill="#6b4a2c"/>` +
          `<ellipse cx="80" cy="76" rx="62" ry="16" fill="#7c5634"/>` +
          person(80, 80, 52, C.text, { raise: 'right' }) +
          ring,
      );
    }
    case 'B5': {
      let anchors = '';
      [0, 1, 2, 3].forEach((i) => {
        const x = 18 + i * 9;
        anchors += `<path d="M${x} 50 L${x - 2 + i} 70" stroke="${C.rope}" stroke-width="1.2"/>`;
        anchors += `<g transform="translate(${x - 7 + i} 66) scale(0.35)">${anchorShape(C.steel, 3)}</g>`;
      });
      return cardFrame(
        '#0e1a33',
        '#1d3157',
        `<circle cx="140" cy="16" r="1" fill="${C.text}"/><circle cx="118" cy="10" r="0.8" fill="${C.text}"/>` +
          `<g transform="translate(-50 40)">${simpleHull(100, 28, '#6d4a2c')}</g>` +
          `<path d="M0 54 L160 54 L160 100 L0 100 Z" fill="${C.seaDark}" opacity="0.92"/>` +
          `<path d="${wavePath(54, 2, 18, -10, 170)}" fill="none" stroke="${C.foam}" stroke-width="1.2" opacity="0.6"/>` +
          anchors +
          // 鉛錘繩＋刻度
          `<path d="M100 18 L100 84" stroke="${C.rope}" stroke-width="1.6"/>` +
          `<path d="M96 30 H104 M96 42 H104 M96 66 H104 M96 78 H104" stroke="${C.text}" stroke-width="1.3"/>` +
          `<path d="M100 84 L95 92 Q100 98 105 92 Z" fill="${C.steelDark}" stroke="${C.text}" stroke-width="1.2" stroke-linejoin="round"/>` +
          `<text x="112" y="70" font-size="9" font-weight="700" fill="${C.gold}" font-family="system-ui,sans-serif">20</text>` +
          `<text x="112" y="84" font-size="9" font-weight="700" fill="${C.gold}" font-family="system-ui,sans-serif">15</text>` +
          // 遠方的礁石
          `<path d="M134 100 L140 88 L148 92 L156 84 L164 100 Z" fill="#2a3346" stroke="#566179" stroke-width="1"/>`,
      );
    }
    default:
      // 卡背
      return cardFrame(
        C.card2,
        C.navy,
        `<rect x="8" y="8" width="144" height="84" rx="7" fill="none" stroke="${C.gold}" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>` +
          `<g transform="translate(80 50)">` +
          [0, 45, 90, 135]
            .map(
              (r) =>
                `<path transform="rotate(${r})" d="M0 -30 L5 0 L0 30 L-5 0 Z" fill="${r % 90 ? C.goldDeep : C.gold}" opacity="${r % 90 ? 0.7 : 1}"/>`,
            )
            .join('') +
          `<circle r="10" fill="${C.navy}" stroke="${C.gold}" stroke-width="1.5"/>` +
          `<text y="5" text-anchor="middle" font-size="14" font-weight="800" fill="${C.gold}" font-family="system-ui,sans-serif">?</text>` +
          `</g>`,
      );
  }
}

/** 故事卡插圖（160×100）。未知 id 畫卡背。 */
export function card(id) {
  const label = CARD_LABEL[id] || '故事卡背面';
  return `${svgOpen({ viewBox: '0 0 160 100', label, cls: 'art-card', extra: `data-card="${esc(id ?? '')}"` })}${cardArt(id)}</svg>`;
}

// ───────────────────────── 6. 主場景 ─────────────────────────

const SEA = 130; // 海平面（場景座標）
const DECK_Y = 100; // 甲板（船的局部座標）
const DECK_SCALE = 0.72;
const FLOAT_SCALE = 0.62;
// 甲板上的固定位置（中心 x），中間 180 是桅桿
const DECK_X = { 糧食: 109, 纜索: 137, 錨: 164, 麥子: 197, 器具: 225, 小船: 253 };
// 漂浮的固定位置（中心）
const FLOAT_POS = {
  糧食: [34, 146],
  纜索: [124, 172],
  錨: [322, 148],
  麥子: [66, 168],
  器具: [294, 172],
  小船: [212, 176],
};

function skyArt(sky) {
  const g = uid('sky');
  const grad = (a, b, c) =>
    `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.75" stop-color="${b}"/><stop offset="1" stop-color="${c || b}"/></linearGradient></defs><rect width="360" height="190" fill="url(#${g})"/>`;
  const cloud = (x, y, s, fill, op = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})" opacity="${op}"><path d="M0 20 Q-2 6 14 6 Q20 -6 36 0 Q50 -6 58 8 Q72 8 70 20 Z" fill="${fill}"/></g>`;
  switch (sky) {
    case 'harbor':
      return (
        grad('#6fa6dc', '#bfe0f2', '#d9eef7') +
        `<circle cx="300" cy="36" r="16" fill="#fff3c2"/><circle cx="300" cy="36" r="24" fill="#fff3c2" opacity="0.25"/>` +
        cloud(40, 24, 0.9, '#ffffff', 0.85) +
        cloud(200, 14, 0.7, '#ffffff', 0.7) +
        // 遠方港口：山、房子、燈塔
        `<path d="M-10 132 L-10 104 Q30 90 70 102 Q100 92 130 108 L130 132 Z" fill="#6f9a86"/>` +
        `<g fill="#e9e1cf" stroke="#7d6b55" stroke-width="0.8">` +
        `<rect x="8" y="108" width="14" height="12"/><rect x="26" y="104" width="12" height="16"/><rect x="42" y="110" width="16" height="10"/><rect x="62" y="106" width="10" height="14"/>` +
        `</g>` +
        `<g fill="#b8574a"><path d="M6 108 L15 101 L24 108 Z"/><path d="M24 104 L32 97 L40 104 Z"/><path d="M40 110 L50 103 L60 110 Z"/></g>` +
        `<rect x="84" y="94" width="6" height="26" fill="#f4f1e8" stroke="#7d6b55" stroke-width="0.8"/><path d="M83 94 L87 88 L91 94 Z" fill="#b8574a"/>` +
        `<rect x="0" y="120" width="120" height="6" fill="#8b7355"/>` +
        // 海鷗
        `<path d="M150 50 q4 -4 8 0 q4 -4 8 0 M178 64 q3 -3 6 0 q3 -3 6 0" fill="none" stroke="#3d4f6b" stroke-width="1.4" stroke-linecap="round"/>`
      );
    case 'storm':
      return (
        grad('#28233c', '#4c4566', '#5b5470') +
        `<g class="clouds">` +
        cloud(-20, 6, 1.6, '#3a3452') +
        cloud(90, 0, 1.9, '#433c5d') +
        cloud(220, 8, 1.7, '#3a3452') +
        cloud(320, 2, 1.4, '#433c5d') +
        cloud(30, 40, 1.1, '#5a5274', 0.8) +
        cloud(250, 46, 1, '#5a5274', 0.8) +
        `</g>`
      );
    case 'dark':
      return (
        grad('#030409', '#080b14', '#0b0f1b') +
        cloud(20, 10, 1.8, '#0b0e18') +
        cloud(200, 6, 2, '#0b0e18')
      );
    case 'night':
      return (
        grad('#0a1430', '#18284d', '#22355e') +
        // 雲裂開的地方：幾顆星與月亮
        `<g fill="#f4f1e8"><circle cx="232" cy="22" r="0.9"/><circle cx="262" cy="14" r="1.1"/><circle cx="318" cy="18" r="0.8"/><circle cx="246" cy="44" r="0.7"/></g>` +
        `<circle cx="290" cy="40" r="20" fill="#f4f1e8" opacity="0.12"/>` +
        `<circle cx="290" cy="40" r="12" fill="#f3eed8"/>` +
        `<circle cx="285" cy="37" r="2.2" fill="#ddd6bb"/><circle cx="294" cy="44" r="1.6" fill="#ddd6bb"/>` +
        `<g class="clouds">` +
        cloud(-30, 4, 2.4, '#1c2846') +
        cloud(120, 0, 1.9, '#22304f') +
        cloud(300, 52, 1.2, '#22304f', 0.9) +
        cloud(150, 50, 1.1, '#1c2846', 0.85) +
        `</g>`
      );
    case 'dawn':
    default:
      return (
        grad('#5a6fa8', '#f2a77a', '#f7cf94') +
        `<circle cx="250" cy="112" r="18" fill="#ffe7a8"/><circle cx="250" cy="112" r="30" fill="#ffe7a8" opacity="0.25"/>` +
        cloud(30, 30, 1, '#f6c4a0', 0.6) +
        cloud(150, 18, 0.8, '#f6c4a0', 0.5) +
        // 遠方海灣與沙灘
        `<path d="M170 128 Q200 102 236 108 Q270 96 300 104 Q336 94 370 100 L370 128 Z" fill="#5f7d6c"/>` +
        `<path d="M176 128 Q230 118 280 122 Q330 116 370 120 L370 130 L176 130 Z" fill="${C.sand}"/>` +
        `<path d="M-10 128 L-10 112 Q20 104 50 114 L70 128 Z" fill="#6c8576"/>`
      );
  }
}

function shipHull() {
  return (
    // 舵
    `<path d="M84 98 L72 134 L80 136 L90 102 Z" fill="${C.woodDark}" ${INK}/>` +
    // 船身
    `<path d="M80 88 L94 100 L268 100 L292 82 Q286 122 244 142 L120 142 Q90 138 80 88 Z" fill="${C.wood}" ${INK}/>` +
    `<path d="M88 112 Q180 118 284 104 M98 134 Q180 140 262 128" fill="none" stroke="${C.woodDark}" stroke-width="1.4"/>` +
    // 船舷
    `<path d="M80 88 L94 100 L268 100 L292 82" fill="none" stroke="${C.woodLight}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M80 88 L94 100 L268 100 L292 82" fill="none" stroke="${C.ink}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 2)" opacity="0.6"/>` +
    // 船頭眼睛（古船常見的裝飾）改用圓形舷窗，不畫臉
    `<circle cx="112" cy="106" r="2.4" fill="${C.woodDark}"/><circle cx="252" cy="106" r="2.4" fill="${C.woodDark}"/>`
  );
}

function safeLine() {
  // 金色安全吃水線＋載重線圓標（形狀可辨識，不只靠顏色）
  return (
    `<g class="safe-line">` +
    `<path d="M100 124 L266 124" stroke="${C.ink}" stroke-width="4.2" stroke-linecap="round"/>` +
    `<path d="M100 124 L266 124" stroke="${C.gold}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<circle cx="180" cy="124" r="5.2" fill="${C.wood}" stroke="${C.gold}" stroke-width="2"/>` +
    `<path d="M173 124 H187" stroke="${C.gold}" stroke-width="2"/>` +
    `</g>`
  );
}

function mastAndSail(sky) {
  const full = sky === 'harbor';
  return (
    ol('M180 100 L180 20', C.woodLight, 3.2) +
    ol('M150 32 L210 32', C.woodLight, 2.4) +
    (full
      ? `<path d="M152 34 L208 34 Q214 56 206 76 L154 76 Q146 56 152 34 Z" fill="${C.sail}" ${INK}/>` +
        `<path d="M166 34 L166 76 M194 34 L194 76" stroke="#cbbf9f" stroke-width="1.2"/>` +
        ol('M154 76 L92 98 M206 76 L270 98', C.rope, 1)
      : // 風暴中把帆收起來捆在橫桁上（27:17 落下篷來）
        `<path d="M150 31 Q180 42 210 31 L210 36 Q180 47 150 36 Z" fill="${C.sail}" ${INK}/>` +
        `<path d="M160 33 l2 6 M172 35 l1 6.5 M188 35 l-1 6.5 M200 33 l-2 6" stroke="${C.rope}" stroke-width="1.6"/>` +
        ol('M180 22 L88 92 M180 22 L284 88', C.rope, 0.9)) +
    // 桅頂小旗
    `<path d="M180 20 L194 23 L180 27 Z" fill="${C.gold}" stroke="${C.ink}" stroke-width="1"/>`
  );
}

function deckItem(id, dyShip, rescued) {
  const x = DECK_X[id];
  const s = DECK_SCALE;
  const tx = x - 20 * s;
  const ty = DECK_Y - 40 * s - 0.5;
  let inner = `<g transform="translate(${tx} ${ty}) scale(${s})">${itemArt(id)}</g>`;
  if (rescued) {
    // 從漂浮位置跳回：offset＝漂浮中心 −（甲板中心＋船的吃水位移）
    const [fx, fy] = FLOAT_POS[id];
    const dx = (fx - x).toFixed(1);
    const dy = (fy - (DECK_Y - 20 * s + dyShip)).toFixed(1);
    inner = `<g class="just-rescued" style="--fx:${dx}px"><g class="jr-y" style="--fy:${dy}px">${inner}</g></g>`;
  }
  return `<g class="deck-item" data-item="${esc(id)}">${inner}</g>`;
}

function floatItem(id, dyShip, thrown) {
  const [cx, cy] = FLOAT_POS[id] || [180, 176];
  const s = FLOAT_SCALE;
  const half = 20 * s;
  let body = `<g transform="translate(${cx - half} ${cy - half - 3})"><g class="bob"><g transform="scale(${s})">${itemArt(id)}</g></g></g>`;
  if (thrown) {
    const dx = ((DECK_X[id] ?? 180) - cx).toFixed(1);
    const dy = (DECK_Y - 20 * DECK_SCALE + dyShip - cy).toFixed(1);
    body = `<g class="just-thrown" style="--fx:${dx}px"><g class="jt-y" style="--fy:${dy}px">${body}</g></g>`;
  }
  // 蓋在東西下半部的一小片海水，看起來半沉
  const cap = `<g class="float-cap${thrown ? ' appear-late' : ''}"><path d="${wavePath(cy + 1, 1.6, 8, cx - 13, cx + 9, cy + 10)}" fill="${C.sea}" opacity="0.9"/><path d="${wavePath(cy + 1, 1.6, 8, cx - 13, cx + 9)}" fill="none" stroke="${C.foam}" stroke-width="1" opacity="0.8"/></g>`;
  const splash = thrown ? splashArt(cx, cy, 'splash') : '';
  return `<g class="float-item" data-item="${esc(id)}">${body}${cap}${splash}</g>`;
}

function splashArt(cx, cy, cls) {
  return (
    `<g class="${cls}" opacity="0"><g transform="translate(${cx} ${cy})">` +
    `<path d="M-2 -2 L-8 -16 M2 -3 L2 -20 M5 -2 L12 -15 M-6 0 L-16 -6 M8 0 L18 -6" stroke="${C.foam}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<circle cx="-10" cy="-19" r="1.8" fill="${C.foam}"/><circle cx="14" cy="-18" r="1.8" fill="${C.foam}"/><circle cx="2" cy="-24" r="2" fill="${C.foam}"/>` +
    `<ellipse cx="0" cy="2" rx="12" ry="3" fill="none" stroke="${C.foam}" stroke-width="1.6"/>` +
    `</g></g>`
  );
}

/** 依載重算船的上下位移：越重越低，超過上限明顯下沉。 */
function draftOffset(weight, cap) {
  const w = Math.max(0, Number(weight) || 0);
  const c = Number(cap) > 0 ? Number(cap) : 6;
  const r = w / c;
  if (r <= 1) return -10 + 16 * r; // 安全：金線在海面上方 0~16
  return Math.min(22, 10 + (r - 1) * 24); // 超重：金線沉到海面下
}

const SKY_LABEL = {
  harbor: '平靜的港口',
  storm: '暴風雨中',
  dark: '一片漆黑、只有雨',
  night: '夜裡，雲縫裡有月光',
  dawn: '天亮了，遠方有海灣和沙灘',
};

/**
 * 主場景。
 * @param {{sky?: string, onDeck?: string[], afloat?: string[], justThrown?: string[], justRescued?: string[],
 *          load?: {weight:number, cap:number}, rock?: 'calm'|'storm'}} opts
 */
export function scene(opts = {}) {
  const sky = SKY_LABEL[opts.sky] ? opts.sky : 'storm';
  const rock = opts.rock === 'calm' || opts.rock === 'storm' ? opts.rock : sky === 'harbor' ? 'calm' : 'storm';
  const has = (arr) => new Set(Array.isArray(arr) ? arr : []);
  const deckSet = has(opts.onDeck);
  const thrownSet = has(opts.justThrown);
  const rescuedSet = has(opts.justRescued);
  const onDeck = ITEM_ORDER.filter((id) => deckSet.has(id));
  const floatSet = has([...(opts.afloat || []), ...thrownSet]);
  const afloat = ITEM_ORDER.filter((id) => floatSet.has(id) && !deckSet.has(id));
  const load = opts.load || {};
  const weight = Number(load.weight) || 0;
  const cap = Number(load.cap) > 0 ? Number(load.cap) : 6;
  const over = weight > cap;
  const dy = draftOffset(weight, cap);
  const amp = rock === 'storm' ? 6 : 2.5;

  // 無障礙說明
  const parts = [SKY_LABEL[sky]];
  parts.push(onDeck.length ? `甲板上有${onDeck.join('、')}` : '甲板上空了');
  if (afloat.length) parts.push(`海上漂著${afloat.join('、')}`);
  parts.push(over ? `超重：載重 ${weight}／${cap}，船吃水過深、海水打上甲板` : `載重 ${weight}／${cap}，吃水線以內`);
  const label = parts.join('；');

  const cls = `art-scene scene sky-${sky} ${over ? 'is-over' : 'is-safe'}`;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" class="art ${cls}" viewBox="0 0 360 190" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}" data-weight="${weight}" data-cap="${cap}">`;
  s += `<g class="sky">${skyArt(sky)}</g>`;
  if (sky === 'storm') s += lightningBolt(250, 20, 1.2, 'lightning');

  // 後方的浪
  const backCol = { harbor: '#4f8fbf', storm: '#2c4767', dark: '#0b1424', night: '#1c3459', dawn: '#5d8db8' }[sky];
  const frontCol = { harbor: '#2d78ad', storm: C.seaDark, dark: '#0a1220', night: '#16304f', dawn: '#3f78a6' }[sky];
  const foamOp = sky === 'dark' ? 0.25 : 0.7;
  s += `<g class="waves waves-back"><path d="${wavePath(SEA - 6, amp * 0.6, 48, -96, 456, 190)}" fill="${backCol}"/></g>`;

  // 船（外層負責吃水，內層負責搖擺）
  s += `<g class="ship-draft" transform="translate(0 ${dy.toFixed(1)})"><g class="ship rock-${rock}">`;
  s += shipHull();
  s += safeLine();
  s += mastAndSail(sky);
  s += onDeck.map((id) => deckItem(id, dy, rescuedSet.has(id))).join('');
  if (over) {
    // 海水打上甲板
    s += `<g class="deck-water"><path d="M94 100 Q108 90 124 98 Q140 92 156 100 Z M206 100 Q222 91 238 98 Q252 92 268 100 Z" fill="#6fb6e8" opacity="0.85"/>` +
      `<path d="M100 92 l-3 -6 M116 90 l0 -7 M232 90 l0 -7 M248 92 l3 -6" stroke="${C.foam}" stroke-width="2" stroke-linecap="round"/></g>`;
  }
  s += `</g></g>`;

  // 前方的海（半透明，沉到水下的金線還隱約看得到）
  s += `<g class="waves waves-front"><path d="${wavePath(SEA, amp, 60, -120, 480, 190)}" fill="${frontCol}" opacity="0.88"/>` +
    `<path d="${wavePath(SEA, amp, 60, -120, 480)}" fill="none" stroke="${C.foam}" stroke-width="1.4" opacity="${foamOp}"/>` +
    `<path d="${wavePath(SEA + 22, amp * 0.6, 40, -120, 480)}" fill="none" stroke="${C.foam}" stroke-width="1" opacity="${foamOp * 0.5}"/></g>`;

  if (sky === 'night') {
    // 月光倒影
    s += `<g class="moonlight" opacity="0.5"><path d="M276 138 h28 M280 146 h20 M272 154 h34 M282 162 h16" stroke="#f3eed8" stroke-width="1.6" stroke-linecap="round"/></g>`;
  }

  if (over) {
    // 超重警告：紅色虛線吃水線＋三角驚嘆號（形狀＋顏色）
    s += `<g class="overload-warn">` +
      `<path d="M86 ${SEA - 2} L292 ${SEA - 2}" stroke="${C.red}" stroke-width="2.4" stroke-dasharray="7 4"/>` +
      `<path d="M318 92 L334 120 L302 120 Z" fill="${C.red}" stroke="#3a0b0b" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M318 101 V111" stroke="#3a0b0b" stroke-width="3" stroke-linecap="round"/><circle cx="318" cy="115.5" r="1.7" fill="#3a0b0b"/>` +
      `</g>`;
  }

  s += afloat.map((id) => floatItem(id, dy, thrownSet.has(id))).join('');

  if (sky === 'storm') s += rain(360, 190, '#cfd8ff', 0.45);
  if (sky === 'dark') s += rain(360, 190, '#8a9abb', 0.35);
  s += `</svg>`;
  return s;
}

// ───────────────────────── 7. 停電遮罩背景 ─────────────────────────

/** 全黑、雨絲、偶爾很暗的閃電、中間隱約的船影。 */
export function darkness() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="art art-darkness" viewBox="0 0 360 240" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="一片漆黑，多日不見日頭星辰，只有雨">` +
    `<rect width="360" height="240" fill="#04060b"/>` +
    `<g class="dim-lightning" opacity="0"><rect width="360" height="240" fill="#9aa6d6" opacity="0.12"/></g>` +
    // 隱約的船影
    `<g opacity="0.9" transform="translate(0 30)">` +
    `<path d="M80 88 L94 100 L268 100 L292 82 Q286 122 244 142 L120 142 Q90 138 80 88 Z" fill="#0c1222"/>` +
    `<path d="M180 100 L180 20 M150 32 L210 32" stroke="#0c1222" stroke-width="3"/>` +
    `<path d="M80 88 L94 100 L268 100 L292 82" fill="none" stroke="#18213a" stroke-width="1.5"/>` +
    `</g>` +
    `<g class="waves waves-front"><path d="${wavePath(166, 4, 60, -120, 480, 240)}" fill="#060a14"/><path d="${wavePath(166, 4, 60, -120, 480)}" fill="none" stroke="#1a2440" stroke-width="1.2"/></g>` +
    rain(360, 240, '#7d8cb0', 0.28) +
    `</svg>`
  );
}

// ───────────────────────── 8. 吃飯（擘餅）動畫 ─────────────────────────

/** 約 2.5 秒：一雙手擘開餅、碎屑、周圍一圈人亮起來（27:35–36）。結尾停在靜態畫面。 */
export function meal() {
  const n = 10;
  let heads = '';
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = 120 + Math.cos(ang) * 96;
    const y = 82 + Math.sin(ang) * 56;
    heads += `<g class="meal-head" style="animation-delay:${(1.2 + i * 0.1).toFixed(2)}s">${bust(x.toFixed(1), (y - 6).toFixed(1), 7, C.gold2)}</g>`;
  }
  const crumbs = [
    [-12, -28],
    [-3, -36],
    [9, -32],
    [17, -24],
    [-4, 22],
    [6, 26],
    [0, 34],
  ]
    .map(
      ([x, y], i) =>
        `<g class="meal-crumb" style="--cx:${-x}px;--cy:${-y}px;animation-delay:${(0.8 + i * 0.05).toFixed(2)}s"><circle cx="${120 + x}" cy="${78 + y}" r="${i % 2 ? 1.6 : 2.2}" fill="#f0bd6c" stroke="${C.ink}" stroke-width="0.6"/></g>`,
    )
    .join('');
  // 半個餅（左半），右半用鏡像
  const half = (side) => {
    const m = side === 'L' ? '' : ' transform="translate(240 0) scale(-1 1)"';
    return (
      `<g${m}><path d="M117 64 Q92 62 90 79 Q92 95 117 94 L113 89 L118 85 L113 80 L118 75 L113 70 Z" fill="${C.bread}" ${INK}/>` +
      `<path d="M113 89 L118 85 L113 80 L118 75 L113 70 L109 72 L111 79 L108 86 Z" fill="#f6e3b8"/>` +
      `<path d="M96 74 Q101 67 109 66" fill="none" stroke="#f6cf86" stroke-width="2.4" stroke-linecap="round"/></g>`
    );
  };
  const hand = (side) => {
    const m = side === 'L' ? '' : ' transform="translate(240 0) scale(-1 1)"';
    return `<g${m}><path d="M74 124 Q82 100 94 90 Q102 86 110 88 Q114 92 108 95 L102 96 Q98 106 92 126 Z" fill="#e9d2b0" ${INK}/>` +
      `<path d="M96 92 q2 -3 6 -3 M100 94 q2 -3 6 -3" fill="none" stroke="${C.ink}" stroke-width="1"/></g>`;
  };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="art art-meal" viewBox="0 0 240 160" width="100%" role="img" aria-label="保羅拿著餅擘開，大家都放下心，也吃了（使徒行傳 27:35–36）">` +
    `<ellipse cx="120" cy="82" rx="112" ry="72" fill="${C.card}"/>` +
    `<ellipse cx="120" cy="82" rx="70" ry="40" fill="${C.card2}"/>` +
    heads +
    `<g class="meal-hands">` +
    `<g class="meal-half meal-half-l">${half('L')}${hand('L')}</g>` +
    `<g class="meal-half meal-half-r">${half('R')}${hand('R')}</g>` +
    `</g>` +
    crumbs +
    `</svg>`
  );
}

// ───────────────────────── 9. 上岸動畫 ─────────────────────────

/**
 * 約 4 秒：天亮的海灣 → 船駛向沙灘 → 兩水夾流擱淺、船尾被浪打壞 → 有的游、有的抱木板上岸 → 岸上生火。
 * 每個人都會上岸（27:44）。lit 只改細節。
 * @param {{lit?: {力氣?: boolean, 船身?: boolean, 天亮?: boolean}}} [opt]
 */
export function landing({ lit = {} } = {}) {
  const strong = !!lit['力氣'];
  const hullOk = !!lit['船身'];
  const daylight = !!lit['天亮'];
  const g = uid('land');
  const sea = uid('landsea');

  // 天空：天亮＝true 時較明亮
  const skyTop = daylight ? '#7e93c4' : '#4a4f7e';
  const skyLow = daylight ? '#ffc58f' : '#d98f78';
  let s = `<svg xmlns="http://www.w3.org/2000/svg" class="art art-landing${strong ? '' : ' is-weak'}" viewBox="0 0 360 200" width="100%" role="img" aria-label="天亮時船駛向海灘，在兩水夾流的地方擱淺，船尾被浪打壞；大家有的游水、有的抱著木板，全都上了岸，岸上生起了火（使徒行傳 27:39–44、28:2）">`;
  s += `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyLow}"/></linearGradient>` +
    `<linearGradient id="${sea}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f86b4"/><stop offset="1" stop-color="#22557f"/></linearGradient></defs>`;
  s += `<rect width="360" height="112" fill="url(#${g})"/>`;
  s += `<circle cx="300" cy="${daylight ? 104 : 112}" r="16" fill="#ffe7a8"/><circle cx="300" cy="${daylight ? 104 : 112}" r="28" fill="#ffe7a8" opacity="0.25"/>`;
  // 遠方岬角
  s += `<path d="M-10 112 L-10 96 Q30 86 60 98 Q90 92 110 112 Z" fill="#5e7a6b"/>`;
  s += `<path d="M300 112 Q330 90 370 94 L370 112 Z" fill="#5e7a6b"/>`;
  // 海
  s += `<rect y="112" width="360" height="88" fill="url(#${sea})"/>`;
  s += `<g class="waves waves-landing"><path d="${wavePath(126, 1.6, 30, -60, 420)} ${wavePath(146, 1.8, 36, -60, 420).replace('M', 'M')}" fill="none" stroke="${C.foam}" stroke-width="1" opacity="0.5"/></g>`;
  // 沙灘
  s += `<path d="M232 200 L246 152 Q276 128 360 120 L360 200 Z" fill="${C.sand}" stroke="#c9a96a" stroke-width="1.2"/>`;
  s += `<path d="M246 152 Q276 128 360 120" fill="none" stroke="${C.foam}" stroke-width="2" opacity="0.8"/>`;
  // 兩水夾流：兩股水流在沙洲匯合
  s += `<g class="currents" opacity="0.85">` +
    `<path d="M150 128 Q190 136 222 150" fill="none" stroke="${C.foam}" stroke-width="1.6" stroke-dasharray="5 4"/>` +
    `<path d="M150 190 Q192 176 222 158" fill="none" stroke="${C.foam}" stroke-width="1.6" stroke-dasharray="5 4"/>` +
    `<path d="M216 146 l7 4 l-7 3 M216 162 l7 -4 l-1 7" fill="none" stroke="${C.foam}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<ellipse cx="226" cy="156" rx="16" ry="4" fill="#d9c08a" opacity="0.8"/>` +
    `</g>`;
  if (!daylight) {
    // 天還不夠亮：沙洲旁露出幾塊礁石
    s += `<path d="M196 170 l6 -8 l7 3 l4 5 Z M180 158 l4 -6 l5 3 l2 3 Z" fill="#3f4658" stroke="#262b38" stroke-width="1"/>`;
  }

  // 船：最終停在沙洲，船頭卡住、船尾已碎
  const brokenHull = hullOk
    ? `M130 136 L138 140 L214 140 L232 128 Q228 152 206 160 L148 160 L142 154 L146 150 L140 146 L136 142 Z`
    : `M150 140 L214 140 L232 128 Q228 152 206 160 L166 160 L160 152 L166 148 L156 146 L162 142 Z`;
  const sternPiece = hullOk
    ? `M120 128 L130 136 L136 142 L140 146 L146 150 L142 154 L148 160 Q124 158 120 128 Z`
    : `M120 128 L138 140 L150 140 L162 142 L156 146 L166 148 L160 152 L166 160 L148 160 Q124 158 120 128 Z`;
  s += `<g class="land-ship-wrap"><g class="land-ship">` +
    `<g class="stern-intact" opacity="0"><path d="${sternPiece}" fill="${C.wood}" ${INK}/></g>` +
    `<path d="${brokenHull}" fill="${C.wood}" ${INK}/>` +
    `<path d="M140 150 Q190 152 226 140" fill="none" stroke="${C.woodDark}" stroke-width="1.2"/>` +
    ol('M182 140 L182 82', C.woodLight, 2.4) +
    `<path d="M184 86 L184 120 L210 120 Z" fill="${C.sail}" ${INK}/>` +
    `</g></g>`;

  // 碎木板（船尾被浪打壞）
  const debris = hullOk
    ? [
        [118, 170, 20],
        [104, 156, -15],
        [130, 184, 8],
      ]
    : [
        [118, 170, 20],
        [104, 156, -15],
        [130, 184, 8],
        [92, 176, 35],
        [140, 194, -25],
        [86, 148, 5],
      ];
  s += debris
    .map(
      ([x, y, r], i) =>
        `<g transform="translate(${x} ${y})"><g class="land-debris" style="--dx:${(136 - x).toFixed(0)}px;--dy:${(148 - y).toFixed(0)}px;animation-delay:${(i * 0.05).toFixed(2)}s"><rect x="-9" y="-2" width="18" height="4" rx="1" transform="rotate(${r})" fill="${C.woodLight}" ${INK}/></g></g>`,
    )
    .join('');
  // 浪打船尾的水花
  s += splashArt(132, 146, 'land-splash');

  // 火（28:2）
  s += `<g transform="translate(304 180)"><g class="land-fire">` +
    `<path d="M-12 4 L12 -2 M-12 -2 L12 4" stroke="${C.woodDark}" stroke-width="4" stroke-linecap="round"/>` +
    `<g class="flame"><path d="M0 -26 Q12 -12 8 -2 Q4 4 0 4 Q-4 4 -8 -2 Q-12 -12 0 -26 Z" fill="#ff8a3d" ${INK}/>` +
    `<path d="M0 -15 Q6 -8 4 -2 Q0 2 -4 -2 Q-6 -8 0 -15 Z" fill="${C.gold2}"/></g>` +
    `</g></g>`;

  // 人：最終都站在岸上圍著火；起點在船旁的水裡
  const people = [
    [262, 160, 206, 172, true],
    [276, 176, 214, 184, false],
    [286, 192, 196, 192, true],
    [326, 192, 230, 192, false],
    [338, 176, 182, 178, true],
    [344, 158, 238, 174, false],
    [284, 146, 244, 160, false],
    [322, 150, 222, 168, true],
  ];
  s += people
    .map(([fx, fy, sx, sy, plank], i) => {
      const plankSvg = plank ? `<rect x="3" y="-18" width="4" height="20" rx="1" fill="${C.woodLight}" ${INK}/>` : '';
      const color = i % 2 ? '#22324f' : '#2e2a3f';
      return (
        `<g transform="translate(${fx} ${fy})" stroke="${C.text}" stroke-width="0.8"><g class="land-person${strong ? '' : ' slow'}" style="--sx:${sx - fx}px;--sy:${sy - fy}px;animation-delay:${(i * 0.06).toFixed(2)}s">` +
        plankSvg +
        person(0, 0, 20, color) +
        `</g></g>`
      );
    })
    .join('');
  s += `</svg>`;
  return s;
}

// ───────────────────────── 10. 水花 ─────────────────────────

/** 小的水花圖（獨立使用，會播一次動畫）。 */
export function throwSplash(size = 40) {
  return `${svgOpen({ viewBox: '-20 -28 40 36', size, label: '水花', cls: 'art-splash' })}${splashArt(0, 0, 'splash')}</svg>`;
}

// ───────────────────────── 10. 拋錨、捆船底（天亮前只來得及做一件） ─────────────────────────

/** 約 2 秒：船尾放下四個錨，繩子拉直、沉進夜海（27:29）。靜止時就是錨已沉在水裡。 */
export function anchorDrop() {
  const anchors = [0, 1, 2, 3]
    .map((i) => {
      const x = 52 + i * 14;
      return (
        `<g class="ad-rope" style="animation-delay:${(0.2 + i * 0.15).toFixed(2)}s">${ol(`M${x} 64 L${x} 118`, C.rope, 1.6)}</g>` +
        `<g class="ad-anchor" style="animation-delay:${(0.2 + i * 0.15).toFixed(2)}s"><g transform="translate(${x - 9} 112) scale(0.45)">${anchorShape(C.steel, 3.4)}</g></g>`
      );
    })
    .join('');
  return (
    svgOpen({ viewBox: '0 0 240 160', label: '從船尾拋下四個錨，盼望天亮（使徒行傳 27:29）', cls: 'art-use art-anchor' }) +
    `<rect width="240" height="160" rx="16" fill="${C.navy}"/>` +
    `<circle cx="200" cy="28" r="10" fill="${C.sail}" opacity="0.85"/>` +
    `<path d="M0 80 Q30 74 60 80 T120 80 T180 80 T240 80 V160 H0 Z" fill="${C.seaDark}"/>` +
    anchors +
    `<path d="M30 66 L40 52 L200 52 L214 66 Q200 82 170 86 L66 86 Q40 84 30 66 Z" fill="${C.wood}" ${INK}/>` +
    `<path d="M0 82 Q30 76 60 82 T120 82 T180 82 T240 82" fill="none" stroke="${C.foam}" stroke-width="1.6" opacity="0.7"/>` +
    `</svg>`
  );
}

/** 約 2 秒：繩子一圈一圈繞過船底、拉緊（27:17）。靜止時就是船底已捆好。 */
export function undergird() {
  const loops = [0, 1, 2]
    .map((i) => {
      const x = 84 + i * 36;
      return `<g class="ug-loop" style="animation-delay:${(0.2 + i * 0.3).toFixed(2)}s">${ol(`M${x} 48 Q${x - 8} 92 ${x} 112 Q${x + 8} 92 ${x + 2} 48`, C.rope, 2.4)}</g>`;
    })
    .join('');
  return (
    svgOpen({ viewBox: '0 0 240 160', label: '用繩子捆綁船底（使徒行傳 27:17）', cls: 'art-use art-undergird' }) +
    `<rect width="240" height="160" rx="16" fill="${C.navy}"/>` +
    `<path d="M0 104 Q30 98 60 104 T120 104 T180 104 T240 104 V160 H0 Z" fill="${C.seaDark}"/>` +
    `<path d="M36 52 L48 40 L196 40 L210 52 Q198 106 160 112 L82 112 Q46 106 36 52 Z" fill="${C.wood}" ${INK}/>` +
    `<path d="M50 70 Q122 78 200 66 M58 92 Q122 100 190 88" fill="none" stroke="${C.woodDark}" stroke-width="1.4"/>` +
    loops +
    `</svg>`
  );
}
