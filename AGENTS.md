# AI 協作者／Codex 開發守則（v0.5）

本專案正在設計《不可能的任務》多人手機合作破冰遊戲；**v0.5 是設計提案，數值尚未實測，不得當作已實作或已驗證好玩。**

## 開始前閱讀
1. README.md
2. DECISIONS.md（先區分使用者已確定事項與設計提案）
3. docs/01-GAME_DESIGN.md
4. docs/11-MISSION_01_SHIPWRECK.md（第一關保羅海難；docs/02 暴風雨救援已退役）
5. docs/06-TEST_PLAN.md
6. docs/09-V0.5-REVIEW.md
7. docs/13-SCORING.md（團隊計分與排行榜；試行、未經真人試玩）
8. docs/14-LOGIC-REVIEW.md（故事邏輯審查；2026-11-20 失敗結局、力氣靠吃飯、全員同意）
9. docs/16-CONNECTION-REPORT.md（連線驗證與加強；2026-11-22 多數斷線暫停、房間存檔）

## 不得違反
- 每人一支手機、無額外道具；3–10 人、每局 5–10 分鐘。
- 可以互看手機、說話、分享線索；不能靠主持人監督不合理禁令。
- 手機「停電」為遊戲畫面遮罩；工程備援功能可用。
- 核心是面對面互動和團隊決策，不是題目問答或無意義的雙重按同意。例外（DECISIONS 18）：決定好了、用掉、衝向海灘要全員同意，不同意要選理由，2 次沒通過可強制，10 秒沒回應算同意。
- 結尾聖經不製造非信徒壓力，不把人物行為換算信仰高低。
- 聖經故事關卡不改寫經文結局、不讓玩家操作神蹟；故事卡是「故事裡發生的事」，不是抽籤算命。遊戲可以失敗（2026-11-20 DECISIONS 18）：寫成「這一局沒能平安上岸」，不畫不寫有人死亡，並一定寫明經文裡 276 人都上了岸。
- 不是自己能操作的按鈕不顯示（2026-11-15 使用者決定）；資訊仍可互看。
- 禁止聲稱已部署／已實測，除非有真實證據。

## 開發優先
1. 第一關為 `ship 001`（保羅海難）＋故事卡，規則結果須與 `tools/verify_seeds.py` 的試算一致；新增種子或故事卡前先加入該腳本並對所有組合通過。
2. 停電時只做 45–60 秒單一描述型修復，每位非工程師都持有符號或排除線索；逾時給協助，不讓新人被卡死。
3. 根據 3／6／10 人確認每一個職能都有有效線索或操作，完整多人同步、斷線重連、防重複提交。
4. 玩家偏好可跳過，不得成為必要通關障礙；破冰交流由真人試玩驗證。
5. 改動時同步更新 docs/06-TEST_PLAN.md 及測試結果；若發現計算不一致先修規格。
6. 不提前做完整隨機產生器、跨面板多事件、受困黑屏、付費等擴充；團隊排行榜已由使用者於 2026-11-16 要求（DECISIONS 17），計分標「試行」、未經真人試玩。

## 開發流程
- **寫程式的 agent 和審查的 agent 必須不同**（2026-11-27 使用者決定，DECISIONS 20）：實作者不審查自己的 PR；由另一個獨立的審查 session 審每個 PR，並把意見傳給實作者。實作者逐條處理（修正或在 PR 回覆理由）後 push。實作者開的子代理同理：寫程式的子代理不審自己的成果。
- 每個 PR 前跑：`python3 tools/verify_seeds.py`、`python3 tools/verify_verses.py`、`npm test`、`npm run typecheck`、`npm run e2e`（3／6／10 人兩局）。

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
