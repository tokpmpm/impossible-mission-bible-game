# MVP 技術規格建議 v0.4（未開發）

## 建議架構
手機 Web App（TypeScript + React／Next.js，PWA 可選）＋具伺服器權威狀態的即時同步（如 Supabase Realtime）＋後端規則驗證。框架可調整，重要的是 3–10 人同步、正確判定及重連。沒有原生 App、印刷卡或額外硬體。

## 資料模型（概念）
- Room：id、joinCode、hostId、phase、startedAt、phaseStartedAt、roundNo、scenarioId、revision、isSettled。
- Player：id、roomId、nickname、roleIds[]、connected、optionalPreference（可空、房內短期使用）。
- SharedPlan：route、cargoIds[]、totalWeight、villageNeedsCovered[]、planLocked。
- Crisis：blockedRoute（依鎖定的紅／藍路線）、powerOff、repairPlayerIds[]、repairSymbols[]、repairProgress、assistAvailable。
- WorldRules：routeTravelMinutes、floodWindowMinutes、floodGateActivated、toolWeight、cargoCapacity；**故事世界的分鐘**與房間倒數 milliseconds **完全分開**。
- ContributionEvents：有限事件紀錄（不推論人格、不公開排行），例如「玩家提交符號」或「另一玩家交換情報」；人際行為不可只靠點擊推斷。

## 主要階段
lobby → introduction → planning → single_crisis_repair → replanning → settled。
- 進房到 host 開始之間不計時；開始後服務端保有 8 分鐘目標時限。
- 初步鎖定只允許可行的紅／藍常規路線。危機依選擇封閉該線，同時停電；保留另一條常規二星解。
- 危機時只開一項三符號修復，三位隊友有線索，工程師有選擇面板。45 秒後進入可協助模式，不能硬卡死。
- 電力恢復後才允許啟動分洪閘門授權、更新路線與裝載。
- 最終由伺服器判定是否合法，再依急迫需求與三村送達情形給 ★／★★／★★★。

## 同步事件（示例）
room.created, player.joined, player.reconnected, room.started, player.role_assigned, plan.updated, plan.locked, crisis.started, repair.symbol_submitted, repair.assist_enabled, crisis.power_restored, floodgate.activated, rescue.submit_requested, rescue.settled, room.next_round。

## 後端規則必須保證
1. 房間狀態單一來源、版本或交易比較更新，不讓並行提交競爭。
2. 只有指定職能擁有特定操作入口，但所有人都可看、可提出建議；不可把真實交流當權限檢查。
3. 符號分派、隊友偏好、提示均由服務端產生；偏好可跳過／相同選項／離線，必需線索不能遺失。
4. 路線封閉、故事安全窗、載重、工具、村莊優先級都在伺服器驗證；不能讓前端直接宣布三星。
5. 同局危機只觸發一次、結算一次；斷線重連能回到正確階段，host 離線可恢復或移交。
6. 遊戲只需暱稱。避免收集 GPS、真名、錄音；房間與偏好資料設短期有效期限；以最低必要權限儲存。
7. 課程／聖經內容需人工審核與合理譯本使用。

## MVP 開發順序
1. seed 001 規則與 F04–F15 自動化測試。
2. 房間與角色分配、6 人同步與手機畫面。
3. 3、4–5、7–10 人職能拆分及同步測試。
4. 真實 3、6、10 人場測、時間與參與觀察、斷線處理。
5. 人工加入兩個已驗證變體後，再評估完整隨機生成器。

無現場實測不能宣稱「已驗證好玩」。完整規格以 01、02、06 文件為準。