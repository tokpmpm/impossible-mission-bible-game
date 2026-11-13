# AI 協作者／Codex 開發守則（v0.5）

本專案正在設計《不可能的任務》多人手機合作破冰遊戲；**v0.5 是設計提案，數值尚未實測，不得當作已實作或已驗證好玩。**

## 開始前閱讀
1. README.md
2. DECISIONS.md（先區分使用者已確定事項與設計提案）
3. docs/01-GAME_DESIGN.md
4. docs/02-MISSION_01_STORM_RESCUE.md
5. docs/06-TEST_PLAN.md
6. docs/09-V0.5-REVIEW.md

## 不得違反
- 每人一支手機、無額外道具；3–10 人、每局 5–10 分鐘。
- 可以互看手機、說話、分享線索；不能靠主持人監督不合理禁令。
- 手機「停電」為遊戲畫面遮罩；工程備援功能可用。
- 核心是面對面互動和團隊決策，不是題目問答或無意義的雙重按同意。
- 結尾聖經不製造非信徒壓力，不把人物行為換算信仰高低。
- 禁止聲稱已部署／已實測，除非有真實證據。

## 開發優先
1. 先做 seed 001 與 seed 002 固定關卡，規則結果須與 `tools/verify_seeds.py` 的試算一致；新增種子前先加入該腳本並通過。
2. 停電時只做 45–60 秒單一描述型修復，每位非工程師都持有符號或排除線索；逾時給協助，不讓新人被卡死。
3. 根據 3／6／10 人確認每一個職能都有有效線索或操作，完整多人同步、斷線重連、防重複提交。
4. 玩家偏好可跳過，不得成為必要通關障礙；破冰交流由真人試玩驗證。
5. 改動時同步更新 docs/06-TEST_PLAN.md 及測試結果；若發現計算不一致先修規格。
6. 不提前做完整隨機產生器、跨面板多事件、受困黑屏、排行榜、付費等擴充。

## 專案驗收
可用真實多支手機加入、互動、通關、重新開始，且有 3／6／10 人的現場試玩紀錄。沒有實證就明確標「未測試」。
## Agent skills

### Issue tracker

Issues 與規格放在本 repo 的 GitHub Issues（`tokpmpm/impossible-mission-bible-game`），用 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

使用預設五個標籤：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：repo 根目錄一份 `GLOSSARY.md`，決策紀錄放 `docs/adr/`（尚未建立，由 `/grill-with-docs` 需要時再建立）。現有的 `DECISIONS.md` 仍是使用者約束的最高依據。See `docs/agents/domain.md`.

Skills 本身放在 `.claude/skills/`（複製自 mattpocock/skills）。
