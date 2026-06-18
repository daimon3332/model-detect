# Plan

## 本轮目标

实现并发检测，但每个检测 run 使用独立本地代理端口和独立 capture context，避免请求日志串线；同时修复 DeepSeek Claude Code 路径补全、增强顶部任务进度、让单模型完成后立即保存并刷新。

## 当前问题

1. 旧设计使用全局 `activeProxyContext` 和共享 `127.0.0.1:7788`，只能串行，否则多个 CLI 请求会串日志。
2. 当前 job 只显示任务总进度，不显示每个 provider/model 的独立结果。
3. 当前 runs 基本等任务结束后批量写入，不利于首页最近 10 次逐步更新。
4. DeepSeek 官方 Claude Code 文档要求 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，不能自动补成 `/anthropic/v1`，否则 Claude Code 追加 `/v1/messages` 后会变成错误路径。
5. 当前超时默认 90 秒，前端已有 provider 级设置，但文案不够清楚；最大并发数还没有全局设置。

## 设计

### 1. 每个 run 独立代理

移除：

```text
全局 127.0.0.1:7788
全局 activeProxyContext
全局串行 checkQueue
```

改为：

```text
runOne()
  -> createCaptureProxy(capture)
  -> 监听 127.0.0.1:0，由系统分配动态端口
  -> proxy handler 闭包绑定 capture
  -> CLI base_url 指向该 run 的独立代理端口
  -> runOne finally 关闭代理
```

这样多个 CLI 可以并发执行，每个请求只进入自己的 proxy/context。

### 2. 并发池

保留队列概念，但改为 worker pool：

```text
queued items -> runWithConcurrency(maxConcurrentChecks)
```

默认：

```text
settings.maxConcurrentChecks = 3
```

限制范围：

```text
1 - 10
```

### 3. job.items

CheckJob 增加：

```ts
items: Array<{
  id: string
  providerId: string
  providerName: string
  agent: AgentType
  model: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'timeout'
  httpStatus: number | null
  cliExitCode: number | null
  latencyMs: number
  errorMessage: string
  runId: string
}>
```

顶部任务区显示任务级和模型级：

```text
检测全部 running 2/5
✅ anyrouter / codex / gpt5.5       404 failed
⏳ muyuan公益站 / codex / gpt-5.5   running
❌ muyuan / codex / gpt-5.5         timeout
```

### 4. 单模型完成即保存

流程：

```text
runOne 完成
  -> 立即 updateState 写入该 run
  -> 更新 job.items 对应项
  -> 更新 completed/success/failed
  -> 前端轮询发现 completed 变化后 refreshState()
```

这样首页最近 10 次会逐步更新，不等整个 job 完成。

### 5. Base URL 修正

Codex：

```text
用户填 https://host        -> 运行时 https://host/v1 -> CLI 请求 /v1/responses
用户填 https://host/v1     -> 保持 -> CLI 请求 /v1/responses
```

Claude Code：

```text
用户填 https://api.deepseek.com/anthropic -> 保持 -> CLI 请求 /anthropic/v1/messages
用户填 https://api.anthropic.com          -> 保持 -> CLI 请求 /v1/messages
```

也就是 Claude 不自动给自定义 path 补 `/v1`。

### 6. 前端

1. 顶部任务区显示 job.items。
2. 多个任务可以继续点击创建，互不阻塞。
3. 轮询 job 时，如果 `completed` 增加，立即 `refreshState()`。
4. 全局设置新增最大并发数。
5. Provider 编辑中的 `CLI 超时` 文案改为 `CLI / 上游请求超时（秒）`。

### 7. README

更新：

- 默认最大并发 3。
- 每个检测 run 使用独立本地代理端口。
- 单模型完成立即写日志。
- Claude Code / DeepSeek Base URL 不自动补 `/v1`。
- 超时设置位置和含义。

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

短 prompt 验证：

- DeepSeek / Claude Code，重点确认转发 URL 是 `https://api.deepseek.com/anthropic/v1/messages`。
- 必要时再抽测 anyrouter / muyuan公益站 / muyuan，避免大量 token 消耗。
