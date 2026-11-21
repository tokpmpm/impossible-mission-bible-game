#!/usr/bin/env python3
"""窮舉驗證第一關「保羅海難」的可解性、分星與重玩性（含所有故事卡×見聞組合）。只做規則試算，不是遊戲程式。

用法：python3 tools/verify_seeds.py                     # 驗收（全部有三星解、二星保底、照抄成功率 < 20%）
      python3 tools/verify_seeds.py --table             # 另外列出每一種「起風卡×見聞」與可搭配的風暴卡
      python3 tools/verify_seeds.py --metrics           # 只印重玩性指標（JSON）
      python3 tools/verify_seeds.py --export 路徑.json  # 匯出逐筆對照檔給規則引擎測試（test/golden.test.ts）
      python3 tools/verify_seeds.py --difficulty        # 只印每種局面的難度表（JSON；計分用，docs/13-SCORING.md）
      python3 tools/verify_seeds.py --difficulty-ts 路徑.ts  # 產生引擎讀的難度表（src/engine/difficulty.ts）

規則（docs/11-MISSION_01_SHIPWRECK.md、docs/12-REPLAYABILITY.md 第 3 節；2026-11-16 使用者核准，DECISIONS 15、16；
2026-11-20 使用者決定 DECISIONS 18：力氣只能靠吃飯、吃飯也佔「只來得及一件」、拿掉「胃」見聞、顧好 0–1 件＝沒能平安上岸）：
- 船上的東西全部從船上開始；玩家決定留哪些（其餘丟進海裡）。留下的總重 ≤ 安全載重才能「決定好了」／「衝向海灘」。
- 見聞（每局不同，各在一支手機上）：
    食＝今晚力氣靠糧食還是麥子；繩＝船身靠纜索、器具還是小船的繩子；
    水＝淺（可以拋錨）或深（錨先留著，快靠岸時再拋）。
- 星等＝上岸三件事顧好幾件：力氣（今晚的食物，**一定要吃了才算**，27:33–36）、船身（今晚的繩子）、天亮（錨）。
  船身、天亮：留著那樣東西（天亮前來得及用）、卡片已顧好、或已經「用掉」都算。力氣：只有吃飯（或卡片）才算。
- 顧好 0–1 件＝這局沒能平安上岸（遊戲結果；經文裡 276 人都上了岸，結尾照樣寫明）。
- 風暴捲走：危機前丟下海的東西，危機一來就撈不回來（首局不啟用；只影響「風暴前帶什麼」，不影響單一方案的分星）。
- 補好船後三種「用掉」：吃飯（力氣）／捆船底（船身）／拋錨（天亮）——那樣東西離船、那件事顧好；
  天亮前全隊只來得及做 USES 件（=1），吃飯也算在內。要三星就一定要吃飯；拋錨、捆船底是來不及吃時保住二星的退路。
- 一種「起風卡×見聞」要有一種風暴前的帶法，不管翻到哪一張允許的風暴卡都能三星，且允許的風暴卡至少 3 張，才會被抽到。
暴風雨救援 seed 001／002 已於 2026-11-15 退役；ship 001 舊數值（6→4、只能吃飯）於 2026-11-16 換成本版；「胃」見聞與「留著食物就算力氣」於 2026-11-20 拿掉，見 git 歷史與 docs/14。
"""
import json
import sys
from collections import Counter
from itertools import combinations, product

ITEMS = ["糧食", "纜索", "錨", "麥子", "器具", "小船"]
NEEDS = ["力氣", "船身", "天亮"]

SEEDS = {
    "ship 001": dict(
        cap_pre=8, cap_post=5, uses=1, eat_only=["力氣"],
        weights={"糧食": 3, "纜索": 2, "錨": 3, "麥子": 3, "器具": 2, "小船": 2},
    ),
}

# 見聞：每局各發一個值。順序固定（腳本、引擎、對照檔都用這個順序）。
TONIGHT = {"食": ["糧食", "麥子"], "繩": ["纜索", "器具", "小船"], "水": ["淺", "深"]}
# 首局固定的「經典配置」：就是 v0.7 的打法（丟麥子、器具、小船，吃飯），讓新人先學會骨架。
CLASSIC = {"食": "糧食", "繩": "纜索", "水": "深"}

# 補好船後的三種「用掉」。blocked：這個見聞值時不能做。關掉某一種只要從 USE_ENABLED 拿掉（例：試玩後拿掉捆船底）。
USES = {
    "吃飯": dict(need="力氣", blocked=None),
    "捆船底": dict(need="船身", blocked=None),
    "拋錨": dict(need="天亮", blocked=("水", "深")),
}
USE_ENABLED = ["吃飯", "捆船底", "拋錨"]

# 故事卡：deck A＝起風（開局翻開），deck B＝風暴（補好船後翻開）。
# weight：重量增減（最低 0）；remove：自動離船；done：已顧好的事；pin_pre：危機前丟不掉；
# eat_only：這件事只能靠「用掉」顧好（留著東西不算）；fix：這局的見聞固定成這個值（不發這張見聞）；
# exclude：不和這個見聞值同局。其他效果（時間、誰看得到線索）不影響可解性，只記在 note。
CARDS = {
    "A1": dict(deck="A", pin_pre=["麥子"], note="船主不准丟麥子（危機前）"),
    "A2": dict(deck="A", note="風暴提早 15 秒"),
    "A3": dict(deck="A", weight={"糧食": -1}),
    "A4": dict(deck="A", remove=["纜索"], done=["船身"], fix={"繩": "纜索"}),
    "A5": dict(deck="A", note="補船多 10 秒"),
    "B1": dict(deck="B", remove=["器具"], weight={"麥子": -2}),
    "B2": dict(deck="B", remove=["小船"]),
    "B3": dict(deck="B", remove=["麥子"], exclude={"食": "麥子"}, note="276 人吃飽了，把麥子拋在海裡（27:37–38）"),
    "B4": dict(deck="B", note="醫生的吃飯線索全隊可見"),
    "B5": dict(deck="B", remove=["錨"], done=["天亮"]),
}
DECK_A = [k for k, c in CARDS.items() if c["deck"] == "A"]
DECK_B = [k for k, c in CARDS.items() if c["deck"] == "B"]
MIN_B = 3


def subsets(xs):
    xs = [i for i in ITEMS if i in xs]
    for n in range(len(xs) + 1):
        for c in combinations(xs, n):
            yield frozenset(c)


def provider(tn):
    """今晚上岸三件事各靠哪一樣東西。"""
    return {"力氣": tn["食"], "船身": tn["繩"], "天亮": "錨"}


def weights(seed, cards):
    w = dict(seed["weights"])
    for c in cards:
        for k, d in CARDS[c].get("weight", {}).items():
            w[k] = max(0, w[k] + d)
    return w


def story_ok(a, tn, b=None):
    """這張起風卡（和風暴卡）能不能和這組見聞同局。"""
    for c in [a] + ([b] if b else []):
        for d, v in CARDS[c].get("fix", {}).items():
            if tn[d] != v:
                return False
        for d, v in CARDS[c].get("exclude", {}).items():
            if tn[d] == v:
                return False
    return True


def can_use(use, tn):
    if use not in USE_ENABLED:
        return False
    bl = USES[use]["blocked"]
    return not (bl and tn[bl[0]] == bl[1])


def world(seed, a, b, tn, crisis, used=None):
    """回傳 (重量表, 船上可能有的東西, 已顧好的事, 危機前釘住的東西, 載重, 只能靠用掉的事)。
    crisis=False：危機前（只有起風卡）；crisis=True：補好船後（起風＋風暴卡）。used：已用掉的那一種（或 None）。"""
    cards = [a] + ([b] if crisis else [])
    w = weights(seed, cards)
    # 力氣只能靠吃飯：危機後才算（危機前還不能吃，留著今晚的食物＝準備好了，2:15 提示與「原本顧好幾件」照這個算）
    removed, done, pinned, eat_only = set(), set(), set(), set(seed.get("eat_only", []) if crisis else [])
    for c in cards:
        cd = CARDS[c]
        removed |= set(cd.get("remove", []))
        done |= set(cd.get("done", []))
        eat_only |= set(cd.get("eat_only", []))
        if not crisis:
            pinned |= set(cd.get("pin_pre", []))
    if used:
        need = USES[used]["need"]
        removed.add(provider(tn)[need])
        done.add(need)
    aboard = [i for i in ITEMS if i not in removed]
    cap = seed["cap_post"] if crisis else seed["cap_pre"]
    return w, aboard, done, pinned, cap, eat_only


def evaluate(seed, kept, tn, w, aboard, done, cap, eat_only):
    """回傳 (星數, 原因)；原因 None＝可以出發。kept 裡不在船上的東西不算（與引擎相同）。"""
    kept = [i for i in kept if i in aboard]
    weight = sum(w[i] for i in kept)
    pv = provider(tn)
    stars = sum(1 for n in NEEDS if n in done or (pv[n] in kept and n not in eat_only))
    return stars, ("超重" if weight > cap else None)


def uses_available(seed, a, b, tn, aboard_set):
    """補好船後，這局真的能做的「用掉」（東西要還在船上、那件事還沒顧好、見聞允許）。"""
    _w, _ab, done, _p, _c, _e = world(seed, a, b, tn, True)
    pv = provider(tn)
    return [u for u in USES if can_use(u, tn) and USES[u]["need"] not in done and pv[USES[u]["need"]] in aboard_set]


def stage1(seed, a, tn):
    """風暴前可以帶過危機的組合（危機前不超重、含釘住的東西）。"""
    w, aboard, _d, pinned, cap, _e = world(seed, a, None, tn, False)
    return [K for K in subsets(aboard) if pinned <= K and sum(w[i] for i in K) <= cap]


def stage2(seed, a, b, tn, K1, lines=False):
    """風暴前帶著 K1 過了危機（漂著的被捲走），補好船、翻開風暴卡後的最高星（與達成的做法）。"""
    _w0, aboard0, _d, _p, _c, _e = world(seed, a, b, tn, True)
    aboard = set(K1) & set(aboard0)
    av = uses_available(seed, a, b, tn, aboard)
    best, out = -1, []
    for n in range(0, seed["uses"] + 1):
        for us in combinations(av, n):
            used = us[0] if us else None  # USES=1：最多一件
            w, ab, done, _p, cap, eo = world(seed, a, b, tn, True, used)
            pool = aboard & set(ab) & set(provider(tn).values())  # 上岸只帶今晚用得上的東西（多帶別的只會更重）
            for K2 in subsets(pool):
                s, reason = evaluate(seed, K2, tn, w, ab, done, cap, eo)
                if reason:
                    continue
                if s > best:
                    best, out = s, []
                if s == best and lines:
                    out.append((used, K2))
    return (best, out) if lines else best


def tonights():
    for vals in product(*TONIGHT.values()):
        yield dict(zip(TONIGHT, vals))


def tkey(tn):
    return "/".join(tn[d] for d in TONIGHT)


def setups(seed):
    """所有通過的「起風卡×見聞」：(A, 見聞, 允許的風暴卡, {K1: [各風暴卡最高星]})；以及全部試過的數量。"""
    valid, tried = [], 0
    for a in DECK_A:
        for tn in tonights():
            if not story_ok(a, tn):
                continue
            tried += 1
            res = {K1: [stage2(seed, a, b, tn, K1) for b in DECK_B] for K1 in stage1(seed, a, tn)}
            allowed = [i for i, b in enumerate(DECK_B) if story_ok(a, tn, b)]
            chosen = None
            for n in range(len(allowed), MIN_B - 1, -1):
                for S in combinations(allowed, n):
                    if any(all(r[i] == 3 for i in S) for r in res.values()):
                        chosen = S
                        break
                if chosen:
                    break
            if chosen:
                valid.append((a, tn, [DECK_B[i] for i in chosen], {K: {DECK_B[i]: r[i] for i in range(len(DECK_B))} for K, r in res.items()}))
    return valid, tried


def robust(entry):
    """不管翻到哪一張允許的風暴卡都三星的風暴前帶法中，最省的幾種。"""
    _a, _tn, bs, res = entry
    rob = [K for K, r in res.items() if all(r[b] == 3 for b in bs)]
    return sorted((K for K in rob if not any(o < K for o in rob)), key=lambda K: [ITEMS.index(i) for i in ITEMS if i in K])


def run_line(seed, a, tn, b, line):
    """把一套打法（風暴前帶什麼、用掉哪件、帶什麼上岸）原封不動用在這一局，得幾星。"""
    K1, use, K2 = line
    w1, aboard1, _d, pinned, cap1, _e = world(seed, a, None, tn, False)
    K = (set(K1) & set(aboard1)) | pinned
    if sum(w1[i] for i in K) > cap1:
        return 0
    _w, ab0, _d, _p, _c, _e = world(seed, a, b, tn, True)
    aboard = K & set(ab0)
    if use and use in uses_available(seed, a, b, tn, aboard):
        w, ab, done, _p, cap, eo = world(seed, a, b, tn, True, use)
    else:
        w, ab, done, _p, cap, eo = world(seed, a, b, tn, True)
    keep = aboard & set(ab) & set(K2)
    s, reason = evaluate(seed, keep, tn, w, ab, done, cap, eo)
    return 0 if reason else s


def metrics(seed):
    """重玩性指標（docs/12-REPLAYABILITY.md 3.6 節）。"""
    valid, tried = setups(seed)
    games = [(a, tkey(tn), b) for a, tn, bs, _r in valid for b in bs]
    byk = {(a, tkey(tn)): (tn, bs, res) for a, tn, bs, res in valid}
    n = len(games)
    L = {}
    for a, k, b in games:
        tn, _bs, res = byk[(a, k)]
        ls = set()
        for K1 in res:
            s, l2 = stage2(seed, a, b, tn, K1, lines=True)
            if s == 3:
                ls |= {(K1, u, K2) for u, K2 in l2}
        L[(a, k, b)] = ls
    alllines = set().union(*L.values())
    succ = {l: frozenset(g for g in games if run_line(seed, g[0], byk[(g[0], g[1])][0], g[2], l) == 3) for l in alllines}
    copy_best = sum(len(set().union(*[succ[l] for l in L[g]]) - {g}) for g in games) / (n * (n - 1))
    copy_avg = sum(sum(len(succ[l] - {g}) for l in L[g]) / len(L[g]) for g in games) / (n * (n - 1))
    fixed = max(len(s) for s in succ.values()) / n
    # 不問隊友：只看公開的起風卡決定風暴前帶什麼，之後都走最佳
    blind = 0
    for a in DECK_A:
        ks = [(k, v) for k, v in byk.items() if k[0] == a]
        if not ks:
            continue
        allK = set().union(*[set(v[2]) for _k, v in ks])
        sc = {K: sum(sum(1 for b in v[1] if v[2].get(K, {}).get(b, 0) == 3) for _k, v in ks) for K in allK}
        blind += max(sc.values())
    sigs = Counter(frozenset(robust(e)) for e in valid)
    two = all(any(all(r[b] >= 2 for b in bs) for r in res.values()) for _a, _tn, bs, res in valid)
    return dict(
        tried=tried, setups=len(valid), games=n,
        three=sum(1 for g in games if L[g]), two_floor=two,
        copy_best=round(copy_best, 4), copy_avg=round(copy_avg, 4), fixed=round(fixed, 4), blind=round(blind / n, 4),
        signatures=len(sigs),
    )


# ---------- 計分用難度表（docs/13-SCORING.md；2026-11-16 使用者核准，試行） ----------
# 每種局面（起風卡×見聞×風暴卡）補好船後有幾種三星解：
#   （不用掉／三種用掉之一）×（上岸帶的東西組合，只算還在船上的東西）中，不超重且顧好三件事的組合數。
#   不考慮風暴捲走（捲走只影響風暴前帶什麼，另外用 SWEEP_BONUS 加分）。
# 解越少越難：DIFF_MAX × (最多解數 − 這局解數) ÷ (最多解數 − 最少解數)，四捨五入成整數。
DIFF_MAX = 80     # 難度加成中「三星解多寡」的部分
SWEEP_BONUS = 20  # 第二局起有風暴捲走再加


def solutions(seed, a, b, tn):
    """補好船後的三星解數（不用掉＋各種用掉 × 上岸帶法）。"""
    n = 0
    for use in [None] + list(USES):
        if use and use not in uses_available(seed, a, b, tn, set(ITEMS)):
            continue
        w, ab, done, _p, cap, eo = world(seed, a, b, tn, True, use)
        for K in subsets(ab):
            s, reason = evaluate(seed, K, tn, w, ab, done, cap, eo)
            if s == 3 and not reason:
                n += 1
    return n


def round_half_up(x):
    return int(x + 0.5)


def difficulty(seed):
    """每種局面的難度：{"A1|糧食/纜索/深/吃得下|B1": {"solutions": n, "points": 0–DIFF_MAX}}。"""
    valid, _tried = setups(seed)
    rows = {f"{a}|{tkey(tn)}|{b}": solutions(seed, a, b, tn) for a, tn, bs, _r in valid for b in bs}
    hi, lo = max(rows.values()), min(rows.values())
    span = max(1, hi - lo)
    return dict(max=DIFF_MAX, sweep_bonus=SWEEP_BONUS, most=hi, fewest=lo,
                games={k: dict(solutions=n, points=round_half_up(DIFF_MAX * (hi - n) / span)) for k, n in rows.items()})


def export_difficulty_ts(path):
    d = difficulty(SEEDS["ship 001"])
    lines = [
        "// 由 tools/verify_seeds.py --difficulty-ts 產生，請勿手改（npm run golden 會一起更新）。",
        "// 每種局面（起風卡|食/繩/水|風暴卡）補好船後有幾種三星解，與難度分（解越少越高）。docs/13-SCORING.md。",
        f"export const DIFF_MAX = {d['max']};",
        f"export const SWEEP_BONUS = {d['sweep_bonus']};",
        f"export const DIFF_MOST = {d['most']};",
        f"export const DIFF_FEWEST = {d['fewest']};",
        "export const DIFFICULTY: Record<string, { solutions: number; points: number }> = {",
    ]
    for k, v in d["games"].items():
        lines.append(f"  '{k}': {{ solutions: {v['solutions']}, points: {v['points']} }},")
    lines.append("};")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"已匯出 {len(d['games'])} 種局面的難度到 {path}")


def check(name, seed, table=False):
    valid, tried = setups(seed)
    m = metrics(seed)
    print(f"== {name}：起風卡×見聞 {tried} 種，{len(valid)} 種通過；合計 {m['games']} 種局面")
    print(f"  數值：{seed['weights']}；載重 {seed['cap_pre']}→{seed['cap_post']}；天亮前只來得及用掉 {seed['uses']} 件（{'、'.join(USE_ENABLED)}）")
    classic_a = [a for a, tn, _b, _r in valid if tn == CLASSIC]
    rules = [
        (f"三星有解 {m['three']}/{m['games']}", m["three"] == m["games"]),
        ("每種起風卡×見聞都有二星保底（不會沒能平安上岸）的帶法", m["two_floor"]),
        (f"照抄成功率 {m['copy_best']:.1%} < 20%", m["copy_best"] < 0.20),
        (f"首局經典配置可用的起風卡：{'、'.join(classic_a)}（至少 3 張）", len(classic_a) >= 3),
    ]
    d = difficulty(seed)
    pts = [v["points"] for v in d["games"].values()]
    rules.append((f"難度表涵蓋全部 {m['games']} 種局面、三星解 {d['fewest']}–{d['most']} 種、難度分 {min(pts)}–{max(pts)}（≤ {DIFF_MAX}）",
                  len(d["games"]) == m["games"] and min(v["solutions"] for v in d["games"].values()) >= 1 and 0 <= min(pts) and max(pts) <= DIFF_MAX))
    print(f"  照抄成功率 {m['copy_best']:.1%}；隨機取一個三星打法 {m['copy_avg']:.1%}；最強固定打法 {m['fixed']:.1%}；"
          f"不問隊友 {m['blind']:.1%}；風暴前最省的必帶組合 {m['signatures']} 種")
    if table:
        print("  -- 通過的組合（食/繩/水｜可搭配的風暴卡｜風暴前最省的必帶組合）")
        for e in valid:
            a, tn, bs, _res = e
            print(f"  {a} {tkey(tn)}｜{''.join(bs)}｜{'、'.join('+'.join(i for i in ITEMS if i in K) for K in robust(e))}")
    for label, ok in rules:
        print(f"  [{'通過' if ok else '失敗'}] {label}")
    return all(ok for _l, ok in rules)


def mask_items(m):
    return [ITEMS[i] for i in range(len(ITEMS)) if m >> i & 1]


def encode(seed, tn, w, aboard, done, cap, eat_only):
    """64 種留法（位元 i＝ITEMS[i]）各一個字元：'0'–'3'＝可出發的星數；'a'–'d'＝超重時的星數。"""
    out = []
    for m in range(1 << len(ITEMS)):
        s, reason = evaluate(seed, mask_items(m), tn, w, aboard, done, cap, eat_only)
        out.append("abcd"[s] if reason else str(s))
    return "".join(out)


def export(path):
    """逐筆匯出：每種通過的「起風卡×見聞」危機前 64 種留法；每種局面 × 不用掉／三種用掉 × 64 種留法；
    以及每種局面的一套三星打法（給引擎整局重播）。"""
    name, seed = "ship 001", SEEDS["ship 001"]
    valid, _tried = setups(seed)
    out = []
    for e in valid:
        a, tn, bs, res = e
        w, aboard, done, _p, cap, eo = world(seed, a, None, tn, False)
        rob = robust(e)
        games = []
        for b in bs:
            post = {}
            for use in [None] + list(USES):
                if use and use not in uses_available(seed, a, b, tn, set(ITEMS)):
                    continue
                w2, ab2, done2, _p2, cap2, eo2 = world(seed, a, b, tn, True, use)
                post[use or "無"] = encode(seed, tn, w2, ab2, done2, cap2, eo2)
            # 一套三星打法：最省的保險帶法＋第一個三星的做法（不用掉優先）
            s, lines = stage2(seed, a, b, tn, rob[0], lines=True)
            assert s == 3
            use, K2 = sorted(lines, key=lambda x: (x[0] is not None, x[0] or "", len(x[1]), [ITEMS.index(i) for i in x[1]]))[0]
            games.append(dict(b=b, post=post, line=dict(keep=[i for i in ITEMS if i in rob[0]], use=use, land=[i for i in ITEMS if i in K2])))
        out.append(dict(a=a, tonight=tn, b=bs, pre=encode(seed, tn, w, aboard, done, cap, eo),
                        robust=[[i for i in ITEMS if i in K] for K in rob], games=games))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(seed=name, items=ITEMS, weights=seed["weights"], cap_pre=seed["cap_pre"], cap_post=seed["cap_post"],
                       uses=seed["uses"], use_enabled=USE_ENABLED, classic=CLASSIC, metrics=metrics(seed), setups=out,
                       difficulty=difficulty(seed)),
                  f, ensure_ascii=False, indent=0, separators=(",", ":"))
    print(f"已匯出 {len(out)} 種起風卡×見聞、{sum(len(e['games']) for e in out)} 種局面到 {path}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--export":
        export(sys.argv[2])
        raise SystemExit(0)
    if len(sys.argv) == 3 and sys.argv[1] == "--difficulty-ts":
        export_difficulty_ts(sys.argv[2])
        raise SystemExit(0)
    if "--difficulty" in sys.argv:
        print(json.dumps(difficulty(SEEDS["ship 001"]), ensure_ascii=False))
        raise SystemExit(0)
    if "--metrics" in sys.argv:
        print(json.dumps(metrics(SEEDS["ship 001"]), ensure_ascii=False))
        raise SystemExit(0)
    ok = all(check(n, s, "--table" in sys.argv) for n, s in SEEDS.items())
    raise SystemExit(0 if ok else 1)
