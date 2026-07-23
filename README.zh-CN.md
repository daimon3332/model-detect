<h1 align="center">Model Detect</h1>

<p align="center">面向 Codex CLI / Claude Code CLI 的模型提供商监控工具：通过真实 CLI 发起检测，并用本地代理记录原始 HTTP 请求与响应 preview。</p>

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

> Model Detect 不是普通的“直接请求模型 API”检测工具。它会启动真实的 Codex CLI / Claude Code CLI，把流量导向本地抓包代理，并记录 CLI 请求体与上游响应体 preview，便于监控和排障。

## 项目用途

Model Detect 用于管理多个模型提供商，并用真实 CLI 流量验证模型可用性：

```text
添加 provider 与模型
  -> 发起检测任务
  -> 写入 provider / run 级隔离 CLI 配置
  -> 启动本地抓包代理
  -> 执行真实 codex / claude
  -> 转发到上游 provider
  -> 保存检测摘要与详情 preview
  -> 在监控页展示状态
```

每个 provider 使用独立 CLI 配置目录，不会污染用户级 `~/.codex` 或 Claude Code 配置。

## ✨ 核心功能

- 🖥️ Vue 3 + Element Plus WebUI：模型监控、提供商、提示词、日志、定时任务、全局设置。
- 🔌 管理多个 provider：Base URL、API Key、代理、超时、模型列表等。
- ⚡ 支持检测全部、单个 provider、单个模型。
- ⏱️ 三级定时开关：全局 → provider → model。
- 🧩 Codex / Claude Code 隔离配置位于 `data/providers/<id>/`。
- 📡 本地抓包代理记录 CLI 请求体与服务商响应体 preview。
- 📦 轻量 run 存储，降低长时间运行时的 OOM 风险。
- 🔐 管理员密码会话、备份导出/导入、日志脱敏展示。
- 🧰 WebUI 与 REST API 由同一进程提供。

## 开始使用

请查看 **[简体中文使用教程](./docs/USER_GUIDE.zh-CN.md)**，包含本地启动、Linux 部署、systemd、迁移与常见问题。

快速启动：

```bash
npm install
npm run build
npm run server
```

访问 `http://127.0.0.1:5173`，默认管理员密码为 `admin`。登录后请立即到 **全局设置** 修改密码。

## 前置条件

| 依赖 | 是否必须 | 用途 |
| --- | --- | --- |
| Node.js / npm | 是 | 安装依赖、构建前端、运行后端 |
| Codex CLI | 检测 Codex 时 | `codex --version` |
| Claude Code CLI | 检测 Claude 时 | `claude --version` |
| Provider Base URL + API Key | 真实检测时 | 在“模型提供商”页面配置 |

建议 Node.js `^20.19.0` 或 `>=22.12.0`（项目使用 Vite 7）。

## 运行说明

| 项目 | 行为 |
| --- | --- |
| 默认端口 | `5173`（可用 `PORT` 覆盖） |
| 数据目录 | `./data`（或 `MODEL_DETECT_DATA_DIR`） |
| 管理员密码 | 默认 `admin`，保存在 `data/state.json` |
| 抓包代理 | 每次检测使用动态 `127.0.0.1:<port>` |
| Provider 代理 | 每个 provider 可选 HTTP/HTTPS/SOCKS |
| 日志保留 | 摘要 + 单条详情，body 仅保留 preview |

定时任务必须三级全开才会执行：

```text
全局定时开启
  -> provider 已启用且 provider 定时开启
    -> model 已启用且 model 定时开启
```

Prompt 优先级：

```text
model.prompt
  -> provider.prompt
    -> settings.codexPrompt / settings.claudePrompt
      -> agent 默认 Prompt
```

## 开发

```bash
npm install
npm run dev          # 仅前端
npm run server       # API + 已构建 dist
npm run typecheck
npm run build
```

目录结构：

```text
src/                 Vue 前端
server/index.mjs     Node 后端、CLI 调用、抓包代理
deploy/              systemd 模板
docs/                使用教程与 URL 规则
```

## 常见问题

- 部署后无法登录：确认后端服务已启动，而不是只托管了静态文件。
- 检测卡住或 502：查看 `server.log` / `journalctl -u model-detect` 与内存限制。
- 找不到 codex / claude：安装 CLI，并保证服务账号 `PATH` 可见。
- 上游路径不对：见 [docs/url-normalization.md](./docs/url-normalization.md)。
- 历史日志过大 / OOM：使用内置轻量存储，并设置 `NODE_OPTIONS=--max-old-space-size=...`。

更多细节见 [使用教程](./docs/USER_GUIDE.zh-CN.md)。

## 许可证

本项目采用 [MIT License](./LICENSE)。
