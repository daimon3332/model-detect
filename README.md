<h1 align="center">Model Detect</h1>

<p align="center">A Codex CLI / Claude Code CLI provider monitor that runs real CLI checks and captures raw HTTP request/response previews through a local proxy.</p>

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

> Model Detect is not a simple “call the model API” checker. It launches the real Codex CLI and Claude Code CLI, points them at a local capture proxy, and records the CLI request body and upstream response body previews for monitoring.

## What it does

Model Detect helps you manage providers and verify models with real CLI traffic:

```text
Add provider + models
  -> start a check job
  -> write isolated CLI config per provider/run
  -> start a local capture proxy
  -> run real codex / claude
  -> forward to the upstream provider
  -> save run summary + detail preview
  -> show status on the dashboard
```

Each provider keeps an isolated CLI config directory, so your user-level `~/.codex` and Claude Code settings are not modified.

## ✨ Key features

- 🖥️ Vue 3 + Element Plus WebUI for monitor, providers, prompts, logs, schedule, and settings.
- 🔌 Manage multiple providers with separate Base URL, API Key, proxy, timeout, and model lists.
- ⚡ Manual checks for all models, one provider, or a single model.
- ⏱️ Three-level schedule switches: global → provider → model.
- 🧩 Isolated Codex / Claude Code configs under `data/providers/<id>/`.
- 📡 Local capture proxy records CLI request and provider response body previews.
- 📦 Lightweight run storage to reduce OOM risk on long-running servers.
- 🔐 Password-protected admin session, backup export/import, and redacted log display.
- 🧰 Same process serves the WebUI and REST API.

## Getting started

Follow the **[English User Guide](./docs/USER_GUIDE.md)** for local startup, Linux deployment, systemd, migration, and troubleshooting.

Quick start:

```bash
npm install
npm run build
npm run server
```

Open `http://127.0.0.1:5173` and sign in with the default password `admin`. Change it immediately in **Settings**.

## Prerequisites

| Dependency | Required | Purpose |
| --- | --- | --- |
| Node.js / npm | Yes | Install deps, build frontend, run backend |
| Codex CLI | For Codex checks | `codex --version` |
| Claude Code CLI | For Claude checks | `claude --version` |
| Provider Base URL + API Key | Yes for real checks | Configured in the Providers page |

Node.js `^20.19.0` or `>=22.12.0` is recommended because the project uses Vite 7.

## Runtime notes

| Topic | Behavior |
| --- | --- |
| Default port | `5173` (`PORT` env overrides it) |
| Data directory | `./data` (or `MODEL_DETECT_DATA_DIR`) |
| Admin password | Default `admin`, stored in `data/state.json` |
| Capture proxy | Dynamic `127.0.0.1:<port>` per check run |
| Provider proxy | Optional HTTP/HTTPS/SOCKS per provider |
| Run retention | Summary + per-run detail files with body previews |

Schedule only runs when all three levels are enabled:

```text
global schedule ON
  -> provider enabled + provider schedule ON
    -> model enabled + model schedule ON
```

Prompt priority:

```text
model.prompt
  -> provider.prompt
    -> settings.codexPrompt / settings.claudePrompt
      -> agent default prompt
```

## Development

```bash
npm install
npm run dev          # frontend only
npm run server       # API + built dist
npm run typecheck
npm run build
```

Source layout:

```text
src/                 Vue frontend
server/index.mjs     Node backend, CLI runner, capture proxy
deploy/              systemd unit template
docs/                user guides and URL rules
```

## Troubleshooting

- Login fails after deploy: confirm the backend is running and you are not only serving static files.
- Check job stuck or 502: inspect `server.log` / `journalctl -u model-detect` and memory limits.
- Codex / Claude not found: install the CLI and ensure it is on `PATH` for the service user.
- Wrong upstream path: see [docs/url-normalization.md](./docs/url-normalization.md).
- Large history / OOM: use the built-in lightweight run storage and keep `NODE_OPTIONS=--max-old-space-size=...`.

More details are in the [User Guide](./docs/USER_GUIDE.md).

## License

Distributed under the [MIT License](./LICENSE).
