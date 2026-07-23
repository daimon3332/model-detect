# Model Detect 使用教學

[English](./USER_GUIDE.md) · [简体中文](./USER_GUIDE.zh-CN.md) · 繁體中文

## 1. 前置條件

安裝並驗證：

| 依賴 | 驗證指令 |
| --- | --- |
| Node.js / npm | `node -v` / `npm -v` |
| Codex CLI | `codex --version` |
| Claude Code CLI | `claude --version` |

建議 Node.js：`^20.19.0` 或 `>=22.12.0`。

真實檢測還需要 provider 的 Base URL 與 API Key。專案會為每個 provider 建立隔離 CLI 設定，不要求事先設定使用者層級 Codex / Claude Code。

## 2. 本機啟動

```bash
git clone https://github.com/daimon3332/model-detect.git
cd model-detect
npm install
npm run build
npm run server
```

預設網址：

```text
http://127.0.0.1:5173
```

預設管理員密碼：

```text
admin
```

首次登入後請立刻到 **全域設定** 修改密碼。

### 僅啟動前端開發

```bash
npm install
npm run dev
```

真實檢測、儲存 provider、日誌與登入都需要後端（`npm run server`）。

### 指定連接埠

```bash
PORT=20020 npm run server
```

Windows PowerShell：

```powershell
$env:PORT="20020"; npm run server
```

## 3. 首次使用流程

1. 開啟 WebUI 並登入。
2. 進入 **模型提供商**，填寫 Base URL、API Key、啟用 Agent 與模型列表。
3. 可依需求設定 provider 代理（`http://` / `https://` / `socks://` / `socks5://`）。
4. 需要時在 **提示詞** 頁面自訂檢測 Prompt。
5. 在 **模型監控** 執行檢測全部 / 單一 provider / 單一模型。
6. 點擊狀態碼查看 CLI 輸入輸出、請求體 preview、回應體 preview。
7. 設定 **定時任務** 時，確認全域 / provider / model 三級開關。

## 4. Linux 部署

### 臨時 nohup

```bash
cd /root
git clone https://github.com/daimon3332/model-detect.git
cd /root/model-detect
npm install
npm run build
ufw allow 20020/tcp
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

訪問 `http://伺服器IP:20020`。

### 建議：systemd

範本：

```text
deploy/model-detect.service
```

若 Node 透過 nvm 安裝，請先修改 unit 中的 `PATH` 與 `ExecStart`，再執行：

```bash
cd /root/model-detect
cp deploy/model-detect.service /etc/systemd/system/model-detect.service
systemctl daemon-reload
systemctl enable model-detect
systemctl restart model-detect
systemctl status model-detect --no-pager
```

常用指令：

```bash
systemctl start model-detect
systemctl stop model-detect
systemctl restart model-detect
journalctl -u model-detect -n 100 --no-pager
journalctl -u model-detect -f
```

範本會把應用日誌追加到：

```text
/root/model-detect/server.log
```

內建資源保護：

```text
Environment=NODE_OPTIONS=--max-old-space-size=384
MemoryHigh=600M
MemoryMax=800M
```

刪除服務：

```bash
systemctl stop model-detect || true
systemctl disable model-detect || true
rm -f /etc/systemd/system/model-detect.service
systemctl daemon-reload
systemctl reset-failed model-detect || true
```

### 既有部署更新

```bash
cd /root/model-detect
git pull
npm install
npm run build
systemctl restart model-detect
```

無 systemd 時：

```bash
cd /root/model-detect
export PATH=/root/.nvm/versions/node/v24.16.0/bin:$PATH
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

`data/` 已加入 `.gitignore`，`git pull` 不會覆寫 provider 設定、管理員密碼與檢測日誌。

## 5. 遷移

### 整目錄複製

```bash
scp -r /root/model-detect root@新伺服器:/root/model-detect
```

新伺服器：

```bash
cd /root/model-detect
rm -f server.pid server.log
npm install
npm run build
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

### 乾淨程式碼 + 僅遷移 data

```bash
git clone https://github.com/daimon3332/model-detect.git /root/model-detect
scp -r root@舊伺服器:/root/model-detect/data /root/model-detect/data
cd /root/model-detect
npm install
npm run build
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

### 頁面備份

1. 舊實例：**全域設定 → 匯出備份**
2. 新實例：**全域設定 → 匯入備份**

匯入會覆寫 provider、提示詞、定時任務與全域設定，重建 provider 設定目錄，並清空目前檢測記錄。備份含敏感資訊，請私密保存。

## 6. 停止與查看

優先使用 pid：

```bash
cd /root/model-detect
kill $(cat server.pid)
```

或依連接埠結束：

```bash
fuser -k 20020/tcp
```

狀態 / 日誌：

```bash
ss -ltnp | grep ':20020'
tail -f server.log
```

## 7. 反向代理說明

可用 Nginx / Cloudflare 反向代理到 `127.0.0.1:20020`。

若啟用 Cloudflare 代理，請對 `/api/*` 設定 bypass cache，避免登入狀態、檢測結果與日誌被快取。

## 8. 資料目錄

```text
data/state.json
data/runs-summary.json
data/runs/<run-id>.json
data/providers/<provider-id>/codex-home/config.toml
data/providers/<provider-id>/claude-workspace/.claude/settings.json
data/providers/<provider-id>/run-contexts/<run-id>/...   # 臨時目錄，run 結束後刪除
```

預設只儲存 body preview，不持久化 headers、forward body 與 exchanges 全量副本。

## 9. Base URL 規則（摘要）

提供商填寫的是 API base，不是完整 endpoint。

- Codex CLI 最終請求 `/responses`（通常是 `/v1/responses`）。
- Claude Code CLI 最終請求 `/v1/messages`。

DeepSeek Claude Code 範例：

```text
https://api.deepseek.com/anthropic
```

完整正規化矩陣見：[url-normalization.md](./url-normalization.md)。

## 10. 兩類代理

1. **內部抓包代理**  
   每次檢測動態啟動的本機代理，僅用於記錄該 run 的 CLI 流量。

2. **Provider 外部代理**  
   可選的 `proxyUrl`，用於經 HTTP/HTTPS/SOCKS 存取上游 provider。

```text
CLI
  -> 本機抓包代理 127.0.0.1:<random-port>
    -> 直連上游，或經 provider.proxyUrl
```

## 11. 定時任務與 Prompt

定時任務必須三級全開：

```text
settings.scheduleEnabled
  + provider.scheduleEnabled
  + model.scheduleEnabled
```

間隔欄位：`scheduleDays` / `scheduleHours` / `scheduleMinutes`。三項都為 `0` 時，後端按最小 1 分鐘保護。

Prompt 優先順序：

```text
model.prompt -> provider.prompt -> 全域 agent prompt -> 預設值
```

預設 Prompt：

```text
Codex: Reply exactly: ok
Claude Code: Reply exactly: ok
```

## 12. 常見問題

| 現象 | 排查 |
| --- | --- |
| 無法登入 | 後端是否啟動、Cookie 路徑、反向代理快取 |
| Connection refused / 502 | 服務是否退出、OOM、連接埠是否正確 |
| 找不到 codex / claude | 是否安裝 CLI、服務 PATH 是否包含 |
| 上游路徑不對 | Base URL 規則，見 url-normalization |
| 記憶體過高 / OOM | run 保留策略、`NODE_OPTIONS`、systemd MemoryMax |
| 匯入後監控為空 | 匯入會清空 runs，需重新檢測 |

