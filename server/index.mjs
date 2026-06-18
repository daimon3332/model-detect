import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { ProxyAgent } from 'proxy-agent'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDir = resolve(process.env.MODEL_DETECT_DATA_DIR || join(root, 'data'))
const stateFile = join(dataDir, 'state.json')
const port = Number(process.env.PORT || 5173)
const schedulerMs = 30_000
const maxCapturedBodyChars = 2_000_000

let proxyServer = null
let proxyServerPort = null
let activeProxyContext = null
const sessions = new Set()
const jobs = new Map()
let checkQueue = Promise.resolve()
let stateWriteQueue = Promise.resolve()
let scheduleRunning = false

const defaults = {
  providers: [],
  runs: [],
  settings: {
    codexCommand: 'codex',
    claudeCommand: 'claude',
    dataDir: './data',
    prompt: 'Hello',
    scheduleEnabled: false,
    scheduleDays: 0,
    scheduleHours: 0,
    scheduleMinutes: 30,
    proxyPort: 7788,
    logRetentionDays: 30,
    redactLogs: true,
    adminPassword: 'admin'
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

async function ensureData() {
  await mkdir(dataDir, { recursive: true })
  try {
    await stat(stateFile)
  } catch {
    await saveState(defaults)
  }
}

async function loadState() {
  await ensureData()
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers.map(normalizeProvider) : [],
      runs: parsed.runs ?? [],
      settings: normalizeSettings(parsed.settings)
    }
  } catch {
    return structuredClone(defaults)
  }
}

function normalizeSettings(settings = {}) {
  const merged = { ...defaults.settings, ...settings }
  if (settings.scheduleDays === undefined && settings.scheduleHours === undefined) {
    const total = Math.max(0, Number(settings.scheduleMinutes || defaults.settings.scheduleMinutes))
    merged.scheduleDays = Math.floor(total / 1440)
    merged.scheduleHours = Math.floor((total % 1440) / 60)
    merged.scheduleMinutes = total % 60
  }
  merged.scheduleDays = Number(merged.scheduleDays || 0)
  merged.scheduleHours = Number(merged.scheduleHours || 0)
  merged.scheduleMinutes = Number(merged.scheduleMinutes || 0)
  merged.adminPassword = String(merged.adminPassword || 'admin')
  return merged
}

function scheduleIntervalMs(settings) {
  const minutes =
    Number(settings.scheduleDays || 0) * 1440 +
    Number(settings.scheduleHours || 0) * 60 +
    Number(settings.scheduleMinutes || 0)
  return Math.max(1, minutes) * 60_000
}

async function saveState(state) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2))
}

async function updateState(mutator) {
  const next = stateWriteQueue.then(async () => {
    const state = await loadState()
    const result = await mutator(state)
    const finalState = result || state
    await saveState(finalState)
    return finalState
  })
  stateWriteQueue = next.catch(() => undefined)
  return next
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    ...headers
  })
  res.end(JSON.stringify(body))
}

function publicState(state) {
  const { adminPassword, ...settings } = state.settings
  return { ...state, settings }
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf('=')
        return index === -1 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))]
      })
  )
}

function sessionToken(req) {
  return parseCookies(req).model_detect_session || ''
}

function isAuthenticated(req) {
  return sessions.has(sessionToken(req))
}

function safeId(value) {
  return String(value || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '-')
}

function providerBase(provider) {
  return join(dataDir, 'providers', safeId(provider.id))
}

function modelId(agent, name) {
  return `${agent}:${name}`
}

function normalizeProvider(provider) {
  return {
    id: safeId(provider.id),
    name: String(provider.name || '未命名提供商').trim(),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
    proxyUrl: provider.proxyUrl || '',
    codexEnabled: provider.codexEnabled !== false,
    claudeEnabled: provider.claudeEnabled === true,
    prompt: provider.prompt || '',
    timeoutSeconds: Number(provider.timeoutSeconds || 90),
    scheduleEnabled: provider.scheduleEnabled === true,
    saveBody: provider.saveBody !== false,
    models: Array.isArray(provider.models)
      ? provider.models.map((item) => ({
          id: item.id || modelId(item.agent, item.name),
          name: item.name,
          agent: item.agent,
          enabled: item.enabled !== false,
          prompt: item.prompt || '',
          scheduleEnabled: item.scheduleEnabled !== false,
          lastRunAt: item.lastRunAt || '',
          nextRunAt: item.nextRunAt || ''
        })).filter((item) => item.name && ['codex', 'claude'].includes(item.agent))
      : [],
    codexConfig: provider.codexConfig || '',
    claudeSettings: provider.claudeSettings || '',
    lastRunAt: provider.lastRunAt || '',
    nextRunAt: provider.nextRunAt || ''
  }
}

async function upsertProvider(provider) {
  const next = normalizeProvider(provider)
  await materializeProvider(next)
  return updateState((state) => {
    const index = state.providers.findIndex((item) => item.id === next.id)
    if (index >= 0) state.providers.splice(index, 1, next)
    else state.providers.unshift(next)
    return state
  })
}

async function deleteProvider(id) {
  await rm(join(dataDir, 'providers', safeId(id)), { recursive: true, force: true })
  return updateState((state) => {
    state.providers = state.providers.filter((item) => item.id !== id)
    state.runs = state.runs.filter((item) => item.providerId !== id)
    return state
  })
}

async function materializeProvider(provider, model, proxyBaseUrl = '') {
  const base = providerBase(provider)
  const codexHome = join(base, 'codex-home')
  const claudeWorkspace = join(base, 'claude-workspace')
  await mkdir(codexHome, { recursive: true })
  await mkdir(join(claudeWorkspace, '.claude'), { recursive: true })
  await writeFile(join(codexHome, 'config.toml'), buildCodexConfig(provider, model, proxyBaseUrl), 'utf8')
  await writeFile(join(claudeWorkspace, '.claude', 'settings.json'), buildClaudeSettings(provider, model, proxyBaseUrl), 'utf8')
}

function buildCodexConfig(provider, model, proxyBaseUrl = '') {
  let text = provider.codexConfig || ''
  if (model?.agent === 'codex') {
    text = /^model\s*=\s*".*"/m.test(text)
      ? text.replace(/^model\s*=\s*".*"/m, `model = "${model.name}"`)
      : `model = "${model.name}"\n${text}`
  }
  if (!/env_key\s*=/m.test(text) && /\[model_providers\.[^\]\n]+\]/m.test(text)) {
    text = text.replace(/(\[model_providers\.[^\]\n]+\]\n)/m, '$1env_key = "OPENAI_API_KEY"\n')
  }
  if (proxyBaseUrl) {
    text = /base_url\s*=\s*"[^"]*"/m.test(text)
      ? text.replace(/base_url\s*=\s*"[^"]*"/m, `base_url = "${proxyBaseUrl}"`)
      : `${text.trim()}\nbase_url = "${proxyBaseUrl}"`
  }
  return text.trim() + '\n'
}

function buildClaudeSettings(provider, model, proxyBaseUrl = '') {
  let parsed = {}
  try { parsed = JSON.parse(provider.claudeSettings || '{}') } catch { parsed = {} }
  parsed.env = { ...(parsed.env || {}) }
  if (proxyBaseUrl || provider.baseUrl) parsed.env.ANTHROPIC_BASE_URL = proxyBaseUrl || provider.baseUrl
  if (model?.agent === 'claude') {
    parsed.env.ANTHROPIC_MODEL = model.name
    parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model.name
    parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model.name
    parsed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model.name
  }
  delete parsed.env.ANTHROPIC_AUTH_TOKEN
  return JSON.stringify(parsed, null, 2) + '\n'
}

function envKeyFromCodexConfig(text) {
  return text.match(/env_key\s*=\s*"([^"]+)"/)?.[1]
}

function commandParts(value) {
  const parts = String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []
  return parts.map((part) => part.replace(/^"|"$/g, ''))
}

async function startCaptureProxy(port) {
  if (proxyServer && proxyServerPort === port) return
  if (proxyServer) await new Promise((resolve) => proxyServer.close(resolve))

  proxyServerPort = port
  proxyServer = createServer((req, res) => {
    proxyRequest(req, res).catch((error) => {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error.message }))
    })
  })
  await new Promise((resolve) => proxyServer.listen(port, '127.0.0.1', resolve))
}

async function proxyRequest(req, res) {
  const context = activeProxyContext
  if (!context) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'proxy_context_not_ready' }))
    return
  }

  const started = Date.now()
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const requestBodyBuffer = Buffer.concat(chunks)
  const requestHeaders = normalizeHeaders(req.headers)
  const targetUrl = buildTargetUrl(context, req.url)
  const outboundHeaders = { ...requestHeaders, 'accept-encoding': 'identity' }
  delete outboundHeaders.host
  delete outboundHeaders.connection
  delete outboundHeaders['content-length']

  const upstream = await requestUpstream(targetUrl, req.method, outboundHeaders, ['GET', 'HEAD'].includes(req.method) ? undefined : requestBodyBuffer, context.proxyUrl)

  const responseHeaders = normalizeHeaders(upstream.headers)
  for (const [key, value] of Object.entries(responseHeaders)) {
    if (!['connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      res.setHeader(key, value)
    }
  }
  res.writeHead(upstream.statusCode)
  res.write(upstream.body)
  res.end()

  const responseBodyBuffer = upstream.body
  const clientBody = parseCapturedBody(requestBodyBuffer, requestHeaders['content-type'], context.saveBody)
  const providerBody = parseCapturedBody(responseBodyBuffer, responseHeaders['content-type'], context.saveBody)
  const exchange = {
    statusCode: upstream.statusCode,
    durationMs: Date.now() - started,
    client: {
      method: req.method,
      path: req.url,
      headers: requestHeaders,
      body: clientBody
    },
    forward: {
      url: targetUrl,
      headers: outboundHeaders,
      body: clientBody
    },
    provider: {
      headers: responseHeaders,
      body: providerBody
    }
  }
  context.exchanges.push({
    ...exchange,
    request: {
      method: req.method,
      url: req.url,
      targetUrl,
      headers: requestHeaders,
      body: clientBody
    },
    response: {
      headers: responseHeaders,
      body: providerBody
    },
    logDetail: toLogDetail(exchange)
  })
}

function requestUpstream(targetUrl, method, headers, body, proxyUrl = '') {
  const target = new URL(targetUrl)
  const client = target.protocol === 'https:' ? httpsRequest : httpRequest
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  return new Promise((resolve, reject) => {
    const upstreamReq = client(target, { method, headers, agent }, (upstreamRes) => {
      const chunks = []
      upstreamRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      upstreamRes.on('end', () => {
        resolve({
          statusCode: upstreamRes.statusCode || 502,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks)
        })
      })
    })
    upstreamReq.on('error', reject)
    if (body) upstreamReq.write(body)
    upstreamReq.end()
  })
}

function buildTargetUrl(context, requestUrl) {
  const incoming = new URL(requestUrl, context.proxyBaseUrl)
  const proxy = new URL(context.proxyBaseUrl)
  const upstream = new URL(context.upstreamBaseUrl)
  const proxyPath = proxy.pathname.replace(/\/$/, '')
  let suffix = incoming.pathname
  if (proxyPath && suffix.startsWith(proxyPath)) suffix = suffix.slice(proxyPath.length)
  if (!suffix.startsWith('/')) suffix = `/${suffix}`
  const upstreamPath = upstream.pathname.replace(/\/$/, '')
  return `${upstream.origin}${upstreamPath}${suffix === '/' ? '' : suffix}${incoming.search}`
}

function proxyBaseUrlFor(port, upstreamBaseUrl) {
  const upstream = new URL(upstreamBaseUrl)
  const path = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '')
  return `http://127.0.0.1:${port}${path}`
}

function runtimeBaseUrlFor(provider, agent) {
  const raw = String(provider.baseUrl || '').trim()
  if (!raw) return raw
  const url = new URL(raw)
  const path = url.pathname.replace(/\/+$/, '')
  const lower = path.toLowerCase()
  const endpointPattern = /\/(v\d+\/)?(responses|chat\/completions|messages|completions)$/
  const gatewayPrefixes = ['/compat', '/openai-compatible', '/openai-compat', '/litellm', '/proxy', '/gateway']
  if (!path || path === '/') {
    url.pathname = '/v1'
  } else if (/\/v\d+$/.test(lower) || endpointPattern.test(lower)) {
    url.pathname = path
  } else if (gatewayPrefixes.some((prefix) => lower.endsWith(prefix))) {
    url.pathname = path
  } else if (agent === 'claude' || agent === 'codex') {
    url.pathname = `${path}/v1`
  }
  return url.toString().replace(/\/$/, '')
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value ?? '')
    ])
  )
}

function parseCapturedBody(buffer, contentType = '', saveBody = true) {
  if (!saveBody) return '[body disabled]'
  const raw = buffer.toString('utf8')
  const text = raw.length > maxCapturedBodyChars
    ? `${raw.slice(0, maxCapturedBodyChars)}\n...[truncated ${raw.length - maxCapturedBodyChars} chars]`
    : raw
  if (contentType.includes('json')) {
    try { return JSON.parse(text) } catch { return text }
  }
  return text
}

function selectExchange(exchanges) {
  return [...exchanges].reverse().find((item) =>
    /responses|messages|chat\/completions|completions/i.test(item.request.url || '')
  ) || exchanges.at(-1)
}

function toLogDetail(exchange) {
  return {
    client_headers: exchange.client.headers,
    client_body: exchange.client.body,
    forward_url: exchange.forward.url,
    forward_headers: exchange.forward.headers,
    forward_body: exchange.forward.body,
    provider_headers: exchange.provider.headers,
    provider_body: exchange.provider.body
  }
}

function touchJob(job, patch) {
  if (!job) return
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function publicJob(job) {
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    target: job.target,
    total: job.total,
    completed: job.completed,
    success: job.success,
    failed: job.failed,
    currentProvider: job.currentProvider,
    currentAgent: job.currentAgent,
    currentModel: job.currentModel,
    stage: job.stage,
    message: job.message,
    error: job.error,
    runs: job.runs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    done: job.done
  }
}

function createJob(target = {}, scheduled = false) {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    status: 'queued',
    target,
    scheduled,
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    currentProvider: '',
    currentAgent: '',
    currentModel: '',
    stage: 'queued',
    message: '等待检测队列',
    error: '',
    runs: [],
    createdAt: now,
    updatedAt: now,
    done: false
  }
}

function runQueued(task) {
  const next = checkQueue.then(task, task)
  checkQueue = next.catch(() => undefined)
  return next
}

function enqueueCheck(target = {}) {
  const job = createJob(target)
  jobs.set(job.id, job)
  runQueued(async () => {
    touchJob(job, { status: 'running', stage: 'loading_state', message: '读取检测配置' })
    try {
      const result = await runChecks(target, false, job)
      touchJob(job, {
        status: 'completed',
        stage: 'completed',
        message: result.runs.length ? `检测完成：${result.runs.length} 条记录` : '没有可检测的模型',
        runs: result.runs,
        done: true
      })
    } catch (error) {
      touchJob(job, {
        status: 'failed',
        stage: 'failed',
        message: '检测任务失败',
        error: error.message,
        done: true
      })
    }
  })
  return job
}

async function runChecks(target = {}, scheduled = false, job = null) {
  const state = await loadState()
  if (scheduled && !state.settings.scheduleEnabled) return { state, runs: [] }
  const providers = state.providers.filter((provider) => provider.enabled && (!target.providerId || provider.id === target.providerId))
  const targets = providers.flatMap((provider) => {
    if (scheduled && !provider.scheduleEnabled) return []
    return provider.models
      .filter((item) => item.enabled)
      .filter((model) => !target.agent || model.agent === target.agent)
      .filter((model) => !target.modelName || model.name === target.modelName)
      .filter((model) => !(scheduled && model.scheduleEnabled === false))
      .filter((model) => !(model.agent === 'codex' && !provider.codexEnabled))
      .filter((model) => !(model.agent === 'claude' && !provider.claudeEnabled))
      .map((model) => ({ provider, model }))
  })
  const runs = []
  touchJob(job, {
    total: targets.length,
    completed: 0,
    success: 0,
    failed: 0,
    stage: targets.length ? 'running' : 'completed',
    message: targets.length ? `准备检测 ${targets.length} 个模型` : '没有可检测的模型'
  })

  for (const { provider, model } of targets) {
    touchJob(job, {
      currentProvider: provider.name,
      currentAgent: model.agent,
      currentModel: model.name,
      stage: 'cli_running',
      message: `正在检测 ${provider.name} / ${model.agent} / ${model.name}`
    })
    const run = await runOne(state, provider, model)
    runs.push(run)
    touchJob(job, {
      completed: runs.length,
      success: runs.filter((item) => item.state === 'success' || item.state === 'warning').length,
      failed: runs.filter((item) => item.state === 'failed' || item.state === 'timeout').length,
      stage: 'saving',
      message: `已完成 ${runs.length}/${targets.length}`
    })
  }

  if (!runs.length) return { state: await loadState(), runs }

  const latest = await updateState((current) => {
    current.runs = [...runs, ...current.runs].slice(0, 5000)
    const intervalMs = scheduleIntervalMs(current.settings)
    for (const run of runs) {
      const provider = current.providers.find((item) => item.id === run.providerId)
      if (!provider) continue
      provider.lastRunAt = run.createdAt
      provider.nextRunAt = current.settings.scheduleEnabled && provider.scheduleEnabled
        ? new Date(Date.now() + intervalMs).toISOString()
        : ''
      const model = provider.models.find((item) => item.agent === run.agent && item.name === run.model)
      if (!model) continue
      model.lastRunAt = run.createdAt
      if (scheduled) model.nextRunAt = new Date(Date.now() + intervalMs).toISOString()
    }
    return current
  })
  return { state: latest, runs }
}

async function runOne(state, provider, model) {
  const proxyPort = Number(state.settings.proxyPort || 7788)
  const runtimeBaseUrl = runtimeBaseUrlFor(provider, model.agent)
  const runtimeProvider = { ...provider, baseUrl: runtimeBaseUrl }
  const proxyBaseUrl = proxyBaseUrlFor(proxyPort, runtimeBaseUrl)
  await startCaptureProxy(proxyPort)
  await materializeProvider(runtimeProvider, model, proxyBaseUrl)
  const started = Date.now()
  const prompt = model.prompt || provider.prompt || state.settings.prompt || 'Hello'
  const base = providerBase(provider)
  const timeoutMs = Math.max(5, Number(provider.timeoutSeconds || 90)) * 1000
  const capture = {
    providerId: provider.id,
    agent: model.agent,
    model: model.name,
    upstreamBaseUrl: runtimeBaseUrl,
    proxyBaseUrl,
    proxyUrl: provider.proxyUrl || '',
    saveBody: provider.saveBody,
    exchanges: []
  }
  const commonEnv = {
    ...process.env,
    OPENAI_API_KEY: provider.apiKey || process.env.OPENAI_API_KEY,
    ANTHROPIC_AUTH_TOKEN: provider.apiKey || process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: provider.apiKey || process.env.ANTHROPIC_API_KEY
  }

  let result
  activeProxyContext = capture
  try {
    if (model.agent === 'codex') {
      const codexHome = join(base, 'codex-home')
      const [cmd, ...prefix] = commandParts(state.settings.codexCommand || 'codex')
      const envName = envKeyFromCodexConfig(buildCodexConfig(runtimeProvider, model, proxyBaseUrl))
      if (envName && provider.apiKey) commonEnv[envName] = provider.apiKey
      result = await execProcess(cmd, [...prefix, 'exec', '--skip-git-repo-check', '--json', prompt], {
        cwd: root,
        env: { ...commonEnv, CODEX_HOME: codexHome },
        timeoutMs
      })
    } else {
      const workspace = join(base, 'claude-workspace')
      const [cmd, ...prefix] = commandParts(state.settings.claudeCommand || 'claude')
      result = await execProcess(cmd, [...prefix, '-p', prompt], {
        cwd: workspace,
        env: {
          ...commonEnv,
          ANTHROPIC_BASE_URL: proxyBaseUrl,
          ANTHROPIC_MODEL: model.name,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model.name,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model.name,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model.name
        },
        timeoutMs
      })
    }
  } finally {
    if (activeProxyContext === capture) activeProxyContext = null
  }

  const latencyMs = Date.now() - started
  const exchange = selectExchange(capture.exchanges)
  const logDetail = exchange?.logDetail ?? {
    client_headers: buildRequest(runtimeProvider, model, prompt).headers,
    client_body: buildRequest(runtimeProvider, model, prompt).body,
    forward_url: runtimeBaseUrl,
    forward_headers: {},
    forward_body: provider.saveBody ? { model: model.name, prompt } : '[body disabled]',
    provider_headers: { 'x-cli-exit-code': String(result.exitCode ?? ''), 'x-cli-agent': model.agent },
    provider_body: provider.saveBody ? { stdout: result.stdout, stderr: result.stderr, note: 'no proxy exchange captured' } : '[body disabled]'
  }
  const hasText = result.stdout.trim().length > 0
  const timedOut = result.timedOut
  const ok = !timedOut && result.exitCode === 0 && hasText
  const runState = timedOut ? 'timeout' : ok ? 'success' : result.exitCode === 0 ? 'warning' : 'failed'
  const errorMessage = ok ? '' : timedOut ? 'CLI process timed out' : result.stderr.trim() || 'No valid text output'

  return {
    id: crypto.randomUUID(),
    providerId: provider.id,
    providerName: provider.name,
    model: model.name,
    agent: model.agent,
    state: runState,
    httpStatus: exchange?.statusCode ?? (timedOut ? null : ok || runState === 'warning' ? 200 : 500),
    cliExitCode: timedOut ? null : result.exitCode,
    latencyMs,
    createdAt: new Date().toISOString(),
    prompt,
    stdout: result.stdout,
    stderr: result.stderr,
    errorMessage,
    request: exchange?.request ?? buildRequest(runtimeProvider, model, prompt),
    response: exchange?.response ?? {
      headers: { 'x-cli-exit-code': String(result.exitCode ?? ''), 'x-cli-agent': model.agent },
      body: provider.saveBody ? { stdout: result.stdout, stderr: result.stderr, note: 'no proxy exchange captured' } : '[body disabled]'
    },
    logDetail,
    exchanges: capture.exchanges
  }
}

function buildRequest(provider, model, prompt) {
  const headers = {
    authorization: provider.apiKey ? `Bearer ${provider.apiKey}` : '',
    'content-type': 'application/json',
    'user-agent': model.agent === 'codex' ? 'codex-cli' : 'claude-code-cli'
  }
  const body = provider.saveBody ? { model: model.name, prompt, baseUrl: provider.baseUrl, agent: model.agent } : '[body disabled]'
  return { headers, body }
}

function execProcess(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      done = true
      child.kill('SIGTERM')
      resolve({ exitCode: null, stdout, stderr, timedOut: true })
    }, options.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, timedOut: false })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut: false })
    })
  })
}

async function scheduleTick() {
  if (scheduleRunning) return
  scheduleRunning = true
  try {
  const state = await loadState()
  if (!state.settings.scheduleEnabled) return
  const now = Date.now()
  const due = state.providers.filter((provider) => {
    if (!provider.enabled || !provider.scheduleEnabled) return false
    if (!provider.nextRunAt) return true
    return new Date(provider.nextRunAt).getTime() <= now
  })
  for (const provider of due) await runQueued(() => runChecks({ providerId: provider.id }, true))
  } finally {
    scheduleRunning = false
  }
}

async function serveStatic(req, res) {
  const dist = join(root, 'dist')
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const file = requested === '/' ? join(dist, 'index.html') : resolve(join(dist, requested))
  const finalFile = file.startsWith(dist) ? file : join(dist, 'index.html')
  try {
    await stat(finalFile)
    res.writeHead(200, { 'content-type': mime[extname(finalFile)] || 'application/octet-stream' })
    createReadStream(finalFile).pipe(res)
  } catch {
    createReadStream(join(dist, 'index.html')).pipe(res)
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/session') {
    return send(res, 200, { authenticated: isAuthenticated(req) })
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req)
    const state = await loadState()
    if (String(body.password || '') !== state.settings.adminPassword) {
      return send(res, 401, { error: 'invalid_password' })
    }
    const token = randomUUID()
    sessions.add(token)
    return send(res, 200, { ok: true }, {
      'set-cookie': `model_detect_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`
    })
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = sessionToken(req)
    if (token) sessions.delete(token)
    return send(res, 200, { ok: true }, {
      'set-cookie': 'model_detect_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'
    })
  }

  if (!isAuthenticated(req)) return send(res, 401, { error: 'unauthorized' })

  if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, publicState(await loadState()))
  if (req.method === 'GET' && pathname === '/api/logs') return send(res, 200, (await loadState()).runs)
  if (req.method === 'POST' && pathname === '/api/providers') return send(res, 200, publicState(await upsertProvider(await readJson(req))))
  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readJson(req)
    if (body.adminPassword === '') delete body.adminPassword
    const state = await updateState((current) => {
      current.settings = normalizeSettings({ ...current.settings, ...body })
      return current
    })
    return send(res, 200, publicState(state))
  }
  if (req.method === 'POST' && pathname === '/api/checks') {
    const body = await readJson(req)
    const job = enqueueCheck({
      providerId: body.providerId,
      agent: body.agent,
      modelName: body.modelName
    })
    return send(res, 202, { job: publicJob(job) })
  }
  const jobMatch = pathname.match(/^\/api\/checks\/([^/]+)$/)
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) return send(res, 404, { error: 'job_not_found' })
    return send(res, 200, { job: publicJob(job), state: job.done ? publicState(await loadState()) : undefined })
  }
  const deleteMatch = pathname.match(/^\/api\/providers\/([^/]+)$/)
  if (req.method === 'DELETE' && deleteMatch) return send(res, 200, publicState(await deleteProvider(deleteMatch[1])))
  send(res, 404, { error: 'not_found' })
}

await ensureData()
setInterval(() => scheduleTick().catch((error) => console.error(error)), schedulerMs)

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname)
    return await serveStatic(req, res)
  } catch (error) {
    send(res, 500, { error: error.message })
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`model-detect server listening on ${port}`)
})
