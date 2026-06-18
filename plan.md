# Plan

## 目标

修复线上使用 Nginx/域名访问时出现的状态不同步、假数据、刷新后 provider/log 丢失、检测无反馈、401 被前端吞掉的问题，并同步部署到 Linux `/root/model-detect`。

## 问题判断

1. 前端 API 失败后会 fallback 到 `mockApi.ts` 和 localStorage，导致真实后端失败时页面仍显示“成功”。截图里的 `user-agent: codex_exec` 来自 mock 数据，不是真实 CLI。
2. `/api/checks` 是长请求，前端没有进度；Nginx/浏览器/session 任何环节出错时用户只能干等。
3. 后端检测开始时读取旧 `state.json`，结束时整体保存，可能覆盖检测期间新增/修改的 provider。
4. 管理员 session 在内存里，服务重启后旧 cookie 会 401；前端没有统一处理 401，进一步触发 mock fallback。
5. API 响应缺少强制 no-store 头，虽然当前未开 Cloudflare 小黄云，也应该避免中间层缓存 API。

## 实施方案

### 后端

1. 给所有 `/api/*` 响应增加：
   - `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
   - `Pragma: no-cache`
   - `Expires: 0`
2. 增加状态写入队列 `updateState(mutator)`：
   - provider 保存、删除、settings 保存、检测日志写入都串行更新 `state.json`。
   - 检测完成时重新读取最新 state，只合并 runs 和 lastRunAt，不用检测开始时的旧 provider 覆盖最新配置。
3. 增加检测任务队列：
   - `POST /api/checks` 不再等待 CLI 完成，立即返回 `jobId` 和初始 job。
   - 后端串行执行检测，避免多个 CLI 共享内部抓包代理时互相覆盖 `activeProxyContext`。
   - `GET /api/checks/:id` 返回进度：queued/running/completed/failed、当前 provider/model/agent、stage、completed/total、success/failed、message/error。
4. 保留定时任务，但也使用相同的串行检测逻辑，避免并发冲突。
5. CLI 执行失败、超时、未捕获 exchange 时仍保存真实错误 run，不再依赖前端 mock。

### 前端

1. 移除真实 API 的 mock fallback：
   - 保存 provider 失败就提示错误。
   - 检测失败就提示错误。
   - 401 统一提示登录过期并回到登录页。
2. `loadInitialState` 仍可读取本地空状态用于首屏，但认证成功后以 `/api/state` 为唯一真实来源。
3. 检测按钮调用异步任务：
   - `POST /api/checks` 获取 job。
   - 轮询 `GET /api/checks/:id`。
   - 弹窗展示进度、当前阶段、当前模型、完成数量、成功/失败数量、错误信息。
   - job 完成后刷新 `/api/state`。
4. 检测期间按钮显示 loading，避免重复点击。
5. 检测请求或轮询遇到 401：立即退出登录态，不再显示假成功。

### 文档

更新 README：

1. 说明现在真实部署不使用 mock fallback。
2. 说明检测任务是后台异步任务，有进度弹窗。
3. 说明 API no-store 和 Nginx/Cloudflare `/api/*` 不缓存要求。
4. 补充 Linux 更新后只需重启 model-detect 服务，Nginx 通常不用动。

### 验证与部署

1. 本地运行：
   - `npm run typecheck`
   - `npm run build`
   - `node --check server/index.mjs`
2. Git 提交并推送。
3. Linux 只操作 `/root/model-detect`：
   - `git pull`
   - `npm install`
   - `npm run build`
   - `fuser -k 20020/tcp || true`
   - `PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid`
4. 用浏览器/MCP 访问域名或 IP，验证登录页/首页可打开。不触发真实模型检测，避免消耗 token。
