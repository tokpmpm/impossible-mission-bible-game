# 不可能的任務｜Impossible Mission

> 手機只是工具，真正的冒險發生在人與人之間。

**專案狀態：第一關可執行原型（2026-11-14，分支 feat/mission-01-prototype）；只有自動測試，尚未真人試玩。**  
**目標玩家**：青少年與成人、教會小組、第一次接觸聖經的朋友。  
**設備**：每人一支手機，不用額外卡片與道具。

## 一句話玩法
3–10 人掃 QR Code 進入同一個房間，在約 8 分鐘的一局裡交換秘密情報、一起規劃救援、面對突發停電、靠合作修好設備，再找出隱藏三星解法。過程中認識隊友的個性，結尾透過哥林多前書 12:12–27 認識彼此需要的意義。

## v0.5 改進重點
- **危機真的打亂計畫**：兩條常規路線工具重量不同，危機前排得進三村的方案，危機後裝不下，必須重新取捨。
- **可以連玩兩局**：seed 001（封路→換路）與 seed 002（載重下降→替代物資）結構不同，關鍵職能也不同。
- **停電時人人有事做**：每位非工程師都持有符號或排除線索。
- **經文配上真實事件**：結尾把系統記錄到的事直接對應經節；感謝卡可用點選、不計票。

## v0.4 改進重點（仍適用）
- **破冰真的融入玩法**：可跳過的偏好題會變成非必要尋人線索；結尾分享本局新發現的隊友特點。
- **三次高潮，不一次塞滿**：討論策略 → 45 秒停電修復 → 整合突破口並重新決策。
- **危機有後果但不會無解**：危機後一定還有一條常規路線能拿二星。
- **有公平的星等**：二星必須完成急迫的藥品＋飲水需求；三星經分洪閘門與山路將三村物資一併送達。
- **3–10 人不能有人閒著**：7–10 人從原有職能拆出有實際作用的資訊與操作。
- **先測固定關卡，再擴充**：完整隨機化暫緩。

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
| [docs/02-MISSION_01_STORM_RESCUE.md](docs/02-MISSION_01_STORM_RESCUE.md) | 暴風雨救援 seed 001／002 可計算的解法與分星 |
| [docs/03-UX_UI.md](docs/03-UX_UI.md) | 手機 UX、停電畫面、入房與無障礙 |
| [docs/04-MVP_TECH.md](docs/04-MVP_TECH.md) | 技術方向（沿用前版，開發前需依 v0.4 審核） |
| [docs/05-BIBLE_INTEGRATION.md](docs/05-BIBLE_INTEGRATION.md) | 聖經內容與 60–90 秒收尾 |
| [docs/06-TEST_PLAN.md](docs/06-TEST_PLAN.md) | 28 項功能／邏輯案例與真人試玩 |
| [docs/07-BACKLOG.md](docs/07-BACKLOG.md) | P0／P1／P2 優先順序 |
| [docs/08-V0.4-REVIEW.md](docs/08-V0.4-REVIEW.md) | v0.4 設計審核重點與風險 |
| [docs/09-V0.5-REVIEW.md](docs/09-V0.5-REVIEW.md) | v0.5 改動、試算結果與待確認事項 |
| [tools/verify_seeds.py](tools/verify_seeds.py) | 窮舉試算兩個種子的可解性與分星 |
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

終端機會印出「手機（同一個 Wi-Fi）」的網址。主持人用手機或電腦打開它、建立房間，其他人掃大廳的 QR Code 加入；3–10 人到齊後由房主按開始。第一局是 seed 001，下一局自動換 seed 002。

- 自動測試：`npm test`（規則引擎、與 `tools/verify_seeds.py` 逐筆對照、多手機 WebSocket 整合測試）
- 型別檢查：`npm run typecheck`
- 伺服器重開會清掉所有房間；這只是區域網路原型（見 docs/adr/0004）。

## 下一步
先做 seed 001／002 的規則與自動測試，再做多人手機 Web App 原型，再找 3／6／10 人分別試玩，記錄每個人的參與、破冰效果、完成時間與是否想再玩。

此儲存庫的設計稿不等於遊戲已部署。