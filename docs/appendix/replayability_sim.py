#!/usr/bin/env python3
"""docs/12-REPLAYABILITY.md 的試算腳本（設計提案用，**不是**正式規則，也不是遊戲測試）。

用法：python3 docs/appendix/replayability_sim.py            # 診斷現況＋推薦方案的窮舉與重玩性指標
      python3 docs/appendix/replayability_sim.py --table    # 另外列出每一種通過的「起風卡×見聞」與可搭配的風暴卡

第一部分沿用 tools/verify_seeds.py（不修改它）量化現行 ship 001。
第二部分是推薦方案「今晚靠哪一樣」的規則模型：
- 風暴捲走：危機前丟下海的東西，危機一來就撈不回來。
- 見聞（每局不同、各在一支手機上）：食＝今晚力氣靠糧食還是麥子；繩＝船身靠纜索、器具還是小船的繩子；
  水＝淺（可以拋錨）或深（錨要帶到上岸）；胃＝吃得下或吃不下（吃不下就不能吃飯，食物要帶上岸）。
- 補好船後三種「用掉」：吃飯／捆船底／拋錨（東西離船、那件事顧好），天亮前只來得及做 N 件（N=1）。
- 星等不變：三件事顧好幾件；最後留在船上的總重 ≤ 危機後載重。
若採用，正式做法是把這些規則搬進 tools/verify_seeds.py 再改引擎（ADR-0002／0006）。
"""
import os, sys

from itertools import combinations, product
from collections import Counter
ITEMS=["糧食","纜索","錨","麥子","器具","小船"]
CARDS={
 "A1":dict(pin=["麥子"]), "A2":{}, "A3":dict(weight={"糧食":-1}), "A4":dict(remove=["纜索"],done=["船身"]), "A5":{},
 "B1":dict(remove=["器具"],weight={"麥子":-2}), "B2":dict(remove=["小船"]), "B3":dict(weight={"糧食":2}), "B4":{}, "B5":dict(remove=["錨"],done=["天亮"],eat_only=True),
}
AS=["A1","A2","A3","A4","A5"]; BS=["B1","B2","B3","B4","B5"]
DIALS=dict(食=["糧食","麥子"],繩=["纜索","器具","小船"],水=["淺","深"],胃=["吃得下","吃不下"])
ACTS={"吃飯":"力氣","捆船底":"船身","拋錨":"天亮"}
def subsets(xs):
    xs=sorted(xs)
    for n in range(len(xs)+1):
        for c in combinations(xs,n): yield frozenset(c)
def prov(dv): return {"力氣":dv["食"],"船身":dv["繩"],"天亮":"錨"}
def weights(G,cards):
    w=dict(G["w"])
    for c in cards:
        for k,d in CARDS[c].get("weight",{}).items(): w[k]=max(0,w[k]+d)
    return w
def p1sets(G,A,dv):
    w=weights(G,[A]); ca=CARDS[A]
    items=[i for i in ITEMS if i not in ca.get("remove",[])]
    pin=set(ca.get("pin",[]))
    return [K for K in subsets(items) if pin<=K and sum(w[i] for i in K)<=G["cp"]]
def can(a,dv,B):
    if a=="拋錨" and dv["水"]=="深": return False
    if a=="吃飯" and dv["胃"]=="吃不下": return False
    return True
def p2(G,A,dv,B,K1,lines=False):
    w=weights(G,[A,B]); cb=CARDS[B]; pv=prov(dv)
    aboard=set(K1)-set(cb.get("remove",[]))
    done0=set(CARDS[A].get("done",[]))|set(cb.get("done",[]))
    eat_only=cb.get("eat_only",False)
    av=[a for a,nd in ACTS.items() if pv[nd] in aboard and nd not in done0 and can(a,dv,B)]
    best=-1; out=[]
    for n in range(0,G["N"]+1):
        for acts in combinations(av,n):
            used={pv[ACTS[a]] for a in acts}; done=done0|{ACTS[a] for a in acts}
            for K2 in subsets((aboard-used)&set(pv.values())):
                if sum(w[i] for i in K2)>G["cq"]: continue
                s=sum(1 for nd,it in pv.items() if nd in done or (it in K2 and not(nd=="力氣" and eat_only)))
                if s>best: best=s; out=[]
                if s==best and lines: out.append((frozenset(acts),K2))
    return (best,out) if lines else best
def story_ok(A,dv,B):
    if A=="A4" and dv["繩"]!="纜索": return False       # 船底已捆好：繩的見聞沒有意義，只留一種避免重複計算
    if B=="B5" and dv["胃"]=="吃不下": return False       # B5 說大家餓壞了要真的吃，和「吃不下」衝突
    return True
def build(G,minB=3):
    valid={}; allT={}
    for A in AS:
        for vals in product(*DIALS.values()):
            dv=dict(zip(DIALS,vals))
            if not story_ok(A,dv,"B4"): continue
            res={K1:[p2(G,A,dv,B,K1) for B in BS] for K1 in p1sets(G,A,dv)}
            allT[(A,vals)]=res
            allowed=[i for i in range(5) if story_ok(A,dv,BS[i])]
            bestS=None
            for n in range(len(allowed),minB-1,-1):
                for S in combinations(allowed,n):
                    if any(all(r[i]==3 for i in S) for r in res.values()): bestS=S; break
                if bestS: break
            if bestS: valid[(A,vals)]=(bestS,res)
    return valid,allT
def run_line(G,A,dv,B,line):
    K1,acts,K2=line
    w1=weights(G,[A]); ca=CARDS[A]
    items=[i for i in ITEMS if i not in ca.get("remove",[])]
    K=(set(K1)&set(items))|set(ca.get("pin",[]))
    if sum(w1[i] for i in K)>G["cp"]: return 0
    w=weights(G,[A,B]); cb=CARDS[B]; pv=prov(dv)
    aboard=K-set(cb.get("remove",[])); done=set(ca.get("done",[]))|set(cb.get("done",[]))
    n=0
    for a in sorted(acts):
        nd=ACTS[a]
        if n<G["N"] and pv[nd] in aboard and nd not in done and can(a,dv,B):
            aboard.discard(pv[nd]); done.add(nd); n+=1
    keep=aboard&set(K2)
    if sum(w[i] for i in keep)>G["cq"]: return 0
    return sum(1 for nd,it in pv.items() if nd in done or (it in keep and not(nd=="力氣" and cb.get("eat_only"))))
def report(G,verbose=True):
    valid,allT=build(G)
    games=[(A,vals,BS[i]) for (A,vals),(S,res) in valid.items() for i in S]
    n=len(games)
    L={}
    for (A,vals,B) in games:
        dv=dict(zip(DIALS,vals)); ls=set()
        for K1 in valid[(A,vals)][1]:
            s,l2=p2(G,A,dv,B,K1,lines=True)
            if s==3: ls|={(K1,a,k) for a,k in l2}
        L[(A,vals,B)]=ls
    alllines=set().union(*L.values())
    succ={l:frozenset(g for g in games if run_line(G,g[0],dict(zip(DIALS,g[1])),g[2],l)==3) for l in alllines}
    bestline=max(alllines,key=lambda l:len(succ[l]))
    copy_best=sum(len(set().union(*[succ[l] for l in L[g]])-{g}) for g in games)/(n*(n-1))
    copy_avg=sum(sum(len(succ[l]-{g}) for l in L[g])/len(L[g]) for g in games)/(n*(n-1))
    # 盲選：只看起風卡、不問見聞，風暴前帶同一組東西；之後照最佳走
    num=0
    blindK={}
    for A in AS:
        ks=[k for k in valid if k[0]==A]
        if not ks: continue
        allK=set().union(*[set(valid[k][1]) for k in ks])
        sc={K:sum(sum(1 for i in valid[k][0] if valid[k][1].get(K,[0]*5)[i]==3) for k in ks) for K in allK}
        K=max(sc,key=sc.get); num+=sc[K]; blindK[A]=(K,sc[K],sum(len(valid[k][0]) for k in ks))
    sig=Counter()
    for k,(S,res) in valid.items():
        rob=[K for K,r in res.items() if all(r[i]==3 for i in S)]
        sig[frozenset(K for K in rob if not any(o<K for o in rob))]+=1
    two=all(any(all(r[i]>=2 for i in valid[k][0]) for r in valid[k][1].values()) for k in valid)
    r=dict(n_cfg=len(valid),n_all=len(allT),n_games=n,blind=num/n,copy_best=copy_best,copy_avg=copy_avg,fixed=len(succ[bestline])/n,nsig=len(sig),two=two)
    if verbose:
        print({k:(round(v,3) if isinstance(v,float) else v) for k,v in r.items()})
        print("  最強固定打法:",'+'.join(sorted(bestline[0])),"|",'+'.join(sorted(bestline[1])),"|",'+'.join(sorted(bestline[2])))
    return r,valid,games,L,succ,blindK,sig
# 推薦數值（提案）：糧食 3、麥子 3、纜索 2、器具 2、小船 2、錨 3；載重 起風 8 → 危機後 5；只來得及做 1 件。
G_PROPOSED = dict(w={"糧食": 3, "纜索": 2, "錨": 3, "麥子": 3, "器具": 2, "小船": 2}, cp=8, cq=5, N=1)


def diagnose_current():
    """現行 ship 001（tools/verify_seeds.py）的固定打法有多強。"""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
    import verify_seeds as v
    if not hasattr(v, "combos"):
        # 2026-11-16 起 tools/verify_seeds.py 已換成本方案的正式規則；現況（v0.7）診斷請在 commit 992a8e2 執行本腳本。
        print("== 一、現況：tools/verify_seeds.py 已改為本方案（見 git commit 992a8e2 的舊版診斷），略過")
        return
    seed = v.SEEDS["ship 001"]
    decoys = ("麥子", "器具", "小船")
    print("== 一、現況（ship 001，25 種故事卡組合）")
    for label, (crisis, fed) in {"危機前": (False, False), "危機後未吃飯": (True, False), "吃飯後": (True, True)}.items():
        cnt = Counter()
        for cards in v.combos():
            s, _ = v.best(seed, cards, crisis, fed)
            a = v.answers(seed, cards, crisis, fed, s)
            cnt[frozenset(k for k in a if not any(set(o) < set(k) for o in a))] += 1
        print(f"  {label}：最省的最佳留法共 {len(cnt)} 種；" + "、".join(
            f"{'／'.join('+'.join(x) or '（空）' for x in sorted(k))}×{n}" for k, n in cnt.most_common()))
    pre = fin = 0
    for cards in v.combos():
        w, items, done, pinned, cap, eo = v.world(seed, cards, False, False)
        kept = [i for i in items if i not in decoys or i in pinned]
        s, r = v.evaluate(seed, kept, w, done, cap, eo)
        pre += (r is None and s == v.best(seed, cards, False, False)[0])
        w, items, done, pinned, cap, eo = v.world(seed, cards, True, True)
        kept = [i for i in items if i not in decoys]
        s, r = v.evaluate(seed, kept, w, done, cap, eo)
        fin += (r is None and s == 3)
    print(f"  固定打法「麥子、器具、小船丟掉，其餘全留，補好船就吃飯」：危機前是最佳 {pre}/25；結局三星 {fin}/25")
    print("  麥子在 25/25 局都沒有用處；吃飯在 25/25 局都是拿三星的唯一途徑；每局需要向隊友問的新資訊：0 件（卡片全隊公開）")


def diagnose_proposed(G, show_table=False):
    print("\n== 二、推薦方案「今晚靠哪一樣」")
    print(f"  數值：{G['w']}；載重 {G['cp']}→{G['cq']}；天亮前只來得及用掉 {G['N']} 件")
    r, valid, games, L, succ, blindK, sig = report(G, verbose=False)
    n = len(games)
    print(f"  起風卡×見聞共 {r['n_all']} 種，其中 {r['n_cfg']} 種通過"
          f"（存在一種帶法，不管翻到哪張可搭配的風暴卡都能三星，且可搭配的風暴卡 ≥3 張）；合計 {n} 種局面")
    print(f"  每種通過的局面：三星有解 {sum(1 for g in games if L[g])}/{n}；"
          f"每種起風卡×見聞都有『不管哪張風暴卡都至少二星』的帶法：{r['two']}")
    print("  -- 重玩性指標")
    print(f"  照抄成功率（把上一局最有利的三星打法原封不動搬到下一局，仍然三星的機率）：{r['copy_best']:.1%}")
    print(f"  　同上，但上一局的三星打法隨機挑一個：{r['copy_avg']:.1%}")
    bl = max(succ, key=lambda l: len(succ[l]))
    print(f"  最強固定打法命中率：{r['fixed']:.1%}（{'+'.join(sorted(bl[0]))}｜{'+'.join(sorted(bl[1]))}｜{'+'.join(sorted(bl[2]))}）")
    print(f"  不問隊友（只看公開的起風卡決定風暴前帶什麼，之後都走最佳）的三星率：{r['blind']:.1%}")
    print(f"  風暴前『最省的必帶組合』共 {r['nsig']} 種")
    # 各樣東西的命運
    need_through = Counter(); acts = Counter()
    for g in games:
        A, vals, B = g
        common = frozenset.intersection(*[frozenset(l[0]) for l in L[g]])
        for i in common: need_through[i] += 1
        aset = {l[1] for l in L[g]}
        for a in ACTS:
            if all(a in x for x in aset): acts["一定要" + a] += 1
            elif any(a in x for x in aset): acts["可以" + a] += 1
        if all(not x for x in aset): acts["什麼都不用做"] += 1
    print("  每樣東西『風暴前一定要留』的局面比例：" + "、".join(f"{i} {need_through[i]/n:.0%}" for i in ITEMS))
    print("  補好船後：" + "、".join(f"{k} {c/n:.0%}" for k, c in sorted(acts.items())))
    # 每個見聞少問了會怎樣
    print("  -- 少問一個人（其他都知道，只有這個見聞不知道）會不會沒有保險打法")
    names = list(DIALS)
    for di, d in enumerate(names):
        need = tot = 0
        for g in games:
            A, vals, B = g
            sib = [h for h in games if h[0] == A and h[2] == B and all(h[1][j] == vals[j] for j in range(len(names)) if j != di)]
            if len(sib) < 2: continue
            tot += 1
            if not frozenset.intersection(*[frozenset(L[h]) for h in sib]): need += 1
        print(f"  {d}：有其他可能的 {tot} 個局面中，{need} 個（{need/max(1,tot):.0%}）沒有『兩邊都通』的打法"
              + ("（一定要問）" if need else "（單獨不知道時還有保險打法；它決定的是補好船後該誰動手）"))
    print("  -- 各起風卡")
    for A in AS:
        ks = [k for k in valid if k[0] == A]
        K, hit, tot = blindK[A]
        print(f"  {A}：{len(ks)} 種見聞通過、{tot} 個局面；不問見聞的最佳帶法 {'+'.join(sorted(K))} 三星率 {hit/tot:.0%}")
    if show_table:
        print("  -- 通過的組合（食/繩/水/胃｜可搭配的風暴卡｜風暴前最省的必帶組合）")
        for (A, vals), (S, res) in valid.items():
            rob = [K for K, rr in res.items() if all(rr[i] == 3 for i in S)]
            mins = [K for K in rob if not any(o < K for o in rob)]
            print(f"  {A} {'/'.join(vals)}｜{''.join(BS[i] for i in S)}｜{'、'.join('+'.join(sorted(K)) for K in mins)}")
    ok = r["two"] and all(L[g] for g in games) and r["copy_best"] < 0.20
    print(f"\n  驗收：全部有三星解、二星保底、照抄成功率 < 20% → {'通過' if ok else '失敗'}")
    return ok


if __name__ == "__main__":
    diagnose_current()
    raise SystemExit(0 if diagnose_proposed(G_PROPOSED, "--table" in sys.argv) else 1)
