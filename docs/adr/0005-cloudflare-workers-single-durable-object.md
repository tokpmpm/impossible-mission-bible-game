# 部署到 Cloudflare Workers，所有房間放在同一個 Durable Object

Status: accepted（2026-11-14，使用者選擇 Cloudflare）；取代 ADR-0004 的「只在區域網路」部分

破冰現場的手機通常不在同一個 Wi-Fi，所以遊戲要有公開網址。伺服器邏輯抽成與平台無關的 `Hub`，Node 版（本機）與 Cloudflare 版共用。Cloudflare 上，靜態畫面由 Workers Assets 供應，`/ws` 全部轉進**同一個**名為 `global` 的 Durable Object，裡面就是原本的 Hub。

為什麼只用一個：手機端協定完全不用改（建立／加入／重連都在同一條連線上），前端零修改。教會小組的量（每房 3–10 人、每秒幾則訊息）一個物件綽綽有餘。

## Considered Options
- 每個房間一個 Durable Object：擴充性較好，但建立房間要先拿房號再連線，前端與重連流程都要改。量真的變大再換。
- Render 等一般 Node 主機：免費方案會休眠，第一個人要等 30–60 秒。

## Consequences
- 房間狀態只在記憶體：所有人都離線一段時間後物件可能被回收，房間消失；Cloudflare 更新部署時，進行中的房間也會中斷。
- 免費方案的 Durable Object 必須是 SQLite 型（`new_sqlite_classes`），目前沒有用到儲存。
