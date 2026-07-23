# Model Detect 使用教程

[English](./USER_GUIDE.md) · 简体中文 · [繁體中文](./USER_GUIDE.zh-TW.md)

## 1. 前置条件

安装并验证：

| 依赖 | 验证命令 |
| --- | --- |
| Node.js / npm | `node -v` / `npm -v` |
| Codex CLI | `codex --version` |
| Claude Code CLI | `claude --version` |

建议 Node.js：`^20.19.0` 或 `>=22.12.0`。

真实检测还需要 provider 的 Base URL 和 API Key。项目会为每个 provider 创建隔离 CLI 配置，不要求提前配置用户级 Codex / Claude Code。

## 2. 本地启动

```bash
git clone https://github.com/daimon3332/model-detect.git
cd model-detect
npm install
npm run build
npm run server
```

默认访问：

```text
http://127.0.0.1:5173
```

默认管理员密码：

```text
admin
```

首次登录后请立刻到 **全局设置** 修改密码。

### 仅启动前端开发

```bash
npm install
npm run dev
```

真实检测、保存 provider、日志和登录都需要后端（`npm run server`）。

### 指定端口

```bash
PORT=20020 npm run server
```

Windows PowerShell：

```powershell
$env:PORT="20020"; npm run server
```

## 3. 首次使用流程

1. 打开 WebUI 并登录。
2. 进入 **模型提供商**，填写 Base URL、API Key、启用 Agent 与模型列表。
3. 可按需配置 provider 代理（`http://` / `https://` / `socks://` / `socks5://`）。
4. 需要时在 **提示词** 页面自定义检测 Prompt。
5. 在 **模型监控** 执行检测全部 / 单个 provider / 单个模型。
6. 点击状态码查看 CLI 输入输出、请求体 preview、响应体 preview。
7. 配置 **定时任务** 时，确认全局 / provider / model 三级开关。

## 4. Linux 部署

### 临时 nohup

```bash
cd /root
git clone https://github.com/daimon3332/model-detect.git
cd /root/model-detect
npm install
npm run build
ufw allow 20020/tcp
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

访问 `http://服务器IP:20020`。

### 推荐：systemd

模板：

```text
deploy/model-detect.service
```

若 Node 通过 nvm 安装，请先改 unit 中的 `PATH` 与 `ExecStart`，再执行：

```bash
cd /root/model-detect
cp deploy/model-detect.service /etc/systemd/system/model-detect.service
systemctl daemon-reload
systemctl enable model-detect
systemctl restart model-detect
systemctl status model-detect --no-pager
```

常用命令：

```bash
systemctl start model-detect
systemctl stop model-detect
systemctl restart model-detect
journalctl -u model-detect -n 100 --no-pager
journalctl -u model-detect -f
```

模板会把应用日志追加到：

```text
/root/model-detect/server.log
```

内置资源保护：

```text
Environment=NODE_OPTIONS=--max-old-space-size=384
MemoryHigh=600M
MemoryMax=800M
```

删除服务：

```bash
systemctl stop model-detect || true
systemctl disable model-detect || true
rm -f /etc/systemd/system/model-detect.service
systemctl daemon-reload
systemctl reset-failed model-detect || true
```

### 已有部署更新

```bash
cd /root/model-detect
git pull
npm install
npm run build
systemctl restart model-detect
```

无 systemd 时：

```bash
cd /root/model-detect
export PATH=/root/.nvm/versions/node/v24.16.0/bin:$PATH
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

`data/` 已加入 `.gitignore`，`git pull` 不会覆盖 provider 配置、管理员密码和检测日志。

## 5. 迁移

### 整目录复制

```bash
scp -r /root/model-detect root@新服务器:/root/model-detect
```

新服务器：

```bash
cd /root/model-detect
rm -f server.pid server.log
npm install
npm run build
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

### 干净代码 + 仅迁移 data

```bash
git clone https://github.com/daimon3332/model-detect.git /root/model-detect
scp -r root@旧服务器:/root/model-detect/data /root/model-detect/data
cd /root/model-detect
npm install
npm run build
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

### 页面备份

1. 旧实例：**全局设置 → 导出备份**
2. 新实例：**全局设置 → 导入备份**

导入会覆盖 provider、提示词、定时任务和全局配置，重建 provider 配置目录，并清空当前检测记录。备份含敏感信息，请私密保存。

## 6. 停止与查看

优先使用 pid：

```bash
cd /root/model-detect
kill $(cat server.pid)
```

或按端口结束：

```bash
fuser -k 20020/tcp
```

状态 / 日志：

```bash
ss -ltnp | grep ':20020'
tail -f server.log
```

## 7. 反代说明

可用 Nginx / Cloudflare 反代到 `127.0.0.1:20020`。

若开启 Cloudflare 小黄云，请对 `/api/*` 配置 bypass cache，避免登录态、检测结果和日志被缓存。

## 8. 数据目录

```text
data/state.json
data/runs-summary.json
data/runs/<run-id>.json
data/providers/<provider-id>/codex-home/config.toml
data/providers/<provider-id>/claude-workspace/.claude/settings.json
data/providers/<provider-id>/run-contexts/<run-id>/...   # 临时目录，run 结束后删除
```

默认只保存 body preview，不持久化 headers、forward body 与 exchanges 全量副本。

## 9. Base URL 规则（摘要）

提供商填写的是 API base，不是完整 endpoint。

- Codex CLI 最终请求 `/responses`（通常是 `/v1/responses`）。
- Claude Code CLI 最终请求 `/v1/messages`。

DeepSeek Claude Code 示例：

```text
https://api.deepseek.com/anthropic
```

完整规范化矩阵见：[url-normalization.md](./url-normalization.md)。

## 10. 两类代理

1. **内部抓包代理**  
   每次检测动态启动的本地代理，仅用于记录该 run 的 CLI 流量。

2. **Provider 外部代理**  
   可选的 `proxyUrl`，用于经 HTTP/HTTPS/SOCKS 访问上游 provider。

```text
CLI
  -> 本地抓包代理 127.0.0.1:<random-port>
    -> 直连上游，或经 provider.proxyUrl
```

## 11. 定时任务与 Prompt

定时任务必须三级全开：

```text
settings.scheduleEnabled
  + provider.scheduleEnabled
  + model.scheduleEnabled
```

间隔字段：`scheduleDays` / `scheduleHours` / `scheduleMinutes`。三项都为 `0` 时，后端按最小 1 分钟保护。

Prompt 优先级：

```text
model.prompt -> provider.prompt -> 全局 agent prompt -> 默认值
```

默认 Prompt：

```text
Codex: Reply exactly: ok
Claude Code: Reply exactly: ok
```

## 12. 常见问题

| 现象 | 排查 |
| --- | --- |
| 无法登录 | 后端是否启动、Cookie 路径、反代缓存 |
| Connection refused / 502 | 服务是否退出、OOM、端口是否正确 |
| 找不到 codex / claude | 是否安装 CLI、服务 PATH 是否包含 |
| 上游路径不对 | Base URL 规则，见 url-normalization |
| 内存过高 / OOM | run 保留策略、`NODE_OPTIONS`、systemd MemoryMax |
| 导入后监控为空 | 导入会清空 runs，需重新检测 |

