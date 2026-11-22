# 連線加強：心跳逾時、多數斷線暫停、房間存檔

Status: accepted（2026-11-22 使用者決定，DECISIONS 19；實作細節由 AI 決定，只有模擬測試，未經真機測試）

## 背景
使用者回報「實際在不同手機上玩時很容易斷線」。docs/16-CONNECTION-REPORT.md 用 wrangler dev＋Playwright＋可控 TCP 代理重現了三個主因：
1. 網路換手後的「假連線」雙方都偵測不到（90 秒內沒提示、按的東西遺失、職能不轉交）。
2. 伺服器重啟／部署＝所有房間消失，畫面卡在舊局。
3. 連線卡在「連線中」沒有逾時（iOS 回前景的已知問題）。

## 決定
1. **雙向心跳逾時**：手機每 10 秒 ping；手機 25 秒沒收到任何訊息就放掉這條連線（不等關閉握手）並立刻重連；伺服器 `Conn.lastSeen` 超過 45 秒就呼叫 `Conn.close()` 並當作斷線（`Hub.reapStale`，在 tick 裡跑）。45 秒涵蓋 Android 背景每分鐘才跑一次計時器以外的情況；誤判的代價只是一次重連，回來後工作自動還給原負責人。
2. **連線逾時與回前景檢查**：6 秒沒接通就放棄重來（不加退避）；`visibilitychange`／`online`／`focus`／`pageshow(persisted)`／`resume` 時，沒連著就立刻重連，連著但 15 秒沒動靜就送 ping 試探、3 秒沒回應就換新連線。每條連線有流水號，舊連線晚到的事件忽略。
3. **所有會改變狀態的訊息都可靠送達**：`pref`／`start`／`next`／`vote`／`thank`／`submitScore` 帶 `mid`，伺服器去重（與 act 共用每人最近 300 個代號）並一律回 `ack`；手機沒收到 ack 就在重連後重送。`resume` 成功後才補送，免得被當成「還沒加入房間」。
4. **房間不見有代碼**：`error.code = 'ROOM_GONE'`；手機不論在哪個畫面都清掉 session、顯示「這一局中斷了，不是你的問題」。
5. **多數斷線暫停**（DECISIONS 19）：`Room.pausedAt`；這局沒離開的隊員裡離線 × 2 ≥ 人數就暫停。暫停時 `elapsed()` 停在暫停那一刻（倒數、表決、捲走、補船都停）、遊戲動作回 `PAUSED`；恢復時把 `round.startedAt` 往後挪暫停的長度，所有局內時間都接得上，不必改引擎。畫面用 `view.paused.at` 凍結倒數。
6. **房間存檔**：`Room.serialize()`／`Room.restore()`（JSON；Map 存成 `{$m: [...]}`）。`Hub` 收到訊息、tick 有變化、斷線時把房間標成要存，最多每秒寫一次；最後一人斷線、Node 關機時立刻寫。Cloudflare 存在 GameHub 的 SQLite `rooms` 表（和排行榜同一個資料庫，ADR-0008）；建構時讀回、所有人算離線。存檔有 `savedAt`：讀回時若這局沒在暫停，從 `savedAt` 開始算暫停，伺服器重啟的時間不吃掉倒數。Node 本機版預設不存（測試用 `MemoryRoomStore` 模擬重啟）。
7. **延後換版**：`wrangler.toml` 設 `code_update_strategy = deferred, max_delay = 1800`。標準 WebSocket 無法休眠，所以有人連著時物件一定在 30 分鐘內重置；有存檔後，重置只是一次重連加短暫暫停。

## Considered Options
- **Hibernation WebSocket API**：部署後連線可以不斷，也比較省錢；但遊戲進行中有 250ms tick，物件本來就不會休眠，對「玩到一半部署」幫助有限，要改 tick 為 alarm。有存檔後不急，之後再評估。
- **每房一個 Durable Object**（ADR-0005 已評估）：一次重啟只影響一房；有存檔後全滅的影響已大幅降低，量不大時不值得。
- **暫停門檻用「有人斷線就暫停」**：一人斷線就卡住全隊，違反「不讓新人被卡死」；現有的操作轉交已能處理單人斷線。

## Consequences
- 舊版手機（沒有 mid）仍可用：沒帶 mid 的訊息照舊處理。
- 存檔格式有版本號 `v: 1`；讀不懂的存檔會被丟掉（房間消失，手機看到 ROOM_GONE 說明頁）。新增 Room 欄位時要同步 `serialize()`／`restore()`，`test/connection.test.ts` 的往返測試會抓到畫面不同。
- 測試用的 seed 亂數狀態不存（正式遊戲用 Math.random，不受影響）。
- 所有數字（10／25／45 秒、6 秒、一半）未經真機調整。
