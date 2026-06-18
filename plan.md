# Plan

## 本轮目标

1. 解决保存 provider/settings 和其他按钮响应慢的问题。
2. 检测详情默认增加 `CLI 输入输出` 面板，展示 prompt/stdout/stderr/exit code。
3. Codex 默认 `config.toml` 增加：

```toml
model_instructions_file = "~/.codex/instruction.md"
```

4. 在全局设置中增加 Codex 默认 `config.toml` 与 Claude Code 默认 `settings.json` 的编辑区域。
5. 更新 README，说明性能优化、日志存储结构、详情加载方式和默认模板。
6. 本地验证后提交、推送，并同步 Linux `/root/model-detect`。

## 当前慢的原因

现有设计把配置和日志全部放在一个 `data/state.json`：

```text
state.json = providers + settings + runs
```

每条 run 又包含完整请求头、请求体、响应头、响应体、SSE、stdout、stderr 等内容。日志变多后：

```text
保存 provider/settings
  -> 读取巨大 state.json
  -> 重写巨大 state.json
  -> 返回完整 publicState
  -> 前端解析大量 runs 详情
```

所以配置保存、刷新和部分按钮都会变慢。

## 方案

### 1. 配置与日志拆分

改为：

```text
data/state.json  // providers + settings
data/runs.json   // 检测记录
```

兼容旧数据：

```text
如果 runs.json 存在：runs 从 runs.json 读取
如果 runs.json 不存在：从旧 state.json.runs 迁移读取
保存 state 时不再写入完整 runs
保存 run 时只写 runs.json
```

### 2. `/api/state` 返回轻量日志摘要

新增摘要结构：

```ts
RunSummary = {
  id,
  providerId,
  providerName,
  model,
  agent,
  state,
  httpStatus,
  cliExitCode,
  latencyMs,
  createdAt,
  prompt,
  errorMessage
}
```

`/api/state` 只返回摘要 runs，不返回完整请求体/响应体。这样保存 provider/settings 后的响应会很小。

### 3. 新增完整 run 详情接口

新增：

```http
GET /api/runs/:id
```

点击状态码或日志详情时再拉完整 run，并打开详情弹窗。

### 4. CLI 输入输出详情页

详情按钮顺序：

```text
CLI 输入输出 | 请求头 | 请求体 | 响应头 | 响应体 | 网关路由转发头 | 网关路由转发体
```

默认展示 `CLI 输入输出`。

内容：

```text
Prompt:
hello

stdout:
Hello! How can I help?

stderr:
...

exit code:
0
```

### 5. 默认模板

新增全局设置字段：

```ts
settings.defaultCodexConfig
settings.defaultClaudeSettings
```

默认 Codex TOML：

```toml
model = "gpt-5.5"
model_provider = "provider"
approval_policy = "never"
sandbox_mode = "read-only"
model_instructions_file = "~/.codex/instruction.md"

[model_providers.provider]
name = "Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

新建 provider 使用全局默认模板；已有 provider 不自动覆盖。

### 6. 保存性能

保存 provider/settings 后：

- 后端只写 `state.json`。
- 响应只返回 provider/settings + run 摘要。
- 不再传输完整 run body。

### 7. 验证

本地：

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

Linux：

```bash
cd /root/model-detect
git pull
export PATH=/root/model-detect/.tools/node-v20.19.5-linux-arm64/bin:$PATH
npm install
npm run build
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
curl -s -D - http://127.0.0.1:20020/api/session
```
