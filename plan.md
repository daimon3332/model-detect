# Plan

## 本轮目标

修复检测进度交互、首屏状态闪烁、Base URL 自动补全规则，并同步部署到 Linux 后对 `anyrouter`、`muyuan公益站`、`muyuan` 做短 prompt 验证。

## 已确认问题

1. 首屏会先显示 localStorage 旧数据，登录后再刷新服务端数据，导致 DeepSeek / 鲨鱼辣椒先出现，新 provider 过几秒才出现。
2. 检测进度使用弹窗且前端有全局检测状态，一个模型检测中会影响其他模型继续点击检测。
3. Base URL 不能简单补完整 endpoint。Codex CLI 自己请求 `/responses`，Claude Code 自己请求 `/messages`，项目只应该规范化 CLI 的 base_url。
4. AI 网关常见习惯是让用户配置 API base，例如 `https://host/v1` 或网关前缀，客户端再追加 `/responses`、`/chat/completions`、`/messages`。

## Base URL 规则

### 原则

- provider.baseUrl 原样保存，不静默改用户配置。
- 检测运行时生成 runtimeBaseUrl。
- 不把 Codex 的真实 `/responses` 请求自动改成 `/chat/completions`。
- 完整 endpoint 输入保留但视为高级/不推荐，前端和 README 提醒用户应填写 API base。

### Codex

Codex CLI 默认最终请求：

```text
/v1/responses
```

运行时 base_url 规则：

```text
https://anyrouter.top -> https://anyrouter.top/v1
https://shayulajiao.xyz/v1 -> https://shayulajiao.xyz/v1
https://gateway.example.com/compat -> https://gateway.example.com/compat
https://gateway.example.com/openai -> https://gateway.example.com/openai/v1
```

### Claude Code

Claude Code 最终请求：

```text
/v1/messages
```

运行时 base_url 规则：

```text
https://api.anthropic.com -> https://api.anthropic.com/v1
https://api.deepseek.com/anthropic -> https://api.deepseek.com/anthropic/v1
https://api.anthropic.com/v1 -> https://api.anthropic.com/v1
```

### 网关前缀

以下 path 视为网关兼容前缀，不自动补 `/v1`：

```text
/compat
/openai-compatible
/openai-compat
/litellm
/proxy
/gateway
```

其他非 endpoint 自定义 path 默认补 `/v1`。

## 前端修改

1. `loadInitialState()` 不再加载 localStorage 中的旧 providers/runs。
2. 登录检查完成并刷新 `/api/state` 后再展示服务端真实数据。
3. 删除检测进度弹窗。
4. 在模型监控页面顶部增加任务区：
   - queued / running / completed / failed
   - 当前 provider / agent / model
   - completed / total
   - success / failed
   - stage / message / error
5. 允许多个检测任务继续点击创建，后端排队执行。
6. 每个 job 独立轮询，完成后刷新 state。

## 后端修改

1. 增加 `runtimeBaseUrlFor(provider, agent)`。
2. `runOne()` 使用 runtimeBaseUrl 生成：
   - proxyBaseUrl
   - capture.upstreamBaseUrl
   - 写入 CLI 配置的 base_url
3. 保持 CLI 原始 endpoint 行为。

## 文档更新

README 增加：

- Base URL 应填 API base，不是完整 endpoint。
- Codex 最终请求 `/v1/responses`。
- Claude Code 最终请求 `/v1/messages`。
- OpenAI Chat Completions 是 `/v1/chat/completions`，但本项目默认不把 Codex 转成 chat completions。
- 顶部任务进度区和多任务排队说明。

## 验证

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
```

测试 provider：

```text
anyrouter
muyuan公益站
muyuan
```

只用短 prompt，查看成功/失败日志，不扩大测试范围。
