#!/usr/bin/env python3
"""窮舉驗證手工關卡（seed）的可解性與分星。只做規則試算，不是遊戲程式。

用法：python3 tools/verify_seeds.py
"""
from itertools import combinations

REGULAR = ("紅", "藍")

SEEDS = {
    # 結構 A：預定路線被封，換路後工具太重；突破口是讓山路來得及。
    "seed 001": dict(
        cap=7, flood=5,
        routes={"紅": (3, "繩子"), "藍": (4, "燈具"), "綠": (6, None)},
        weights={"繩子": 1, "燈具": 3, "藥品": 1, "飲水": 2, "毛毯": 3, "食物": 2},
        needs={"東村": "藥品", "西村": "飲水", "北村": "毛毯"},
        urgent=("東村", "西村"),
        crisis=dict(closed="紅"),                       # 吊橋坍塌
        breakthrough=dict(kind="flood", route="綠", value=7),  # 分洪閘門
        plan_route="紅", three_star_route="綠",
    ),
    # 結構 B：路都還在，但車輛受損載重下降；突破口是更輕的替代物資。
    "seed 002": dict(
        cap=6, flood=5,
        routes={"紅": (3, "繩子"), "藍": (4, "燈具"), "綠": (6, None)},
        weights={"繩子": 3, "燈具": 1, "食物": 2, "藥品": 1, "飲水": 2,
                 "毛毯": 3, "淨水錠": 1},
        needs={"東村": "食物", "西村": "藥品", "北村": "飲水"},
        urgent=("東村", "西村"),
        crisis=dict(cap=5),                             # 落石砸中車輛
        # 北村確認井水可用後，淨水錠才會發放，並可滿足北村需求
        breakthrough=dict(kind="substitute", item="淨水錠", village="北村"),
        plan_route="藍", three_star_route="藍",
    ),
}


def available_items(seed, used_breakthrough):
    b = seed["breakthrough"]
    locked = b["item"] if b["kind"] == "substitute" and not used_breakthrough else None
    return [i for i in seed["weights"] if i != locked]


def stars(seed, route, cargo, crisis, used_breakthrough):
    """回傳 (星數, 原因)；星數 0 代表拒絕出發。"""
    travel, tool = seed["routes"][route]
    flood, cap = seed["flood"], seed["cap"]
    b = seed["breakthrough"]
    if crisis and "cap" in seed["crisis"]:
        cap = seed["crisis"]["cap"]
    if used_breakthrough and b["kind"] == "flood" and route == b["route"]:
        flood = b["value"]
    if any(c not in available_items(seed, used_breakthrough) for c in cargo):
        return 0, "物資尚未發放"
    if crisis and route == seed["crisis"].get("closed"):
        return 0, "道路封閉"
    if travel >= flood:
        return 0, "來不及"
    if tool and tool not in cargo:
        return 0, "缺少工具"
    if sum(seed["weights"][c] for c in cargo) > cap:
        return 0, "超重"
    served = [v for v, item in seed["needs"].items() if item in cargo]
    if (used_breakthrough and b["kind"] == "substitute"
            and b["item"] in cargo and b["village"] not in served):
        served.append(b["village"])
    if not served:
        return 0, "沒有任何村需要的物資"
    if len(served) == len(seed["needs"]):
        return 3, "三村"
    if all(v in served for v in seed["urgent"]):
        return 2, "兩個急迫村"
    return 1, "未滿足兩個急迫村"


def best(seed, crisis, used_breakthrough):
    items = available_items(seed, used_breakthrough)
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
    plan, win = seed["plan_route"], seed["three_star_route"]
    other = [r for r in REGULAR if r != plan][0]
    rules = [
        ("危機前：預定路線排得進三村", pre[plan][0] == 3),
        ("危機前：另一條常規路線最多二星", pre[other][0] <= 2),
        ("危機前：綠線不可行", pre["綠"][0] == 0),
        ("危機後、無突破口：最高二星", max(v[0] for v in post.values()) == 2),
        ("危機後：至少一條常規路線有二星解", max(post[r][0] for r in REGULAR) == 2),
        ("危機後＋突破口：指定路線三星", brk[win][0] == 3),
        ("三星只來自指定路線", all(brk[r][0] < 3 for r in brk if r != win)),
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
