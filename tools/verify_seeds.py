#!/usr/bin/env python3
"""窮舉驗證第一關「保羅海難」的可解性與分星（含所有故事卡組合）。只做規則試算，不是遊戲程式。

用法：python3 tools/verify_seeds.py
      python3 tools/verify_seeds.py --export 路徑.json   # 匯出逐筆對照檔給規則引擎測試

規則（docs/11-MISSION_01_SHIPWRECK.md）：
- 船上的東西全部從船上開始；玩家決定留哪些（其餘丟進海裡）。
- 留下的總重 ≤ 安全載重才能「決定好了」／「衝向海灘」，否則拒絕（超重）。
- 星等＝上岸三件事顧好幾件：力氣（糧食或已吃飯）、船身（纜索或卡片已完成）、天亮（錨）。
- 吃飯（突破口）：糧食離船、不再佔重量，力氣算顧好。
暴風雨救援 seed 001／002 已於 2026-11-15 退役（使用者決定第一關改為保羅海難），見 git 歷史。
"""
import json
import sys
from itertools import combinations

SEEDS = {
    "ship 001": dict(
        cap_pre=6, cap_post=4,
        weights={"糧食": 2, "纜索": 1, "錨": 3, "麥子": 3, "器具": 2, "小船": 2},
        needs={"力氣": "糧食", "船身": "纜索", "天亮": "錨"},
        food="糧食",
    ),
}

# 故事卡：deck A＝起風（開局翻開），deck B＝風暴（補好船後翻開）。
# weight：重量增減；remove：自動離船；done：已顧好的事；pin_pre：危機前丟不掉；cap：危機後載重增減；
# eat_only：這件事只能靠吃飯顧好（留著糧食不算）；pre_max：危機前預期最高星。
# 其他效果（時間、誰看得到線索）不影響可解性，只記在 note。
CARDS = {
    "A1": dict(deck="A", pin_pre=["麥子"], pre_max=2, note="船主不准丟麥子（危機前）"),
    "A2": dict(deck="A", note="風暴提早 15 秒"),
    "A3": dict(deck="A", weight={"糧食": -1}),
    "A4": dict(deck="A", remove=["纜索"], done=["船身"]),
    "A5": dict(deck="A", note="補船多 10 秒"),
    "B1": dict(deck="B", remove=["器具"], weight={"麥子": -2}),
    "B2": dict(deck="B", remove=["小船"]),
    "B3": dict(deck="B", weight={"糧食": 2}),
    "B4": dict(deck="B", note="醫生的吃飯線索全隊可見"),
    "B5": dict(deck="B", remove=["錨"], done=["天亮"], eat_only=["力氣"]),
}


def world(seed, cards, crisis, fed):
    """回傳 (重量表, 船上可選的東西, 已顧好的事, 危機前釘住的東西, 載重)。"""
    w = dict(seed["weights"])
    removed, done, pinned, eat_only = set(), set(), set(), set()
    cap_delta = 0
    for cid in cards:
        c = CARDS[cid]
        if c["deck"] == "B" and not crisis:
            continue
        for k, d in c.get("weight", {}).items():
            w[k] += d
        removed |= set(c.get("remove", []))
        done |= set(c.get("done", []))
        if not crisis:
            pinned |= set(c.get("pin_pre", []))
        cap_delta += c.get("cap", 0)
        eat_only |= set(c.get("eat_only", []))
    if fed:
        removed.add(seed["food"])
        done.add("力氣")
    items = [i for i in seed["weights"] if i not in removed]
    cap = (seed["cap_post"] + cap_delta) if crisis else seed["cap_pre"]
    return w, items, done, pinned, cap, eat_only


def evaluate(seed, kept, w, done, cap, eat_only=()):
    """回傳 (星數, 原因)；原因 None＝可以出發。"""
    weight = sum(w[i] for i in kept)
    served = [n for n, item in seed["needs"].items() if n in done or (item in kept and n not in eat_only)]
    stars = len(served)
    if weight > cap:
        return stars, "超重"
    return stars, None


def best(seed, cards, crisis, fed):
    w, items, done, pinned, cap, eat_only = world(seed, cards, crisis, fed)
    top = (-1, ())
    for n in range(len(items) + 1):
        for kept in combinations(items, n):
            if not pinned <= set(kept):
                continue
            s, reason = evaluate(seed, kept, w, done, cap, eat_only)
            if reason is None and s > top[0]:
                top = (s, kept)
    return top


def combos():
    a = [k for k, c in CARDS.items() if c["deck"] == "A"]
    b = [k for k, c in CARDS.items() if c["deck"] == "B"]
    return [(x, y) for x in a for y in b]


def answers(seed, cards, crisis, fed, stars):
    """所有能達到 stars 星且可出發的留法（集合）。"""
    w, items, done, pinned, cap, eat_only = world(seed, cards, crisis, fed)
    out = set()
    for n in range(len(items) + 1):
        for kept in combinations(items, n):
            if not pinned <= set(kept):
                continue
            s, reason = evaluate(seed, kept, w, done, cap, eat_only)
            if reason is None and s == stars:
                out.add(kept)
    return out


def changes(name, seed):
    """每張卡和「沒有卡」相比，有沒有改變危機前三星、危機後兩星或吃飯後三星的留法。"""
    base = {k: answers(seed, (), *v) for k, v in {"pre": (False, False, 3), "post": (True, False, 2), "fed": (True, True, 3)}.items()}
    print(f"== {name}：卡片是否改變該怎麼做")
    for cid in CARDS:
        diff = [label for label, (k, v) in {"危機前": ("pre", (False, False, 3)), "危機後兩星": ("post", (True, False, 2)), "吃飯後三星": ("fed", (True, True, 3))}.items()
                if answers(seed, (cid,), *v) != base[k]]
        print(f"  {cid}：{'改變 ' + '、'.join(diff) if diff else '留法不變（只影響時間或資訊）'}")


def check(name, seed):
    ok = True
    print(f"== {name}（{len(combos())} 種故事卡組合）")
    for cards in combos():
        pre = best(seed, cards, crisis=False, fed=False)
        post = best(seed, cards, crisis=True, fed=False)
        fed = best(seed, cards, crisis=True, fed=True)
        pre_max = min(CARDS[c].get("pre_max", 3) for c in cards)
        rules = [
            (f"危機前最高 {pre_max} 星", pre[0] == pre_max),
            ("危機後未吃飯最高恰好 2 星", post[0] == 2),
            ("危機後吃過飯可 3 星", fed[0] == 3),
        ]
        passed = all(p for _, p in rules)
        ok &= passed
        print(f"  [{'通過' if passed else '失敗'}] {'+'.join(cards)}："
              f"危機前 {'★' * pre[0]} {'+'.join(pre[1])}；"
              f"危機後 {'★' * post[0]} {'+'.join(post[1])}；"
              f"吃過飯 {'★' * fed[0]} {'+'.join(fed[1])}"
              + ("" if passed else "  ← " + "、".join(l for l, p in rules if not p)))
    return ok


def export(path):
    """逐筆匯出：種子 × 卡片組合 × 情境 × 每組留下的東西的星等與拒絕原因。"""
    scenarios = {"危機前": (False, False), "危機後": (True, False), "危機後＋吃飯": (True, True)}
    rows = []
    for name, seed in SEEDS.items():
        for cards in combos():
            for scen, (crisis, fed) in scenarios.items():
                w, items, done, _pinned, cap, eat_only = world(seed, cards, crisis, fed)
                for n in range(len(items) + 1):
                    for kept in combinations(items, n):
                        s, reason = evaluate(seed, kept, w, done, cap, eat_only)
                        rows.append(dict(seed=name, cards=list(cards), scenario=scen,
                                         kept=list(kept), stars=s, reason=reason))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(seeds={n: dict(weights=s["weights"], cap_pre=s["cap_pre"], cap_post=s["cap_post"])
                              for n, s in SEEDS.items()}, rows=rows),
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"已匯出 {len(rows)} 筆到 {path}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--export":
        export(sys.argv[2])
        raise SystemExit(0)
    results = [check(n, s) for n, s in SEEDS.items()]
    for n, s in SEEDS.items():
        changes(n, s)
    raise SystemExit(0 if all(results) else 1)
