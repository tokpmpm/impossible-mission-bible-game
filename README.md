# 不可能的任務｜Impossible Mission

> 手機只是工具，真正的冒險發生在人與人之間。

**專案狀態：第一關「保羅海難」可執行原型（2026-11-15，分支 feat/mission-01-shipwreck）；只有自動測試與 AI 模擬審查，尚未真人試玩。經文尚未逐字核對（見 docs/05）。**
**目標玩家**：青少年與成人、教會小組、第一次接觸聖經的朋友。
**設備**：每人一支手機，不用額外卡片與道具。

## 一句話玩法
3–10 人掃 QR Code 上同一條船——使徒行傳 27 章保羅搭的那艘運糧船。約 8 分鐘裡，大家交換手上的情報，決定風暴中**丟什麼、留什麼**；天黑時一起形容記號幫木匠補船；第十四天夜裡想通「先吃飯，船就輕了」，天亮時衝向海灘。經文裡 276 人全都得救，遊戲也一樣；星星衡量的是上岸順不順。每局抽兩張「故事卡」（這章真的發生的事），讓同一關重玩也不一樣。

## v0.7 改進重點（2026-11-15 使用者決定）
- **聖經故事就是關卡**：第一關改編保羅海難（徒 27），取代原創暴風雨救援；拿掉「老智慧」。
- **故事卡**：起風卡、風暴卡各 5 張，都是經文裡的事件＋「所以這局……」，不是抽籤算命；25 種組合都經 `tools/verify_seeds.py` 試算可解。
- **不是你能按的，不顯示**：托盤只在管倉、「決定好了／衝向海灘」只在船長、「召集大家吃飯」只在伙房。資訊仍可互看。
- **圖代替字、能動就動**：船在浪中搖、東西拋進海裡、天色變暗、擘餅、擱淺上岸都是 SVG＋CSS 動畫（尊重 prefers-reduced-motion）。

## 已確定的原則
1. 現場真人討論、協調、交換手機觀看資訊；不能限制說話或觀看隊友畫面。
2. 手機顯示地圖、物資、倒數、突發事件與修復機關；停電只是遊戲內的 UI 遮罩。
3. 入房不計時、每局 5–10 分鐘；結束能接下一局。不強迫站立或分享隱私。
4. 聖經連結是自然引導，不是測驗，不用「信仰分數」評價人。

## 文件索引
| 路徑 | 內容 |
|---|---|
| [DECISIONS.md](DECISIONS.md) | 使用者已確定約束與各版設計決策 |
| [docs/01-GAME_DESIGN.md](docs/01-GAME_DESIGN.md) | 目標、破冰機制、3–10 人分工 |
| [docs/11-MISSION_01_SHIPWRECK.md](docs/11-MISSION_01_SHIPWRECK.md) | 第一關保羅海難：規則、數值、職能與線索、故事卡、經文清單 |
| [docs/02-MISSION_01_STORM_RESCUE.md](docs/02-MISSION_01_STORM_RESCUE.md) | （已退役）暴風雨救援 seed 001／002 |
| [docs/03-UX_UI.md](docs/03-UX_UI.md) | 手機 UX、停電畫面、入房與無障礙 |
| [docs/04-MVP_TECH.md](docs/04-MVP_TECH.md) | 技術方向（沿用前版，開發前需依 v0.4 審核） |
| [docs/05-BIBLE_INTEGRATION.md](docs/05-BIBLE_INTEGRATION.md) | 聖經故事怎麼融入、經文核對狀態 |
| [docs/06-TEST_PLAN.md](docs/06-TEST_PLAN.md) | 28 項功能／邏輯案例與真人試玩 |
| [docs/07-BACKLOG.md](docs/07-BACKLOG.md) | P0／P1／P2 優先順序 |
| [docs/08-V0.4-REVIEW.md](docs/08-V0.4-REVIEW.md) | v0.4 設計審核重點與風險 |
| [docs/09-V0.5-REVIEW.md](docs/09-V0.5-REVIEW.md) | v0.5 改動、試算結果與待確認事項 |
| [tools/verify_seeds.py](tools/verify_seeds.py) | 窮舉試算保羅海難所有故事卡組合的可解性與分星 |
| [AGENTS.md](AGENTS.md) | Codex 等後續開發者工作準則 |

## 部署到網路（Cloudflare，任何網路都能玩）
目前網址：https://impossible-mission.next-calendar.workers.dev （2026-11-14 部署；只有模擬手機測過，未經真人試玩）

需要 Cloudflare 帳號。部署後會得到 `https://impossible-mission.<你的子網域>.workers.dev`，手機用行動網路掃 QR Code 就能加入（docs/adr/0005）。

```bash
npx wrangler deploy
```

第一次會要求登入或設定 `CLOUDFLARE_API_TOKEN`（Edit Cloudflare Workers 權限）。本機模擬 Cloudflare：`npm run dev:worker`。

## 在現場跑原型（未經真人試玩）
不想部署時的替代做法：需要 Node.js 22.18 以上，以及一台和手機連到**同一個 Wi-Fi** 的電腦。

```bash
npm install
npm start
```

終端機會印出「手機（同一個 Wi-Fi）」的網址。主持人用手機或電腦打開它、建立房間，其他人掃大廳的 QR Code 加入；3–10 人到齊後由房主按「開船！」。每局會抽新的故事卡。

- 自動測試：`npm test`（規則引擎、與 `tools/verify_seeds.py` 逐筆對照、多手機 WebSocket 整合測試）
- 型別檢查：`npm run typecheck`
- 伺服器重開會清掉所有房間；這只是區域網路原型（見 docs/adr/0004）。

## 下一步
找 3／6／10 人分別試玩保羅海難（各至少兩局，看故事卡是否讓重玩不同），記錄每個人的參與、破冰效果、完成時間與是否想再玩；並請懂聖經的同工逐字核對經文。

此儲存庫的設計稿不等於遊戲已部署。