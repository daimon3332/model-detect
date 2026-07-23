<h1 align="center">Model Detect</h1>

<p align="center">面向 Codex CLI / Claude Code CLI 的模型提供商監控工具：透過真實 CLI 發起檢測，並用本機代理記錄原始 HTTP 請求與回應 preview。</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white">
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=white">
  <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-green.svg">
  <img alt="Platforms" src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue">
</p>

> Model Detect 不是一般的「直接請求模型 API」檢測工具。它會啟動真實的 Codex CLI / Claude Code CLI，把流量導向本機抓包代理，並記錄 CLI 請求體與上游回應體 preview，方便監控與排障。

## 專案用途

Model Detect 用於管理多個模型提供商，並以真實 CLI 流量驗證模型可用性：

```text
新增 provider 與模型
  -> 發起檢測任務
  -> 寫入 provider / run 級隔離 CLI 設定
  -> 啟動本機抓包代理
  -> 執行真實 codex / claude
  -> 轉發到上游 provider
  -> 儲存檢測摘要與詳情 preview
  -> 在監控頁顯示狀態
```

每個 provider 使用獨立 CLI 設定目錄，不會污染使用者層級 `~/.codex` 或 Claude Code 設定。

## ✨ 核心功能

- 🖥️ Vue 3 + Element Plus WebUI：模型監控、提供商、提示詞、日誌、定時任務、全域設定。
- 🔌 管理多個 provider：Base URL、API Key、代理、逾時、模型列表等。
- ⚡ 支援檢測全部、單一 provider、單一模型。
- ⏱️ 三級定時開關：全域 → provider → model。
- 🧩 Codex / Claude Code 隔離設定位於 `data/providers/<id>/`。
- 📡 本機抓包代理記錄 CLI 請求體與服務商回應體 preview。
- 📦 輕量 run 儲存，降低長時間執行時的 OOM 風險。
- 🔐 管理員密碼工作階段、備份匯出/匯入、日誌脫敏顯示。
- 🧰 WebUI 與 REST API 由同一行程提供。

## 開始使用

請參閱 **[繁體中文使用教學](./docs/USER_GUIDE.zh-TW.md)**，包含本機啟動、Linux 部署、systemd、遷移與常見問題。

快速啟動：

```bash
npm install
npm run build
npm run server
```

開啟 `http://127.0.0.1:5173`，預設管理員密碼為 `admin`。登入後請立刻到 **全域設定** 修改密碼。

## 前置條件

| 依賴 | 是否必須 | 用途 |
| --- | --- | --- |
| Node.js / npm | 是 | 安裝依賴、建置前端、執行後端 |
| Codex CLI | 檢測 Codex 時 | `codex --version` |
| Claude Code CLI | 檢測 Claude 時 | `claude --version` |
| Provider Base URL + API Key | 真實檢測時 | 在「模型提供商」頁面設定 |

建議 Node.js `^20.19.0` 或 `>=22.12.0`（專案使用 Vite 7）。

## 執行說明

| 項目 | 行為 |
| --- | --- |
| 預設連接埠 | `5173`（可用 `PORT` 覆寫） |
| 資料目錄 | `./data`（或 `MODEL_DETECT_DATA_DIR`） |
| 管理員密碼 | 預設 `admin`，保存在 `data/state.json` |
| 抓包代理 | 每次檢測使用動態 `127.0.0.1:<port>` |
| Provider 代理 | 每個 provider 可選 HTTP/HTTPS/SOCKS |
| 日誌保留 | 摘要 + 單條詳情，body 僅保留 preview |

定時任務必須三級全開才會執行：

```text
全域定時開啟
  -> provider 已啟用且 provider 定時開啟
    -> model 已啟用且 model 定時開啟
```

Prompt 優先順序：

```text
model.prompt
  -> provider.prompt
    -> settings.codexPrompt / settings.claudePrompt
      -> agent 預設 Prompt
```

## 開發

```bash
npm install
npm run dev          # 僅前端
npm run server       # API + 已建置 dist
npm run typecheck
npm run build
```

目錄結構：

```text
src/                 Vue 前端
server/index.mjs     Node 後端、CLI 呼叫、抓包代理
deploy/              systemd 範本
docs/                使用教學與 URL 規則
```

## 常見問題

- 部署後無法登入：確認後端服務已啟動，而不是只託管了靜態檔。
- 檢測卡住或 502：查看 `server.log` / `journalctl -u model-detect` 與記憶體限制。
- 找不到 codex / claude：安裝 CLI，並確保服務帳號 `PATH` 可見。
- 上游路徑不對：見 [docs/url-normalization.md](./docs/url-normalization.md)。
- 歷史日誌過大 / OOM：使用內建輕量儲存，並設定 `NODE_OPTIONS=--max-old-space-size=...`。

更多細節見 [使用教學](./docs/USER_GUIDE.zh-TW.md)。

## 授權條款

本專案採用 [MIT License](./LICENSE)。
