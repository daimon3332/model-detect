# Model Detect User Guide

English · [简体中文](./USER_GUIDE.zh-CN.md) · [繁體中文](./USER_GUIDE.zh-TW.md)

## 1. Prerequisites

Install and verify:

| Dependency | Check |
| --- | --- |
| Node.js / npm | `node -v` / `npm -v` |
| Codex CLI | `codex --version` |
| Claude Code CLI | `claude --version` |

Recommended Node.js: `^20.19.0` or `>=22.12.0`.

You also need provider Base URL and API Key for real checks. Model Detect creates isolated CLI configs under `data/providers/`; it does not require preconfigured user-level Codex / Claude Code.

## 2. Local startup

```bash
git clone https://github.com/daimon3332/model-detect.git
cd model-detect
npm install
npm run build
npm run server
```

Default URL:

```text
http://127.0.0.1:5173
```

Default admin password:

```text
admin
```

Change the password in **Settings** after the first login.

### Frontend-only development

```bash
npm install
npm run dev
```

Real checks, provider save, logs, and login require the backend (`npm run server`).

### Custom port

```bash
PORT=20020 npm run server
```

Windows PowerShell:

```powershell
$env:PORT="20020"; npm run server
```

## 3. First-time workflow

1. Open the WebUI and sign in.
2. Go to **Providers** and add Base URL, API Key, enabled agents, and models.
3. Optionally set a provider proxy (`http://`, `https://`, `socks://`, `socks5://`).
4. Open **Prompts** if you want custom check prompts.
5. On **Monitor**, run check-all / provider / single model.
6. Click a status code to inspect CLI I/O, request body preview, and response body preview.
7. Use **Schedule** only after global / provider / model switches are configured.

## 4. Linux deployment

### Temporary nohup

```bash
cd /root
git clone https://github.com/daimon3332/model-detect.git
cd /root/model-detect
npm install
npm run build
ufw allow 20020/tcp
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

Visit `http://SERVER_IP:20020`.

### Recommended: systemd

Template path:

```text
deploy/model-detect.service
```

If Node is installed via nvm, adjust `PATH` and `ExecStart` in the unit, then:

```bash
cd /root/model-detect
cp deploy/model-detect.service /etc/systemd/system/model-detect.service
systemctl daemon-reload
systemctl enable model-detect
systemctl restart model-detect
systemctl status model-detect --no-pager
```

Common commands:

```bash
systemctl start model-detect
systemctl stop model-detect
systemctl restart model-detect
journalctl -u model-detect -n 100 --no-pager
journalctl -u model-detect -f
```

The template appends application logs to:

```text
/root/model-detect/server.log
```

Memory guards in the template:

```text
Environment=NODE_OPTIONS=--max-old-space-size=384
MemoryHigh=600M
MemoryMax=800M
```

Remove the service:

```bash
systemctl stop model-detect || true
systemctl disable model-detect || true
rm -f /etc/systemd/system/model-detect.service
systemctl daemon-reload
systemctl reset-failed model-detect || true
```

### Update existing deployment

```bash
cd /root/model-detect
git pull
npm install
npm run build
systemctl restart model-detect
```

Without systemd:

```bash
cd /root/model-detect
export PATH=/root/.nvm/versions/node/v24.16.0/bin:$PATH
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

`data/` is gitignored, so `git pull` does not overwrite provider configs, password, or run history.

## 5. Migration

### Copy whole directory

```bash
scp -r /root/model-detect root@NEW_HOST:/root/model-detect
```

On the new host:

```bash
cd /root/model-detect
rm -f server.pid server.log
npm install
npm run build
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

### Clean code + data only

```bash
git clone https://github.com/daimon3332/model-detect.git /root/model-detect
scp -r root@OLD_HOST:/root/model-detect/data /root/model-detect/data
cd /root/model-detect
npm install
npm run build
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

### WebUI backup

1. Old instance: **Settings → Export backup**
2. New instance: **Settings → Import backup**

Import overwrites providers, prompts, schedule, and global settings, rebuilds provider config dirs, and clears current runs. Backup files contain secrets; keep them private.

## 6. Stop and inspect

Prefer pid file:

```bash
cd /root/model-detect
kill $(cat server.pid)
```

Or free the port:

```bash
fuser -k 20020/tcp
```

Status / logs:

```bash
ss -ltnp | grep ':20020'
tail -f server.log
```

## 7. Reverse proxy notes

You can put Nginx / Cloudflare in front of `127.0.0.1:20020`.

If Cloudflare proxy is enabled, bypass cache for `/api/*` so login, checks, and logs are not cached.

## 8. Data layout

```text
data/state.json
data/runs-summary.json
data/runs/<run-id>.json
data/providers/<provider-id>/codex-home/config.toml
data/providers/<provider-id>/claude-workspace/.claude/settings.json
data/providers/<provider-id>/run-contexts/<run-id>/...   # temporary, removed after run
```

Run storage keeps previews only. Headers, forward body, and exchange dumps are not persisted by default.

## 9. Base URL rules (summary)

Providers store API base, not full endpoints.

- Codex CLI ultimately calls `/responses` (usually `/v1/responses`).
- Claude Code CLI ultimately calls `/v1/messages`.

DeepSeek Claude Code example:

```text
https://api.deepseek.com/anthropic
```

Full normalization matrix: [url-normalization.md](./url-normalization.md).

## 10. Two kinds of proxies

1. **Internal capture proxy**  
   Dynamic local proxy used only to record CLI traffic for one run.

2. **Provider external proxy**  
   Optional per-provider `proxyUrl` for reaching the upstream provider through HTTP/HTTPS/SOCKS.

```text
CLI
  -> local capture proxy 127.0.0.1:<random-port>
    -> direct upstream, or via provider.proxyUrl
```

## 11. Schedule and prompts

Schedule requires all three switches:

```text
settings.scheduleEnabled
  + provider.scheduleEnabled
  + model.scheduleEnabled
```

Interval fields: `scheduleDays` / `scheduleHours` / `scheduleMinutes`. If all are `0`, backend uses a 1-minute minimum.

Prompt priority:

```text
model.prompt -> provider.prompt -> global agent prompt -> default
```

Default prompts:

```text
Codex: Reply exactly: ok
Claude Code: Reply exactly: ok
```

## 12. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Cannot log in | Backend process, cookie path, reverse-proxy cache |
| Connection refused / 502 | Service down, OOM kill, wrong port |
| `codex` / `claude` not found | Install CLI; fix service `PATH` |
| Wrong upstream path | Base URL rules, see url-normalization doc |
| Huge memory / OOM | Run retention, `NODE_OPTIONS`, systemd MemoryMax |
| Empty monitor after import | Import clears runs by design; re-run checks |

