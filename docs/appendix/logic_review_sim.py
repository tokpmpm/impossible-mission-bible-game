#!/usr/bin/env python3
"""docs/14-LOGIC-REVIEW.md 的暫存試算：比較現行規則（V0）與幾種「力氣只能靠吃飯」修正版的可解性、重玩性與難度分布。
只做規則試算，不是遊戲程式；不改 tools/verify_seeds.py。V0 必須重現 verify_seeds 的數字（64／262／13.5%…），才能拿來比較。

用法：python3 docs/appendix/logic_review_sim.py          # 全部方案的摘要表
      python3 docs/appendix/logic_review_sim.py V1 --dist  # 加印某方案的三星解數分布

方案（細節見 docs/14 第 3 節）：
  V0  現行（verify_seeds.py 的規則）
  V1  力氣只能靠吃飯；吃飯「全隊一起」、不佔「只來得及一件」；拿掉「吃不下」見聞；B5 不再需要 eatOnly
  V2  V1 ＋ 危機後載重 5→4（讓拋錨／捆船底的取捨回來）
  V3  只把力氣改成只能靠吃飯，其餘不動（吃飯仍佔那一件）——示範為什麼不能只改一行
  V5  V2 ＋ B3 改成「276 人吃飽了，把麥子拋在海裡」（27:37–38）：麥子自動離船，不和「今晚靠麥子」同局（建議案）
  V4  V2 ＋ B3 改成「276 人一起吃，吃飯花比較久：這局吃飯也佔掉那一件」（B3 原本的糧食變重在 V2 會失效）
"""
import sys
from collections import Counter
from itertools import combinations, product

ITEMS = ["糧食", "纜索", "錨", "麥子", "器具", "小船"]
NEEDS = ["力氣", "船身", "天亮"]
BASE_CARDS = {
    "A1": dict(deck="A", pin_pre=["麥子"]),
    "A2": dict(deck="A"),
    "A3": dict(deck="A", weight={"糧食": -1}),
    "A4": dict(deck="A", remove=["纜索"], done=["船身"], fix={"繩": "纜索"}),
    "A5": dict(deck="A"),
    "B1": dict(deck="B", remove=["器具"], weight={"麥子": -2}),
    "B2": dict(deck="B", remove=["小船"]),
    "B3": dict(deck="B", weight={"糧食": 2}),
    "B4": dict(deck="B"),
    "B5": dict(deck="B", remove=["錨"], done=["天亮"], eat_only=["力氣"], exclude={"胃": "吃不下"}),
}
BASE = dict(
    weights={"糧食": 3, "纜索": 2, "錨": 3, "麥子": 3, "器具": 2, "小船": 2},
    cap_pre=8, cap_post=5,
    tonight={"食": ["糧食", "麥子"], "繩": ["纜索", "器具", "小船"], "水": ["淺", "深"], "胃": ["吃得下", "吃不下"]},
    uses={"吃飯": ("力氣", ("胃", "吃不下")), "捆船底": ("船身", None), "拋錨": ("天亮", ("水", "深"))},
    slot=1,               # 「只來得及一件」的件數
    free=set(),           # 不佔那一件的用掉
    eat_only=set(),       # 全域：只能靠用掉顧好的事
    cards=BASE_CARDS,
)


def variant(name):
    v = {k: (dict(x) if isinstance(x, dict) else set(x) if isinstance(x, set) else x) for k, x in BASE.items()}
    v["cards"] = {k: dict(c) for k, c in BASE_CARDS.items()}
    if name in ("V1", "V2", "V5"):
        v["eat_only"] = {"力氣"}
        v["free"] = {"吃飯"}
        v["tonight"] = {k: x for k, x in v["tonight"].items() if k != "胃"}
        v["uses"] = {"吃飯": ("力氣", None), "捆船底": ("船身", None), "拋錨": ("天亮", ("水", "深"))}
        v["cards"]["B5"] = dict(deck="B", remove=["錨"], done=["天亮"])
    if name in ("V2", "V4"):
        v["cap_post"] = 4
    if name == "V5":
        v["cap_post"] = 4
        v["cards"]["B3"] = dict(deck="B", remove=["麥子"], exclude={"食": "麥子"})
    if name == "V4":
        v["eat_only"] = {"力氣"}
        v["free"] = {"吃飯"}
        v["tonight"] = {k: x for k, x in v["tonight"].items() if k != "胃"}
        v["uses"] = {"吃飯": ("力氣", None), "捆船底": ("船身", None), "拋錨": ("天亮", ("水", "深"))}
        v["cards"]["B5"] = dict(deck="B", remove=["錨"], done=["天亮"])
        v["cards"]["B3"] = dict(deck="B", slow_meal=True)
    if name == "V3":
        v["eat_only"] = {"力氣"}
        v["cards"]["B5"] = dict(deck="B", remove=["錨"], done=["天亮"], exclude={"胃": "吃不下"})
    return v


class Sim:
    def __init__(self, cfg):
        self.c = cfg
        self.A = [k for k, x in cfg["cards"].items() if x["deck"] == "A"]
        self.B = [k for k, x in cfg["cards"].items() if x["deck"] == "B"]

    def pv(self, tn):
        return {"力氣": tn["食"], "船身": tn["繩"], "天亮": "錨"}

    def tonights(self):
        T = self.c["tonight"]
        for vals in product(*T.values()):
            yield dict(zip(T, vals))

    def story_ok(self, cards, tn):
        for c in cards:
            cd = self.c["cards"][c]
            if any(tn.get(d) != v for d, v in cd.get("fix", {}).items()):
                return False
            if any(tn.get(d) == v for d, v in cd.get("exclude", {}).items()):
                return False
        return True

    def can_use(self, u, tn):
        bl = self.c["uses"][u][1]
        return not (bl and tn.get(bl[0]) == bl[1])

    def world(self, a, b, tn, crisis, used=frozenset()):
        cards = [a] + ([b] if crisis else [])
        w = dict(self.c["weights"])
        removed, done, pinned, eo = set(), set(), set(), set(self.c["eat_only"])
        for c in cards:
            cd = self.c["cards"][c]
            for k, d in cd.get("weight", {}).items():
                w[k] = max(0, w[k] + d)
            removed |= set(cd.get("remove", []))
            done |= set(cd.get("done", []))
            eo |= set(cd.get("eat_only", []))
            if not crisis:
                pinned |= set(cd.get("pin_pre", []))
        for u in used:
            n = self.c["uses"][u][0]
            removed.add(self.pv(tn)[n])
            done.add(n)
        return w, [i for i in ITEMS if i not in removed], done, pinned, (self.c["cap_post"] if crisis else self.c["cap_pre"]), eo

    def stars(self, kept, tn, w, aboard, done, cap, eo):
        kept = [i for i in kept if i in aboard]
        pv = self.pv(tn)
        s = sum(1 for n in NEEDS if n in done or (pv[n] in kept and n not in eo))
        return s, sum(w[i] for i in kept) > cap

    def avail(self, a, b, tn, aboard):
        _w, _ab, done, _p, _c, _e = self.world(a, b, tn, True)
        pv = self.pv(tn)
        return [u for u in self.c["uses"] if self.can_use(u, tn) and self.c["uses"][u][0] not in done and pv[self.c["uses"][u][0]] in aboard]

    def use_sets(self, av, b=None):
        free = set(self.c["free"])
        if b and self.c["cards"][b].get("slow_meal"):
            free.discard("吃飯")
        out = []
        for n in range(len(av) + 1):
            for us in combinations(av, n):
                if sum(1 for u in us if u not in free) <= self.c["slot"]:
                    out.append(frozenset(us))
        return out

    def stage1(self, a, tn):
        w, aboard, _d, pinned, cap, _e = self.world(a, None, tn, False)
        xs = aboard
        res = []
        for n in range(len(xs) + 1):
            for K in combinations(xs, n):
                K = frozenset(K)
                if pinned <= K and sum(w[i] for i in K) <= cap:
                    res.append(K)
        return res

    def stage2(self, a, b, tn, K1, lines=False):
        _w, ab0, *_ = self.world(a, b, tn, True)
        aboard = set(K1) & set(ab0)
        best, out = -1, []
        for us in self.use_sets(self.avail(a, b, tn, aboard), b):
            w, ab, done, _p, cap, eo = self.world(a, b, tn, True, us)
            pool = [i for i in ITEMS if i in aboard and i in ab and i in self.pv(tn).values()]
            for n in range(len(pool) + 1):
                for K2 in combinations(pool, n):
                    s, over = self.stars(K2, tn, w, ab, done, cap, eo)
                    if over:
                        continue
                    if s > best:
                        best, out = s, []
                    if s == best and lines:
                        out.append((us, frozenset(K2)))
        return (best, out) if lines else best

    def setups(self):
        valid, tried = [], 0
        for a in self.A:
            for tn in self.tonights():
                if not self.story_ok([a], tn):
                    continue
                tried += 1
                res = {K1: [self.stage2(a, b, tn, K1) for b in self.B] for K1 in self.stage1(a, tn)}
                allowed = [i for i, b in enumerate(self.B) if self.story_ok([a, b], tn)]
                chosen = None
                for n in range(len(allowed), 2, -1):
                    for S in combinations(allowed, n):
                        if any(all(r[i] == 3 for i in S) for r in res.values()):
                            chosen = S
                            break
                    if chosen:
                        break
                if chosen:
                    valid.append((a, tn, [self.B[i] for i in chosen], {K: {self.B[i]: r[i] for i in range(len(self.B))} for K, r in res.items()}))
        return valid, tried

    def run_line(self, a, tn, b, line):
        K1, us, K2 = line
        w1, ab1, _d, pinned, cap1, _e = self.world(a, None, tn, False)
        K = (set(K1) & set(ab1)) | pinned
        if sum(w1[i] for i in K) > cap1:
            return 0
        _w, ab0, *_ = self.world(a, b, tn, True)
        aboard = K & set(ab0)
        av = self.avail(a, b, tn, aboard)
        real = frozenset(u for u in us if u in av)
        w, ab, done, _p, cap, eo = self.world(a, b, tn, True, real)
        s, over = self.stars(aboard & set(ab) & set(K2), tn, w, ab, done, cap, eo)
        return 0 if over else s

    def solutions(self, a, b, tn):
        n = 0
        for us in self.use_sets(self.avail(a, b, tn, set(ITEMS)), b):
            w, ab, done, _p, cap, eo = self.world(a, b, tn, True, us)
            for m in range(len(ab) + 1):
                for K in combinations(ab, m):
                    s, over = self.stars(K, tn, w, ab, done, cap, eo)
                    if s == 3 and not over:
                        n += 1
        return n

    def metrics(self):
        valid, tried = self.setups()
        key = lambda tn: "/".join(tn[d] for d in self.c["tonight"])
        games = [(a, key(tn), b) for a, tn, bs, _r in valid for b in bs]
        byk = {(a, key(tn)): (tn, bs, res) for a, tn, bs, res in valid}
        n = len(games)
        L = {}
        for a, k, b in games:
            tn, _bs, res = byk[(a, k)]
            ls = set()
            for K1 in res:
                s, l2 = self.stage2(a, b, tn, K1, lines=True)
                if s == 3:
                    ls |= {(K1, u, K2) for u, K2 in l2}
            L[(a, k, b)] = ls
        alll = set().union(*L.values()) if L else set()
        succ = {l: frozenset(g for g in games if self.run_line(g[0], byk[(g[0], g[1])][0], g[2], l) == 3) for l in alll}
        copy_best = sum(len(set().union(*[succ[l] for l in L[g]]) - {g}) for g in games) / (n * (n - 1)) if n > 1 else 0
        fixed = max(len(s) for s in succ.values()) / n if n else 0
        blind = 0
        for a in self.A:
            ks = [(k, v) for k, v in byk.items() if k[0] == a]
            if not ks:
                continue
            allK = set().union(*[set(v[2]) for _k, v in ks])
            sc = {K: sum(sum(1 for b in v[1] if v[2].get(K, {}).get(b, 0) == 3) for _k, v in ks) for K in allK}
            blind += max(sc.values())
        two = all(any(all(r[b] >= 2 for b in bs) for r in res.values()) for _a, _tn, bs, res in valid)
        sols = Counter(self.solutions(a, b, byk[(a, k)][0]) for a, k, b in games)
        # 首局經典配置（V1/V2 沒有「胃」）
        classic = {"食": "糧食", "繩": "纜索", "水": "深", "胃": "吃得下"}
        classic = {d: classic[d] for d in self.c["tonight"]}
        classic_a = [a for a, tn, _b, _r in valid if tn == classic]
        # 不吃飯也能三星的局面（力氣靠「帶著」）
        no_eat = sum(1 for a, k, b in games if any("吃飯" not in u for u, _K in
                     [x for K1 in byk[(a, k)][2] for x in (self.stage2(a, b, byk[(a, k)][0], K1, lines=True)[1] if self.stage2(a, b, byk[(a, k)][0], K1) == 3 else [])]))
        return dict(tried=tried, setups=len(valid), games=n, three=sum(1 for g in games if L[g]), two_floor=two,
                    copy_best=copy_best, fixed=fixed, blind=blind / n if n else 0, sols=dict(sorted(sols.items())),
                    classic_a=classic_a, no_eat=no_eat)


def main():
    names = [a for a in sys.argv[1:] if a.startswith("V")] or ["V0", "V1", "V2", "V3", "V4", "V5"]
    print("方案｜試過｜通過｜局面｜三星有解｜二星保底｜照抄成功率｜最強固定打法｜不問隊友｜不吃飯也三星的局面｜首局可用起風卡")
    for nm in names:
        m = Sim(variant(nm)).metrics()
        print(f"{nm}｜{m['tried']}｜{m['setups']}｜{m['games']}｜{m['three']}｜{'是' if m['two_floor'] else '否'}｜"
              f"{m['copy_best']:.1%}｜{m['fixed']:.1%}｜{m['blind']:.1%}｜{m['no_eat']}｜{'、'.join(m['classic_a']) or '無'}")
        if "--dist" in sys.argv:
            print(f"   三星解數分布（解數: 局面數）：{m['sols']}")


if __name__ == "__main__":
    main()
