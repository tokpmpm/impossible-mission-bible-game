#!/usr/bin/env python3
"""窮舉驗證手工關卡（seed）的可解性與分星。只做規則試算，不是遊戲程式。

用法：python3 tools/verify_seeds.py
"""
from itertools import combinations

SEEDS = {
    "seed 001": dict(
        cap=7, flood=5,
        routes={"紅": (3, "繩子"), "藍": (4, "燈具"), "綠": (6, None)},
        weights={"繩子": 1, "燈具": 3, "藥品": 1, "飲水": 2, "毛毯": 3, "食物": 2},
        needs={"東村": "藥品", "西村": "飲水", "北村": "毛毯"},
        urgent=("東村", "西村"),
        closed="紅",                       # 危機：吊橋坍塌
        breakthrough=("綠", "flood", 7),   # 分洪閘門：安全窗 5 -> 7
        planned_three_star="紅",           # 危機前看似可三星的路線
    ),
    "seed 002": dict(
        cap=6, flood=5,
        routes={"紅": (3, "繩子"), "藍": (4, "燈具"), "綠": (6, None)},
        weights={"繩子": 3, "燈具": 1, "食物": 2, "藥品": 1, "飲水": 2, "毛毯": 3},
        needs={"東村": "食物", "西村": "藥品", "北村": "飲水"},
        urgent=("東村", "西村"),
        closed="藍",                       # 危機：隧道積水
        breakthrough=("綠", "travel", 4),  # 修復便橋：綠線 6 -> 4
        planned_three_star="藍",
    ),
}


def stars(seed, route, cargo, crisis, used_breakthrough):
    """回傳 (星數, 原因)；星數 0 代表拒絕出發。"""
    travel, tool = seed["routes"][route]
    flood = seed["flood"]
    if used_breakthrough and route == seed["breakthrough"][0]:
        kind, value = seed["breakthrough"][1:]
        if kind == "flood":
            flood = value
        else:
            travel = value
    if crisis and route == seed["closed"]:
        return 0, "道路封閉"
    if travel >= flood:
        return 0, "來不及"
    if tool and tool not in cargo:
        return 0, "缺少工具"
    if sum(seed["weights"][c] for c in cargo) > seed["cap"]:
        return 0, "超重"
    served = [v for v, item in seed["needs"].items() if item in cargo]
    if not served:
        return 0, "沒有任何村需要的物資"
    if len(served) == len(seed["needs"]):
        return 3, "三村"
    if all(v in served for v in seed["urgent"]):
        return 2, "兩個急迫村"
    return 1, "未滿足兩個急迫村"


def best(seed, crisis, used_breakthrough):
    items = list(seed["weights"])
    result = {}
    for route in seed["routes"]:
        top = (0, ())
        for n in range(len(items) + 1):
            for cargo in combinations(items, n):
                s, _ = stars(seed, route, cargo, crisis, used_breakthrough)
                if s > top[0]:
                    top = (s, cargo)
        result[route] = top
    return result


def check(name, seed):
    pre = best(seed, crisis=False, used_breakthrough=False)
    post = best(seed, crisis=True, used_breakthrough=False)
    brk = best(seed, crisis=True, used_breakthrough=True)
    other = [r for r in ("紅", "藍") if r != seed["closed"]][0]
    rules = [
        ("危機前：預定路線可規劃三村", pre[seed["planned_three_star"]][0] == 3),
        ("危機前：另一條常規路線最多二星", pre[other][0] == 2),
        ("危機前：綠線不可行", pre["綠"][0] == 0),
        ("危機後、無突破口：最高二星", max(v[0] for v in post.values()) == 2),
        ("危機後：剩下的常規路線有二星解", post[other][0] == 2),
        ("危機後＋突破口：綠線三星", brk["綠"][0] == 3),
        ("三星只來自綠線", all(brk[r][0] < 3 for r in ("紅", "藍"))),
    ]
    print(f"== {name}")
    for label, table in (("危機前", pre), ("危機後", post), ("危機後＋突破口", brk)):
        print("  " + label + "：" + "；".join(
            f"{r} {'★' * s or '不可行'} {'+'.join(c)}" for r, (s, c) in table.items()))
    ok = True
    for label, passed in rules:
        print(f"  [{'通過' if passed else '失敗'}] {label}")
        ok &= passed
    return ok


if __name__ == "__main__":
    results = [check(n, s) for n, s in SEEDS.items()]
    raise SystemExit(0 if all(results) else 1)
