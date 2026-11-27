#!/usr/bin/env python3
"""逐字核對 src/server/content.ts 裡引用的經文（只比字詞，不比標點與空白）。

來源：GitHub brandonmcconnell/bible 的 zh-Hant/cuvt（標示「新標點和合本」，上帝版用字），
經 raw.githubusercontent.com 下載使徒行傳 27、28 章。需要網路。
本遊戲用「神」版（2026-11-15 使用者決定）。神版與上帝版只差「上帝」↔「神」這個詞，
所以比對前先把來源的「上帝」換成「神」；畫面若出現「上帝」反而會被判為不一致。

用法：python3 tools/verify_verses.py
節錄處以「……」分段，每段都必須是對應經節連續原文的一部分。
"""
import re
import sys
import urllib.request
from pathlib import Path

SRC = 'https://raw.githubusercontent.com/brandonmcconnell/bible/main/zh-Hant/cuvt/{}/{}.mdx'
BOOKS = {'徒': 'acts', '西': 'colossians'}
CONTENT = Path(__file__).resolve().parent.parent / 'src' / 'server' / 'content.ts'

# （標籤, 在 content.ts 找引文的正規式, 章, 起節, 迄節）
QUOTES = [
    ('卡 A1', r"A1: \{.*?verse: '([^']+)'", 27, 10, 11),
    ('卡 A2', r"A2: \{.*?verse: '([^']+)'", 27, 13, 14),
    ('卡 A3', r"A3: \{.*?verse: '([^']+)'", 27, 3, 3),
    ('卡 A4', r"A4: \{.*?verse: '([^']+)'", 27, 17, 17),
    ('卡 A5', r"A5: \{.*?verse: '([^']+)'", 27, 2, 2),
    ('卡 B1', r"B1: \{.*?verse: '([^']+)'", 27, 18, 19),
    ('卡 B2', r"B2: \{.*?verse: '([^']+)'", 27, 30, 32),
    ('卡 B3', r"B3: \{.*?verse: '([^']+)'", 27, 37, 38),
    ('卡 B4', r"B4: \{.*?verse: '([^']+)'", 27, 21, 22),
    ('卡 B5', r"B5: \{.*?verse: '([^']+)'", 27, 28, 29),
    ('見聞・水淺', r"淺: \{.*?verse: '([^']+)'", 27, 28, 28),
    ('天黑', r"blackout: \{ text: '([^']+)'", 27, 20, 20),
    ('第十四天', r"replanning: \{ text: '([^']+)'", 27, 27, 27),
    ('結尾・吃飯', r"fed: \{ text: '([^']+)'", 27, 35, 36),
    ('結尾・上岸', r"shore: \{ text: '([^']+)'", 27, 44, 44),
]
# 前端字幕（public/app.js）
EXTRA = [
    ('吃飯字幕', '於是他們都放下心，也就吃了。', 27, 36, 36),
]

PUNCT = re.compile(r'[\s，。；：、「」『』！？…（）().,;:!?"\'“”‘’—–-]')


def norm(s):
    return PUNCT.sub('', s)


def chapter(n, book='acts'):
    with urllib.request.urlopen(SRC.format(book, n), timeout=30) as r:
        t = r.read().decode('utf-8')
    out = {}
    parts = re.split(r'<span className="v" id="v(\d+)"[^>]*>', t)
    for i in range(1, len(parts), 2):
        txt = re.sub(r'<[^>]+>', '', parts[i + 1])
        txt = re.sub(r'^\s*#+.*$', '', txt, flags=re.M)
        out[int(parts[i])] = re.sub(r'\s+', '', txt).replace('上帝', '神')  # 換成神版
    return out


def main():
    verses = {27: chapter(27), 28: chapter(28)}
    content = CONTENT.read_text(encoding='utf-8')
    if '上帝' in content:
        print('[不一致] content.ts 出現「上帝」：本遊戲用神版')
        return 1
    items = [(label, re.search(rx, content, re.S).group(1), c, a, b) for label, rx, c, a, b in QUOTES] + EXTRA
    ok_all = True
    for label, quote, c, a, b in items:
        src = norm(''.join(verses[c][n] for n in range(a, b + 1)))
        bad = [seg for seg in quote.split('……') if norm(seg) and norm(seg) not in src]
        ref = f'{c}:{a}' + (f'–{b}' if b != a else '')
        print(f"[{'一致' if not bad else '不一致'}] {label}（徒 {ref}）" + ''.join(f'\n    ✗「{s}」' for s in bad))
        ok_all &= not bad
    # 角色卡「故事裡」的人（DECISIONS 20）：出處那幾節裡一定要有 word 這個詞（例：掌船的 → 徒 27:11）
    for m in re.finditer(r"(\w+): \{ line: '[^']*', who: '([^']*)', ref: '([^']*)', word: '([^']*)'", content):
        role, who, ref, word = m.groups()
        if not ref:
            ok = who == '船上的人'
            print(f"[{'一致' if ok else '不一致'}] 角色卡・{role}：{who}（不附出處）")
            ok_all &= ok
            continue
        rm = re.match(r'(徒|西) (\d+):(\d+)(?:–(\d+))?$', ref)
        if not rm:
            print(f'[不一致] 角色卡・{role}：看不懂出處「{ref}」')
            ok_all = False
            continue
        book, c, a, b = rm.group(1), int(rm.group(2)), int(rm.group(3)), int(rm.group(4) or rm.group(3))
        vs = verses[c] if book == '徒' and c in verses else chapter(c, BOOKS[book])
        src = ''.join(vs[n] for n in range(a, b + 1))
        ok = bool(word) and word in src
        print(f"[{'一致' if ok else '不一致'}] 角色卡・{role}：{who}（{ref}，經文有「{word}」）")
        ok_all &= ok
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
