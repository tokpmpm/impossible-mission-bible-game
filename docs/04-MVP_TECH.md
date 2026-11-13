# MVP 技術規格（建議，尚未實作）

## 建議架構
- 手機前端：TypeScript + React／Next.js，Web App／PWA。
- 房間即時訊息：Supabase Realtime 或其他具伺服器權威的方案。
- 後端：負責身分／角色權限、狀態機、計時、危機發布、答案驗證。
- 部署：先本地測試，通過後可部署 Vercel 或相容平台取得測試網址。
- 不使用原生 App、實體卡片或額外硬體。

這是技術提案，不代表已選型或已經部署。

## 建議資料模型
- Room: id, joinCode, hostPlayerId, stage, stageStartedAt, version, scenarioSeed。
- Player: id, roomId, nickname, roles[]（3–5 人可兼任）, connected。
- RescueState: route, cargo[], powerRestored, bridgeCollapsed, resolved。
- Stage: lobby → briefing → planning → blackout → replanning → result。
- Role: navigation, supply, communications, engineering, medical, weather。

## 即時同步事件
- room.created / player.joined / player.reconnected
- room.started / plan.route_selected / plan.cargo_changed
- crisis.bridge_collapsed / crisis.blackout_started
- engineering.backup_submitted / crisis.power_restored
- rescue.final_submitted / rescue.succeeded / rescue.failed
- room.next_round

## 系統必須保障
1. 每房只有單一伺服器真實狀態；用 version 或交易防止並行更新覆蓋。
2. 重要操作角色權限由伺服器判定；不能只用隱藏 UI 按鈕。
3. 計時以伺服器時間為準；停電不是實際斷網，亦不能斷開即時連線。
4. 終局答案驗證在伺服器進行；不讓前端任意宣告通關。
5. 重複送出、快速點擊、斷線重連不應產生第二次結算或失去角色。
6. 使用暱稱即可，不需要真名、GPS、錄音或額外個資；房間有有效期限。
7. 客戶端可安全地在短暫背景／恢復後重新取得最新房間狀態。

## 最小里程碑
1. 先做單機狀態機、重量／路線邏輯、事件及結果的自動化測試。
2. 建立房間、QR Code、3–10 人加入與主持人控制。
3. 各角色不同情報及可操作功能。
4. 整房同步停電和恢復、備援解鎖。
5. 結局／聖經反思／下一局。
6. 3、6、10 人實機、真實網路斷線重連測試。

## 不應提前做
- 付費商城、每日登入、排行榜。
- 未審核經文的 AI 自動生成。
- 大量關卡或複雜 NPC，卻沒有第一關真正好玩的驗證。
