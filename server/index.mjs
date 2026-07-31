import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ProxyAgent } from 'proxy-agent'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDir = resolve(process.env.MODEL_DETECT_DATA_DIR || join(root, 'data'))
const stateFile = join(dataDir, 'state.json')
const runsFile = join(dataDir, 'runs.json')
const runsDir = join(dataDir, 'runs')
const runsSummaryFile = join(dataDir, 'runs-summary.json')
const port = Number(process.env.PORT || 5173)
const schedulerMs = 30_000
const maxCapturedBodyChars = 50_000
const maxStoredTextChars = 50_000
const maxCliOutputChars = 50_000
const maxCapturedExchanges = 3
const maxStoredRuns = 500
const maxRunSummaries = 1000
const maxInMemoryJobs = 100
const defaultTimeoutSeconds = 30
const defaultCodexInstruction = 'You are Codex, a coding agent based on GPT-5.\n'

const defaultCodexConfig = `model_reasoning_summary = "none"
model_reasoning_effort = "low"
model_verbosity = "low"
model = "gpt-5.5"
model_provider = "provider"
approval_policy = "never"
sandbox_mode = "read-only"
model_instructions_file = "~/.codex/instruction.md"

[model_providers.provider]
name = "Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
`

const legacyDefaultCodexConfig = `model = "gpt-5.5"
model_provider = "provider"
approval_policy = "never"
sandbox_mode = "read-only"
model_verbosity = "low"
model_reasoning_effort = "low"
model_reasoning_summary = "none"
model_instructions_file = "~/.codex/instruction.md"

[model_providers.provider]
name = "Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
`

const defaultClaudeSettings = `{
  "env": {
    "ANTHROPIC_BASE_URL": "https://example.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_MODEL": "",
    "MAX_THINKING_TOKENS": "0",
    "CLAUDE_CODE_EFFORT_LEVEL": "low",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1"
  }
}
`

const sessions = new Set()
const jobs = new Map()
const backupJobs = new Map()
const cliUpdatePromises = new Map()
const activeTargetChecks = new Map()
let stateWriteQueue = Promise.resolve()
let scheduleRunning = false
let updateRunning = false
let activeChecks = 0
const checkWaiters = []

const defaults = {
  providers: [],
  runs: [],
  settings: {
    codexCommand: 'codex',
    claudeCommand: 'claude',
    dataDir: './data',
    prompt: 'Hello',
    codexPrompt: 'Reply exactly: ok',
    claudePrompt: 'Reply exactly: ok',
    scheduleEnabled: false,
    scheduleDays: 0,
    scheduleHours: 0,
    scheduleMinutes: 30,
    proxyPort: 7788,
    defaultTimeoutSeconds,
    maxConcurrentChecks: 1,
    logRetentionDays: 30,
    redactLogs: true,
    defaultCodexConfig,
    defaultClaudeSettings,
    codexInstruction: defaultCodexInstruction,
    autoUpdateEnabled: true,
    autoUpdateIntervalDays: 4,
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
  await mkdir(runsDir, { recursive: true })
  try {
    await stat(stateFile)
  } catch {
    await saveState(defaults)
  }
  await migrateLegacyRuns()
}

async function migrateLegacyRuns() {
  try {
    const existing = await readdir(runsDir)
    if (existing.some((name) => name.endsWith('.json'))) return
  } catch {}

  let legacyRuns = []
  try {
    legacyRuns = JSON.parse(await readFile(runsFile, 'utf8'))
  } catch {
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
      legacyRuns = Array.isArray(parsed.runs) ? parsed.runs : []
    } catch {}
  }

  if (!Array.isArray(legacyRuns) || !legacyRuns.length) return
  await saveRuns(legacyRuns)
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await rename(runsFile, join(dataDir, `runs-legacy-${stamp}.json`))
  } catch {}
}

async function loadState(options = {}) {
  await ensureData()
  const includeRuns = options.includeRuns !== false
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
    const settings = normalizeSettings(parsed.settings)
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers.map((provider) => normalizeProvider(provider, settings.defaultTimeoutSeconds)) : [],
      runs: includeRuns ? await loadRuns(parsed) : [],
      settings
    }
  } catch {
    const fallback = structuredClone(defaults)
    if (!includeRuns) fallback.runs = []
    return fallback
  }
}

async function loadRuns(fallbackState = null) {
  const summaries = await loadRunSummaries(maxStoredRuns)
  const runs = []
  for (const summary of summaries) {
    const run = await loadRunDetail(summary.id)
    if (run) runs.push(run)
  }
  if (runs.length) return runs
  const legacyRuns = Array.isArray(fallbackState?.runs) ? fallbackState.runs : []
  if (legacyRuns.length) await saveRuns(legacyRuns)
  return legacyRuns
}

async function loadRunSummaries(limit = maxRunSummaries) {
  await mkdir(dataDir, { recursive: true })
  try {
    const parsed = JSON.parse(await readFile(runsSummaryFile, 'utf8'))
    return Array.isArray(parsed) ? parsed.slice(0, limit) : []
  } catch {
    const runs = await loadLegacyRuns()
    const summaries = runs.slice(0, limit).map(publicRunSummary)
    await saveRunSummaries(summaries)
    return summaries
  }
}

function normalizeSettings(settings = {}) {
  const merged = { ...defaults.settings, ...settings }
  const legacyPrompt = String(settings.prompt || '').trim()
  const codexPrompt = String(settings.codexPrompt || '').trim()
  merged.codexPrompt = codexPrompt && codexPrompt.toLowerCase() !== 'hello'
    ? codexPrompt
    : !codexPrompt && legacyPrompt && legacyPrompt.toLowerCase() !== 'hello'
      ? legacyPrompt
      : defaults.settings.codexPrompt
  merged.claudePrompt = String(
    settings.claudePrompt || (legacyPrompt && legacyPrompt.toLowerCase() !== 'hello' ? legacyPrompt : defaults.settings.claudePrompt)
  )
  merged.prompt = String(settings.prompt || merged.codexPrompt || defaults.settings.prompt)
  if (settings.scheduleDays === undefined && settings.scheduleHours === undefined) {
    const total = Math.max(0, Number(settings.scheduleMinutes || defaults.settings.scheduleMinutes))
    merged.scheduleDays = Math.floor(total / 1440)
    merged.scheduleHours = Math.floor((total % 1440) / 60)
    merged.scheduleMinutes = total % 60
  }
  merged.scheduleDays = Math.min(365, Math.max(0, Number(merged.scheduleDays || 0)))
  merged.scheduleHours = Math.min(23, Math.max(0, Number(merged.scheduleHours || 0)))
  merged.scheduleMinutes = Math.min(59, Math.max(0, Number(merged.scheduleMinutes || 0)))
  merged.autoUpdateEnabled = merged.autoUpdateEnabled !== false
  merged.autoUpdateIntervalDays = Math.min(365, Math.max(1, Number(merged.autoUpdateIntervalDays || 4)))
  merged.defaultTimeoutSeconds = Math.min(600, Math.max(5, Number(merged.defaultTimeoutSeconds || defaultTimeoutSeconds)))
  merged.maxConcurrentChecks = Math.min(3, Math.max(1, Number(merged.maxConcurrentChecks || 1)))
  merged.defaultCodexConfig = normalizeDefaultCodexConfig(merged.defaultCodexConfig)
  merged.defaultClaudeSettings = String(merged.defaultClaudeSettings || defaultClaudeSettings)
  merged.codexInstruction = normalizeTextFileContent(settings.codexInstruction, defaultCodexInstruction)
  merged.adminPassword = String(merged.adminPassword || 'admin')
  return merged
}

function normalizeTextFileContent(value, fallback) {
  const text = value === undefined || value === null ? fallback : String(value)
  return text.endsWith('\n') ? text : `${text}\n`
}

function normalizeDefaultCodexConfig(value) {
  let text = String(value || defaultCodexConfig)
  if (sameTomlLines(text, legacyDefaultCodexConfig)) text = defaultCodexConfig
  text = ensureTomlSetting(text, 'model_verbosity', '"low"')
  text = ensureTomlSetting(text, 'model_reasoning_effort', '"low"')
  text = ensureTomlSetting(text, 'model_reasoning_summary', '"none"')
  return text.trim() + '\n'
}

function sameTomlLines(left, right) {
  const normalize = (value) => String(value).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const leftLines = normalize(left)
  const rightLines = normalize(right)
  return leftLines.length === rightLines.length && leftLines.every((line, index) => line === rightLines[index])
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
  const { runs, ...persisted } = state
  await writeFile(stateFile, JSON.stringify(persisted, null, 2))
}

async function saveRuns(runs) {
  await mkdir(runsDir, { recursive: true })
  const limited = runs.slice(0, maxStoredRuns).map(pruneRunForStorage)
  await rm(runsDir, { recursive: true, force: true })
  await mkdir(runsDir, { recursive: true })
  for (const run of limited) await saveRunDetail(run)
  await saveRunSummaries(limited.slice(0, maxRunSummaries).map(publicRunSummary))
}

async function saveRunSummaries(summaries) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(runsSummaryFile, JSON.stringify(summaries.slice(0, maxRunSummaries), null, 2))
}

function pruneRunForStorage(run) {
  const { exchanges, logDetail, ...singleExchangeRun } = run
  const slim = {
    ...singleExchangeRun,
    request: {
      method: run.request?.method,
      url: run.request?.url,
      targetUrl: run.request?.targetUrl || logDetail?.forward_url,
      headers: {},
      body: run.request?.body ?? logDetail?.client_body
    },
    response: {
      headers: {},
      body: run.response?.body ?? logDetail?.provider_body
    }
  }
  return pruneLargeText(slim)
}

function runDetailPath(id) {
  return join(runsDir, `${safeId(id)}.json`)
}

async function saveRunDetail(run) {
  await mkdir(runsDir, { recursive: true })
  const detail = pruneRunForStorage(run)
  await writeFile(runDetailPath(detail.id), JSON.stringify(detail, null, 2))
}

async function loadRunDetail(id) {
  try {
    return JSON.parse(await readFile(runDetailPath(id), 'utf8'))
  } catch {}
  const legacy = await loadLegacyRuns()
  return legacy.find((run) => run.id === id) || null
}

async function loadLegacyRuns() {
  try {
    const parsed = JSON.parse(await readFile(runsFile, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function updateRunSummaries(mutator) {
  const next = stateWriteQueue.then(async () => {
    const summaries = await loadRunSummaries()
    const result = await mutator(summaries)
    const finalSummaries = result || summaries
    await saveRunSummaries(finalSummaries)
    return finalSummaries
  })
  stateWriteQueue = next.catch(() => undefined)
  return next
}

function pruneLargeText(value) {
  if (typeof value === 'string') {
    if (value.length <= maxStoredTextChars) return value
    return `${value.slice(0, maxStoredTextChars)}\n...[truncated ${value.length - maxStoredTextChars} chars for storage]`
  }
  if (Array.isArray(value)) return value.map(pruneLargeText)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pruneLargeText(entry)]))
  }
  return value
}

async function updateState(mutator) {
  const next = stateWriteQueue.then(async () => {
    const state = await loadState({ includeRuns: false })
    const result = await mutator(state)
    const finalState = result || state
    await saveState(finalState)
    return finalState
  })
  stateWriteQueue = next.catch(() => undefined)
  return next
}

async function runCliUpdate(target) {
  if (cliUpdatePromises.has(target)) return cliUpdatePromises.get(target)
  const args = target === 'codex'
    ? ['install', '-g', '@openai/codex', '--registry=https://registry.npmjs.org/']
    : ['install', '-g', '@anthropic-ai/claude-code@latest', '--registry=https://registry.npmjs.org/']
  const promise = new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(command, args, { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ ok: code === 0, output: output.slice(-5000) }))
  })
  cliUpdatePromises.set(target, promise)
  try {
    return await promise
  } finally {
    cliUpdatePromises.delete(target)
  }
}

function pruneJobMap(map) {
  while (map.size > maxInMemoryJobs) {
    const oldestDone = [...map].find(([, job]) => job.done)
    if (!oldestDone) return
    map.delete(oldestDone[0])
  }
}

async function updateRuns(mutator) {
  const next = stateWriteQueue.then(async () => {
    const runs = await loadRuns()
    const result = await mutator(runs)
    const finalRuns = result || runs
    await saveRuns(finalRuns)
    return finalRuns
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

function publicRunSummary(run) {
  return {
    id: run.id,
    providerId: run.providerId,
    providerName: run.providerName,
    model: run.model,
    agent: run.agent,
    state: run.state,
    httpStatus: run.httpStatus,
    cliExitCode: run.cliExitCode,
    latencyMs: run.latencyMs,
    createdAt: run.createdAt,
    prompt: run.prompt,
    errorMessage: run.errorMessage
  }
}

function publicState(state, options = {}) {
  const { adminPassword, ...settings } = state.settings
  const result = { providers: state.providers, settings }
  if (options.includeRuns !== false) result.runs = (options.runs || state.runs || []).map(publicRunSummary)
  return result
}

async function publicAppState(options = {}) {
  const state = await loadState({ includeRuns: false })
  if (options.includeRuns === false) return publicState(state, { includeRuns: false })
  return publicState(state, { runs: await loadRunSummaries(options.limit) })
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

function normalizeProvider(provider, timeoutDefault = defaultTimeoutSeconds) {
  const timeoutSeconds = Number(provider.timeoutSeconds || timeoutDefault || defaultTimeoutSeconds)
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
    timeoutSeconds: Math.min(600, Math.max(5, timeoutSeconds)),
    scheduleEnabled: provider.scheduleEnabled === true,
    saveBody: provider.saveBody !== false,
    models: Array.isArray(provider.models)
      ? provider.models.map((item) => ({
          id: item.id || modelId(item.agent, item.name),
          name: item.name,
          agent: item.agent,
          enabled: item.enabled !== false,
          prompt: item.prompt || '',
          scheduleEnabled: item.scheduleEnabled === true,
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
  return updateState(async (state) => {
    const next = normalizeProvider({
      ...provider,
      timeoutSeconds: provider.timeoutSeconds || state.settings.defaultTimeoutSeconds,
      codexConfig: provider.codexConfig || state.settings.defaultCodexConfig,
      claudeSettings: provider.claudeSettings || state.settings.defaultClaudeSettings
    }, state.settings.defaultTimeoutSeconds)
    await materializeProvider(next)
    const index = state.providers.findIndex((item) => item.id === next.id)
    if (index >= 0) state.providers.splice(index, 1, next)
    else state.providers.unshift(next)
    return state
  })
}

async function deleteProvider(id) {
  await rm(join(dataDir, 'providers', safeId(id)), { recursive: true, force: true })
  await removeRunRecords({ providerId: id })
  return updateState((current) => {
    current.providers = current.providers.filter((item) => item.id !== id)
    return current
  })
}

async function resetProviderConfig(body = {}) {
  const target = String(body.target || '')
  const providerId = String(body.providerId || '')
  return updateState(async (state) => {
    const providers = state.providers.filter((provider) => !providerId || provider.id === providerId)
    for (const provider of providers) {
      if (target === 'codex') provider.codexConfig = state.settings.defaultCodexConfig
      if (target === 'claude') provider.claudeSettings = state.settings.defaultClaudeSettings
      await materializeProvider(provider)
    }
    return state
  })
}

async function clearRuns(target = {}) {
  const providerId = target.providerId || ''
  const agent = target.agent || ''
  const modelName = target.modelName || ''
  const nextRuns = await removeRunRecords({ providerId, agent, modelName })

  const state = await updateState((state) => {
    if (!providerId) {
      state.providers.forEach(resetProviderRuns)
      return state
    }
    const provider = state.providers.find((item) => item.id === providerId)
    if (!provider) return state
    if (!agent || !modelName) {
      resetProviderRuns(provider)
      return state
    }

    const model = provider.models.find((item) => item.agent === agent && item.name === modelName)
    if (model) {
      model.lastRunAt = ''
      model.nextRunAt = ''
    }
    const latestProviderRun = latestRun(nextRuns, providerId)
    provider.lastRunAt = latestProviderRun?.createdAt || ''
    if (!latestProviderRun) provider.nextRunAt = ''
    return state
  })
  return state
}

async function removeRunRecords(target = {}) {
  const providerId = target.providerId || ''
  const agent = target.agent || ''
  const modelName = target.modelName || ''
  const removed = []
  const nextSummaries = await updateRunSummaries((summaries) => {
    const kept = summaries.filter((run) => {
      const matched = !providerId
        || (run.providerId === providerId && (!agent || !modelName || (run.agent === agent && run.model === modelName)))
      if (matched) removed.push(run.id)
      return !matched
    })
    return kept
  })
  for (const id of removed) await rm(runDetailPath(id), { force: true })
  if (!providerId) {
    await rm(runsDir, { recursive: true, force: true })
    await mkdir(runsDir, { recursive: true })
  }
  return nextSummaries
}

async function updateScheduleSettings(body = {}) {
  return updateState((state) => {
    state.settings = normalizeSettings({
      ...state.settings,
      scheduleEnabled: body.scheduleEnabled === true,
      scheduleDays: Number(body.scheduleDays || 0),
      scheduleHours: Number(body.scheduleHours || 0),
      scheduleMinutes: Number(body.scheduleMinutes || 0)
    })
    if (!state.settings.scheduleEnabled) {
      state.providers.forEach((provider) => {
        provider.nextRunAt = ''
        provider.models.forEach((model) => {
          model.nextRunAt = ''
        })
      })
    } else {
      const nextRunAt = new Date(Date.now() + scheduleIntervalMs(state.settings)).toISOString()
      state.providers.forEach((provider) => {
        provider.nextRunAt = provider.enabled && provider.scheduleEnabled ? nextRunAt : ''
        provider.models.forEach((model) => {
          model.nextRunAt = provider.enabled && provider.scheduleEnabled && model.enabled && model.scheduleEnabled !== false
            ? nextRunAt
            : ''
        })
      })
    }
    return state
  })
}

async function updateProviderSchedule(body = {}) {
  const providerId = String(body.providerId || '')
  const enabled = body.scheduleEnabled === true
  return updateState((state) => {
    const provider = state.providers.find((item) => item.id === providerId)
    if (!provider) return state
    provider.scheduleEnabled = enabled
    if (!enabled) {
      provider.nextRunAt = ''
      provider.models.forEach((model) => {
        model.nextRunAt = ''
      })
    } else if (state.settings.scheduleEnabled && provider.enabled) {
      const nextRunAt = new Date(Date.now() + scheduleIntervalMs(state.settings)).toISOString()
      provider.nextRunAt = nextRunAt
      provider.models.forEach((model) => {
        model.nextRunAt = model.enabled && model.scheduleEnabled !== false ? nextRunAt : ''
      })
    }
    return state
  })
}

async function updateModelSchedule(body = {}) {
  const providerId = String(body.providerId || '')
  const agent = body.agent
  const modelName = String(body.modelName || '')
  const enabled = body.scheduleEnabled === true
  return updateState((state) => {
    const provider = state.providers.find((item) => item.id === providerId)
    const model = provider?.models.find((item) => item.agent === agent && item.name === modelName)
    if (model) {
      model.scheduleEnabled = enabled
      model.nextRunAt = enabled && state.settings.scheduleEnabled && provider?.enabled && provider.scheduleEnabled
        ? new Date(Date.now() + scheduleIntervalMs(state.settings)).toISOString()
        : ''
    }
    return state
  })
}

async function exportBackup() {
  const state = await loadState({ includeRuns: false })
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    state: {
      providers: state.providers,
      settings: state.settings
    },
    runsIncluded: false
  }
}

async function importBackup(body = {}) {
  const backup = body.backup || body
  if (!backup || typeof backup !== 'object') throw new Error('invalid_backup')
  const sourceState = backup.state && typeof backup.state === 'object' ? backup.state : backup
  const settings = normalizeSettings(sourceState.settings || {})
  const providers = Array.isArray(sourceState.providers)
      ? sourceState.providers.map((provider) => normalizeProvider({
        ...provider,
        timeoutSeconds: provider.timeoutSeconds || settings.defaultTimeoutSeconds,
        codexConfig: provider.codexConfig || settings.defaultCodexConfig,
        claudeSettings: provider.claudeSettings || settings.defaultClaudeSettings
      }, settings.defaultTimeoutSeconds))
    : []

  const next = stateWriteQueue.then(async () => {
    await rm(join(dataDir, 'providers'), { recursive: true, force: true })
    const imported = { providers, settings, runs: [] }
    await saveState(imported)
    await saveRuns([])
    for (const provider of providers) await materializeProvider(provider)
    return imported
  })
  stateWriteQueue = next.catch(() => undefined)
  return next
}

function createBackupJob() {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    status: 'queued',
    stage: 'queued',
    message: '等待导入',
    total: 1,
    completed: 0,
    error: '',
    createdAt: now,
    updatedAt: now,
    done: false
  }
}

function touchBackupJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function publicBackupJob(job) {
  return job ? { ...job } : null
}

function enqueueBackupImport(body = {}) {
  const job = createBackupJob()
  backupJobs.set(job.id, job)
  pruneJobMap(backupJobs)
  Promise.resolve().then(() => runBackupImportJob(job, body)).catch((error) => {
    touchBackupJob(job, {
      status: 'failed',
      stage: 'failed',
      message: '导入失败',
      error: error.message,
      done: true
    })
  })
  return job
}

async function runBackupImportJob(job, body = {}) {
  const backup = body.backup || body
  if (!backup || typeof backup !== 'object') throw new Error('invalid_backup')
  const sourceState = backup.state && typeof backup.state === 'object' ? backup.state : backup
  const settings = normalizeSettings(sourceState.settings || {})
  const providers = Array.isArray(sourceState.providers)
      ? sourceState.providers.map((provider) => normalizeProvider({
        ...provider,
        timeoutSeconds: provider.timeoutSeconds || settings.defaultTimeoutSeconds,
        codexConfig: provider.codexConfig || settings.defaultCodexConfig,
        claudeSettings: provider.claudeSettings || settings.defaultClaudeSettings
      }, settings.defaultTimeoutSeconds))
    : []

  touchBackupJob(job, {
    status: 'running',
    stage: 'saving_state',
    message: '保存配置并清空检测记录',
    total: providers.length + 2,
    completed: 0
  })

  const next = stateWriteQueue.then(async () => {
    await rm(join(dataDir, 'providers'), { recursive: true, force: true })
    const imported = { providers, settings, runs: [] }
    await saveState(imported)
    await saveRuns([])
    touchBackupJob(job, {
      stage: 'rebuilding_provider_configs',
      message: providers.length ? '重建模型提供商配置目录' : '没有模型提供商需要重建',
      completed: 1
    })
    for (const [index, provider] of providers.entries()) {
      touchBackupJob(job, {
        stage: 'rebuilding_provider_configs',
        message: `重建 ${provider.name || provider.id}`,
        completed: index + 2
      })
      await materializeProvider(provider)
    }
    touchBackupJob(job, {
      status: 'completed',
      stage: 'completed',
      message: '导入完成',
      completed: providers.length + 2,
      done: true
    })
    return imported
  })
  stateWriteQueue = next.catch(() => undefined)
  await next
}

function resetProviderRuns(provider) {
  provider.lastRunAt = ''
  provider.nextRunAt = ''
  provider.models.forEach((model) => {
    model.lastRunAt = ''
    model.nextRunAt = ''
  })
}

function latestRun(runs, providerId) {
  return runs
    .filter((run) => run.providerId === providerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
}

async function materializeProvider(provider, model, proxyBaseUrl = '', base = providerBase(provider)) {
  const codexHome = join(base, 'codex-home')
  const claudeWorkspace = join(base, 'claude-workspace')
  await mkdir(codexHome, { recursive: true })
  await mkdir(join(claudeWorkspace, '.claude'), { recursive: true })
  await writeFile(join(codexHome, 'config.toml'), buildCodexConfig(provider, model, proxyBaseUrl), 'utf8')
  await writeFile(join(claudeWorkspace, '.claude', 'settings.json'), buildClaudeSettings(provider, model, proxyBaseUrl), 'utf8')
}

function buildCodexConfig(provider, model, proxyBaseUrl = '') {
  let text = provider.codexConfig || ''
  text = ensureTomlSetting(text, 'model_verbosity', '"low"')
  text = ensureTomlSetting(text, 'model_reasoning_effort', '"low"')
  text = ensureTomlSetting(text, 'model_reasoning_summary', '"none"')
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

function hasCodexInstructionFile(text) {
  return /model_instructions_file\s*=/m.test(text || '')
}

function isCodexInstructionMissing(result) {
  const message = `${result?.stdout || ''}\n${result?.stderr || ''}`
  return /failed to read model instructions file/i.test(message) && /instruction\.md/i.test(message)
}

async function ensureCodexInstructionFile(settings) {
  const dir = join(homedir(), '.codex')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'instruction.md'), normalizeTextFileContent(settings.codexInstruction, defaultCodexInstruction), 'utf8')
}

function ensureTomlSetting(text, key, value) {
  if (new RegExp(`^${key}\\s*=`, 'm').test(text)) return text
  return `${key} = ${value}\n${text}`
}

function buildClaudeSettings(provider, model, proxyBaseUrl = '') {
  let parsed = {}
  try { parsed = JSON.parse(provider.claudeSettings || '{}') } catch { parsed = {} }
  parsed.env = { ...(parsed.env || {}) }
  if (proxyBaseUrl || provider.baseUrl) parsed.env.ANTHROPIC_BASE_URL = proxyBaseUrl || provider.baseUrl
  parsed.env.MAX_THINKING_TOKENS = parsed.env.MAX_THINKING_TOKENS || '0'
  parsed.env.CLAUDE_CODE_EFFORT_LEVEL = parsed.env.CLAUDE_CODE_EFFORT_LEVEL || 'low'
  parsed.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = parsed.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY || '1'
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

function promptFor(settings, provider, model) {
  const globalPrompt = model.agent === 'claude' ? settings.claudePrompt : settings.codexPrompt
  return model.prompt || provider.prompt || globalPrompt || settings.prompt || 'Hello'
}

async function createCaptureProxy(capture) {
  const sockets = new Set()
  let closed = false
  const server = createServer((req, res) => {
    if (capture.signal?.aborted) {
      res.destroy()
      return
    }
    proxyRequest(req, res, capture).catch((error) => {
      if (isCheckCancelled(error) || capture.signal?.aborted || res.destroyed) return
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error.message }))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const close = () => {
    if (closed) return Promise.resolve()
    closed = true
    capture.signal?.removeEventListener('abort', close)
    for (const socket of sockets) socket.destroy()
    return new Promise((resolve) => server.close(() => resolve()))
  }
  capture.signal?.addEventListener('abort', close, { once: true })
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close
  }
}

async function proxyRequest(req, res, context) {
  throwIfCheckCancelled(context.signal)
  const started = Date.now()
  const requestBodyBuffer = await readProxyRequestBody(req, context.signal)
  throwIfCheckCancelled(context.signal)
  const requestHeaders = normalizeHeaders(req.headers)
  const targetUrl = buildTargetUrl(context, req.url)
  const outboundHeaders = { ...requestHeaders, 'accept-encoding': 'identity' }
  delete outboundHeaders.host
  delete outboundHeaders.connection
  delete outboundHeaders['content-length']
  applyProviderAuthHeaders(outboundHeaders, context)

  let responseHeaders = {}
  let responseStarted = false
  const upstream = await requestUpstream(
    targetUrl,
    req.method,
    outboundHeaders,
    ['GET', 'HEAD'].includes(req.method) ? undefined : requestBodyBuffer,
    context.proxyUrl,
    context.timeoutMs,
    {
      onResponse: (statusCode, headers) => {
        if (context.signal?.aborted || res.destroyed) return
        responseHeaders = normalizeHeaders(headers)
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (!['connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
            res.setHeader(key, value)
          }
        }
        res.writeHead(statusCode)
        responseStarted = true
      },
      onData: (chunk) => {
        if (!context.signal?.aborted && !res.destroyed) res.write(chunk)
      }
    },
    context.signal
  )
  throwIfCheckCancelled(context.signal)

  if (!responseStarted) {
    responseHeaders = normalizeHeaders(upstream.headers)
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (!['connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value)
      }
    }
    res.writeHead(upstream.statusCode)
    res.write(upstream.body)
  }
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
      body: clientBody
    },
    forward: {
      url: targetUrl,
      body: clientBody
    },
    provider: {
      body: providerBody
    }
  }
  context.exchanges.push({
    ...exchange,
    request: {
      method: req.method,
      url: req.url,
      targetUrl,
      headers: {},
      body: clientBody
    },
    response: {
      headers: {},
      body: providerBody
    },
    logDetail: toLogDetail(exchange)
  })
  if (context.exchanges.length > maxCapturedExchanges) context.exchanges.splice(0, context.exchanges.length - maxCapturedExchanges)
}

async function readProxyRequestBody(req, signal) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    throwIfCheckCancelled(signal)
    size += chunk.length
    if (size > 1_000_000) throw new Error('proxy_request_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function requestUpstream(targetUrl, method, headers, body, proxyUrl = '', timeoutMs = 90_000, hooks = {}, signal) {
  throwIfCheckCancelled(signal)
  const target = new URL(targetUrl)
  const client = target.protocol === 'https:' ? httpsRequest : httpRequest
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  return new Promise((resolve, reject) => {
    let settled = false
    let upstreamReq
    let upstreamRes
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const finish = (value, error = null) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      upstreamRes?.destroy()
      upstreamReq?.destroy()
      finish(null, new CheckCancelledError())
    }
    signal?.addEventListener('abort', abort, { once: true })
    upstreamReq = client(target, { method, headers, agent }, (response) => {
      upstreamRes = response
      if (signal?.aborted) return abort()
      upstreamRes.on('error', (error) => {
        if (signal?.aborted) return finish(null, new CheckCancelledError())
        finish({
          statusCode: 502,
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-model-detect-proxy-error': error.message },
          body: Buffer.from(JSON.stringify({ error: error.message, type: 'upstream_error' }))
        })
      })
      hooks.onResponse?.(upstreamRes.statusCode || 502, upstreamRes.headers)
      const chunks = []
      let captured = 0
      let truncated = 0
      upstreamRes.on('data', (chunk) => {
        hooks.onData?.(chunk)
        const remaining = maxCapturedBodyChars - captured
        if (remaining > 0) {
          const part = Buffer.from(chunk.slice(0, remaining))
          chunks.push(part)
          captured += part.length
        }
        if (chunk.length > remaining) truncated += chunk.length - Math.max(0, remaining)
      })
      upstreamRes.on('end', () => {
        if (truncated > 0) chunks.push(Buffer.from(`\n...[truncated ${truncated} bytes]`))
        finish({
          statusCode: upstreamRes.statusCode || 502,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks)
        })
      })
    })
    upstreamReq.setTimeout(Math.max(1000, Number(timeoutMs || 90_000)), () => {
      upstreamReq.destroy(new Error('upstream_timeout'))
    })
    upstreamReq.on('error', (error) => {
      if (signal?.aborted) return finish(null, new CheckCancelledError())
      const timedOut = error.message === 'upstream_timeout'
      finish({
        statusCode: timedOut ? 504 : 502,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-model-detect-proxy-error': error.message },
        body: Buffer.from(JSON.stringify({ error: error.message, type: timedOut ? 'upstream_timeout' : 'upstream_error' }))
      })
    })
    if (body) upstreamReq.write(body)
    upstreamReq.end()
    if (signal?.aborted) abort()
  })
}

function applyProviderAuthHeaders(headers, context) {
  const apiKey = String(context.apiKey || '').trim()
  if (!apiKey) return
  headers.authorization = `Bearer ${apiKey}`
  if (context.agent === 'claude') headers['x-api-key'] = apiKey
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
  const path = stripKnownEndpointPath(url.pathname)
  url.search = ''
  url.hash = ''
  if (agent === 'claude') {
    url.pathname = stripTrailingVersionPath(path) || '/'
  } else if (agent === 'codex') {
    url.pathname = ensureTrailingVersionPath(path)
  }
  return url.toString().replace(/\/$/, '')
}

function stripKnownEndpointPath(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean)
  const lower = segments.map((item) => item.toLowerCase())
  if (lower.at(-2) === 'chat' && lower.at(-1) === 'completions') segments.splice(-2, 2)
  else if (['responses', 'messages', 'completions'].includes(lower.at(-1))) segments.pop()
  return segments.length ? `/${segments.join('/')}` : ''
}

function stripTrailingVersionPath(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean)
  if (/^v\d+$/i.test(segments.at(-1) || '')) segments.pop()
  return segments.length ? `/${segments.join('/')}` : ''
}

function ensureTrailingVersionPath(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean)
  if (!/^v\d+$/i.test(segments.at(-1) || '')) segments.push('v1')
  return `/${segments.join('/')}`
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
    client_body: exchange.client.body,
    forward_url: exchange.forward.url,
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
    cancelled: job.cancelled,
    currentProvider: job.currentProvider,
    currentAgent: job.currentAgent,
    currentModel: job.currentModel,
    stage: job.stage,
    message: job.message,
    error: job.error,
    runs: (job.runs || []).map(publicRunSummary),
    items: job.items,
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
    cancelled: 0,
    currentProvider: '',
    currentAgent: '',
    currentModel: '',
    stage: 'queued',
    message: '等待检测队列',
    error: '',
    runs: [],
    items: [],
    createdAt: now,
    updatedAt: now,
    done: false
  }
}

function runItemStatus(run) {
  if (run.state === 'timeout') return 'timeout'
  if (run.state === 'success' || run.state === 'warning') return 'success'
  return 'failed'
}

function jobItemFromTarget(provider, model) {
  return {
    id: `${provider.id}:${model.agent}:${model.name}`,
    providerId: provider.id,
    providerName: provider.name,
    agent: model.agent,
    model: model.name,
    status: 'queued',
    httpStatus: null,
    cliExitCode: null,
    latencyMs: 0,
    errorMessage: '',
    runId: ''
  }
}

class CheckCancelledError extends Error {
  constructor() {
    super('check_cancelled')
    this.name = 'CheckCancelledError'
  }
}

function isCheckCancelled(error) {
  return error instanceof CheckCancelledError || error?.name === 'AbortError' || error?.message === 'check_cancelled'
}

function throwIfCheckCancelled(signal) {
  if (signal?.aborted) throw new CheckCancelledError()
}

function targetKey(providerId, agent, modelName) {
  return `${providerId}:${agent}:${modelName}`
}

function checkTargets(state, target = {}, scheduled = false) {
  return state.providers
    .filter((provider) => provider.enabled && (!target.providerId || provider.id === target.providerId))
    .flatMap((provider) => {
      if (scheduled && !provider.scheduleEnabled) return []
      return provider.models
        .filter((model) => model.enabled)
        .filter((model) => !target.agent || model.agent === target.agent)
        .filter((model) => !target.modelName || model.name === target.modelName)
        .filter((model) => !(scheduled && model.scheduleEnabled === false))
        .filter((model) => !(model.agent === 'codex' && !provider.codexEnabled))
        .filter((model) => !(model.agent === 'claude' && !provider.claudeEnabled))
        .map((model) => ({ provider, model }))
    })
}

function createTargetControl(provider, model, job = null) {
  return {
    key: targetKey(provider.id, model.agent, model.name),
    jobId: job?.id || '',
    controller: new AbortController(),
    runId: ''
  }
}

function updateJobItem(job, itemId, patch) {
  if (!job) return
  const item = job.items.find((entry) => entry.id === itemId)
  if (item) Object.assign(item, patch)
  const completedItems = job.items.filter((entry) => ['success', 'failed', 'timeout', 'cancelled'].includes(entry.status))
  touchJob(job, {
    completed: completedItems.length,
    success: job.items.filter((entry) => entry.status === 'success').length,
    failed: job.items.filter((entry) => entry.status === 'failed' || entry.status === 'timeout').length,
    cancelled: job.items.filter((entry) => entry.status === 'cancelled').length
  })
}

async function acquireCheckSlot(maxConcurrent, signal) {
  throwIfCheckCancelled(signal)
  const limit = Math.min(10, Math.max(1, Number(maxConcurrent || 3)))
  if (activeChecks < limit) {
    activeChecks += 1
    return
  }
  await new Promise((resolve, reject) => {
    const waiter = {
      resolve: () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
    }
    const abort = () => {
      const index = checkWaiters.indexOf(waiter)
      if (index >= 0) checkWaiters.splice(index, 1)
      reject(new CheckCancelledError())
    }
    signal?.addEventListener('abort', abort, { once: true })
    checkWaiters.push(waiter)
  })
  if (signal?.aborted) {
    wakeNextCheckWaiter()
    throw new CheckCancelledError()
  }
  activeChecks += 1
}

function releaseCheckSlot() {
  activeChecks = Math.max(0, activeChecks - 1)
  wakeNextCheckWaiter()
}

function wakeNextCheckWaiter() {
  const next = checkWaiters.shift()
  if (next) next.resolve()
}

async function runWithCheckSlot(maxConcurrent, signal, task) {
  await acquireCheckSlot(maxConcurrent, signal)
  try {
    return await task()
  } finally {
    releaseCheckSlot()
  }
}

async function enqueueCheck(target = {}, scheduled = false) {
  const state = await loadState({ includeRuns: false })
  const requestedTargets = state.settings.scheduleEnabled || !scheduled ? checkTargets(state, target, scheduled) : []
  const availableTargets = requestedTargets.filter(({ provider, model }) =>
    !activeTargetChecks.has(targetKey(provider.id, model.agent, model.name))
  )
  if (requestedTargets.length && !availableTargets.length) {
    const existing = activeTargetChecks.get(targetKey(
      requestedTargets[0].provider.id,
      requestedTargets[0].model.agent,
      requestedTargets[0].model.name
    ))
    const existingJob = existing?.jobId ? jobs.get(existing.jobId) : null
    if (existingJob && !existingJob.done) return { job: existingJob, reused: true }
  }

  const job = createJob(target, scheduled)
  const controls = availableTargets.map(({ provider, model }) => {
    const control = createTargetControl(provider, model, job)
    activeTargetChecks.set(control.key, control)
    return control
  })
  job.items = availableTargets.map(({ provider, model }) => jobItemFromTarget(provider, model))
  job.total = job.items.length
  jobs.set(job.id, job)
  pruneJobMap(jobs)
  Promise.resolve().then(async () => {
    touchJob(job, { status: 'running', stage: 'loading_state', message: '读取检测配置' })
    try {
      const result = await runChecks(target, scheduled, job, { state, targets: availableTargets, controls })
      const fullyCancelled = result.cancelled > 0 && !result.runs.length && job.failed === 0
      touchJob(job, {
        status: fullyCancelled ? 'cancelled' : 'completed',
        stage: fullyCancelled ? 'cancelled' : 'completed',
        message: fullyCancelled
          ? '检测已取消，未生成记录'
          : result.runs.length
            ? `检测完成：${result.runs.length} 条记录${result.cancelled ? `，取消 ${result.cancelled} 项` : ''}`
            : requestedTargets.length && !availableTargets.length
              ? '相同模型正在检测'
              : '没有可检测的模型',
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
  return { job, reused: false }
}

async function runChecks(target = {}, scheduled = false, job = null, prepared = null) {
  const state = prepared?.state || await loadState({ includeRuns: false })
  if (scheduled && !state.settings.scheduleEnabled) return { state, runs: [] }
  const requestedTargets = prepared?.targets || checkTargets(state, target, scheduled)
  const targets = []
  const controls = []
  requestedTargets.forEach(({ provider, model }, index) => {
    const key = targetKey(provider.id, model.agent, model.name)
    const preparedControl = prepared?.controls?.[index]
    if (preparedControl) {
      targets.push({ provider, model })
      controls.push(preparedControl)
      return
    }
    if (activeTargetChecks.has(key)) return
    const control = createTargetControl(provider, model, job)
    activeTargetChecks.set(key, control)
    targets.push({ provider, model })
    controls.push(control)
  })
  const runs = []
  const items = job?.items?.length ? job.items : targets.map(({ provider, model }) => jobItemFromTarget(provider, model))
  touchJob(job, {
    total: targets.length,
    completed: 0,
    success: 0,
    failed: 0,
    items,
    stage: targets.length ? 'running' : 'completed',
    message: targets.length ? `准备检测 ${targets.length} 个模型` : '没有可检测的模型'
  })

  const maxConcurrent = state.settings.maxConcurrentChecks || 1
  await Promise.all(targets.map(({ provider, model }, index) => {
    const control = controls[index]
    return runWithCheckSlot(maxConcurrent, control.controller.signal, async () => {
      const itemId = control.key
      throwIfCheckCancelled(control.controller.signal)
      updateJobItem(job, itemId, { status: 'running' })
      touchJob(job, {
        currentProvider: provider.name,
        currentAgent: model.agent,
        currentModel: model.name,
        stage: 'cli_running',
        message: `正在检测 ${provider.name} / ${model.agent} / ${model.name}`
      })
      let run = null
      try {
        run = await runOne(state, provider, model, control.controller.signal)
        control.runId = run.id
        throwIfCheckCancelled(control.controller.signal)
        await saveRun(run, scheduled, control.controller.signal)
        throwIfCheckCancelled(control.controller.signal)
        runs.push(run)
        updateJobItem(job, itemId, {
          status: runItemStatus(run),
          httpStatus: run.httpStatus,
          cliExitCode: run.cliExitCode,
          latencyMs: run.latencyMs,
          errorMessage: run.errorMessage,
          runId: run.id
        })
      } catch (error) {
        if (isCheckCancelled(error) || control.controller.signal.aborted) {
          if (control.runId) await removeRunById(control.runId, provider.id, model.agent, model.name)
          updateJobItem(job, itemId, { status: 'cancelled', errorMessage: '' })
        } else {
          updateJobItem(job, itemId, { status: 'failed', errorMessage: error.message })
        }
      } finally {
        if (activeTargetChecks.get(control.key) === control) activeTargetChecks.delete(control.key)
      }
      if (job) {
        touchJob(job, {
          stage: 'running',
          message: `已完成 ${job.completed}/${targets.length}`
        })
      }
    }).catch(async (error) => {
      if (isCheckCancelled(error) || control.controller.signal.aborted) {
        updateJobItem(job, control.key, { status: 'cancelled', errorMessage: '' })
        if (activeTargetChecks.get(control.key) === control) activeTargetChecks.delete(control.key)
        return
      }
      throw error
    })
  }))

  return {
    state: await loadState({ includeRuns: false }),
    runs,
    cancelled: job?.cancelled || controls.filter((control) => control.controller.signal.aborted).length
  }
}

async function saveRun(run, scheduled = false, signal) {
  throwIfCheckCancelled(signal)
  await saveRunDetail(run)
  throwIfCheckCancelled(signal)
  let dropped = []
  await updateRunSummaries((summaries) => {
    throwIfCheckCancelled(signal)
    const merged = [
      publicRunSummary(run),
      ...summaries.filter((item) => item.id !== run.id)
    ]
    dropped = merged.slice(maxStoredRuns).map((item) => item.id)
    return merged.slice(0, maxStoredRuns)
  })
  throwIfCheckCancelled(signal)
  for (const id of dropped) await rm(runDetailPath(id), { force: true })
  return updateState((current) => {
    throwIfCheckCancelled(signal)
    const intervalMs = scheduleIntervalMs(current.settings)
    const provider = current.providers.find((item) => item.id === run.providerId)
    if (provider) {
      provider.lastRunAt = run.createdAt
      if (scheduled) provider.nextRunAt = current.settings.scheduleEnabled && provider.scheduleEnabled
        ? new Date(Date.now() + intervalMs).toISOString()
        : ''
      const model = provider.models.find((item) => item.agent === run.agent && item.name === run.model)
      if (model) {
        model.lastRunAt = run.createdAt
        if (scheduled) model.nextRunAt = new Date(Date.now() + intervalMs).toISOString()
      }
    }
    return current
  })
}

async function removeRunById(runId, providerId, agent, modelName) {
  const summaries = await updateRunSummaries((items) => items.filter((item) => item.id !== runId))
  await rm(runDetailPath(runId), { force: true })
  await updateState((state) => {
    const provider = state.providers.find((item) => item.id === providerId)
    if (!provider) return state
    const model = provider.models.find((item) => item.agent === agent && item.name === modelName)
    if (model) {
      model.lastRunAt = summaries.find((item) => item.providerId === providerId && item.agent === agent && item.model === modelName)?.createdAt || ''
    }
    provider.lastRunAt = summaries.find((item) => item.providerId === providerId)?.createdAt || ''
    return state
  })
}

function cancelCheckJob(job, target = {}) {
  if (!job || job.done) return 0
  const controls = [...activeTargetChecks.values()].filter((control) => {
    if (control.jobId !== job.id) return false
    const item = job.items.find((entry) => entry.id === control.key)
    return item
      && (!target.providerId || item.providerId === target.providerId)
      && (!target.agent || item.agent === target.agent)
      && (!target.modelName || item.model === target.modelName)
  })
  controls.forEach((control) => control.controller.abort())
  if (controls.length) touchJob(job, { stage: 'cancelling', message: `正在取消 ${controls.length} 个检测` })
  return controls.length
}

async function runOne(state, provider, model, signal) {
  throwIfCheckCancelled(signal)
  const runId = randomUUID()
  const runtimeBaseUrl = runtimeBaseUrlFor(provider, model.agent)
  const runtimeProvider = { ...provider, baseUrl: runtimeBaseUrl }
  const started = Date.now()
  const prompt = promptFor(state.settings, provider, model)
  const base = providerBase(provider)
  const runBase = join(base, 'run-contexts', safeId(runId))
  const timeoutMs = Math.max(5, Number(provider.timeoutSeconds || state.settings.defaultTimeoutSeconds || defaultTimeoutSeconds)) * 1000
  const capture = {
    providerId: provider.id,
    agent: model.agent,
    model: model.name,
    apiKey: provider.apiKey || '',
    upstreamBaseUrl: runtimeBaseUrl,
    proxyBaseUrl: '',
    proxyUrl: provider.proxyUrl || '',
    saveBody: provider.saveBody,
    timeoutMs: Math.max(1000, timeoutMs - 3000),
    signal,
    exchanges: []
  }
  const proxy = await createCaptureProxy(capture)
  let result
  try {
    throwIfCheckCancelled(signal)
    const proxyBaseUrl = proxyBaseUrlFor(proxy.port, runtimeBaseUrl)
    capture.proxyBaseUrl = proxyBaseUrl
    await materializeProvider(runtimeProvider, model, proxyBaseUrl, runBase)
    throwIfCheckCancelled(signal)
    const commonEnv = {
      ...process.env,
      OPENAI_API_KEY: provider.apiKey || process.env.OPENAI_API_KEY,
      ANTHROPIC_AUTH_TOKEN: provider.apiKey || process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY: provider.apiKey || process.env.ANTHROPIC_API_KEY
    }
    if (model.agent === 'codex') {
      const codexHome = join(runBase, 'codex-home')
      const codexWorkspace = join(runBase, 'codex-workspace')
      await mkdir(codexWorkspace, { recursive: true })
      const [cmd, ...prefix] = commandParts(state.settings.codexCommand || 'codex')
      const codexConfig = buildCodexConfig(runtimeProvider, model, proxyBaseUrl)
      if (hasCodexInstructionFile(codexConfig)) await ensureCodexInstructionFile(state.settings)
      const envName = envKeyFromCodexConfig(codexConfig)
      if (envName && provider.apiKey) commonEnv[envName] = provider.apiKey
      result = await execProcess(cmd, [...prefix, 'exec', '--skip-git-repo-check', '--ephemeral', '--json', prompt], {
        cwd: codexWorkspace,
        env: { ...commonEnv, CODEX_HOME: codexHome },
        timeoutMs,
        signal
      })
      if (isCodexInstructionMissing(result)) {
        await ensureCodexInstructionFile(state.settings)
        result = await execProcess(cmd, [...prefix, 'exec', '--skip-git-repo-check', '--ephemeral', '--json', prompt], {
          cwd: codexWorkspace,
          env: { ...commonEnv, CODEX_HOME: codexHome },
          timeoutMs,
          signal
        })
      }
    } else {
      const workspace = join(runBase, 'claude-workspace')
      const settingsPath = join(workspace, '.claude', 'settings.json')
      const [cmd, ...prefix] = commandParts(state.settings.claudeCommand || 'claude')
      result = await execProcess(cmd, [
        ...prefix,
        '--bare',
        '--max-turns',
        '1',
        '--no-session-persistence',
        '--effort',
        'low',
        '--settings',
        settingsPath,
        '-p',
        prompt
      ], {
        cwd: workspace,
        env: {
          ...commonEnv,
          ANTHROPIC_BASE_URL: proxyBaseUrl,
          ANTHROPIC_MODEL: model.name,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model.name,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model.name,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model.name,
          MAX_THINKING_TOKENS: '0',
          CLAUDE_CODE_EFFORT_LEVEL: 'low',
          CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1'
        },
        timeoutMs,
        signal
      })
    }
  } finally {
    await proxy.close()
    await rm(runBase, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }

  throwIfCheckCancelled(signal)
  const latencyMs = Date.now() - started
  const exchange = selectExchange(capture.exchanges)
  const logDetail = exchange?.logDetail ?? {
    client_body: buildRequest(runtimeProvider, model, prompt).body,
    forward_url: runtimeBaseUrl,
    provider_body: provider.saveBody ? { stdout: result.stdout, stderr: result.stderr, note: 'no proxy exchange captured' } : '[body disabled]'
  }
  const hasText = result.stdout.trim().length > 0
  const timedOut = result.timedOut
  const providerErrorMessage = extractProviderErrorMessage(exchange?.response?.body)
  const hasUpstreamExchange = Boolean(exchange)
  const hasUpstreamError = Boolean(exchange && Number(exchange.statusCode) >= 400)
  const ok = !timedOut && !hasUpstreamError && result.exitCode === 0 && hasText
  const runState = timedOut && !hasUpstreamExchange ? 'timeout' : ok ? 'success' : result.exitCode === 0 && !hasUpstreamError ? 'warning' : 'failed'
  const errorMessage = ok
    ? ''
    : providerErrorMessage || (timedOut && hasUpstreamExchange
        ? 'CLI timed out after upstream response'
        : timedOut
          ? 'CLI process timed out'
          : result.stderr.trim() || 'No valid text output')

  return {
    id: runId,
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
      headers: {},
      body: provider.saveBody ? { stdout: result.stdout, stderr: result.stderr, note: 'no proxy exchange captured' } : '[body disabled]'
    },
    logDetail
  }
}

function extractProviderErrorMessage(body) {
  if (!body) return ''
  if (typeof body === 'string') {
    const trimmed = body.trim()
    if (!trimmed) return ''
    const parsed = parseJsonLikeError(trimmed)
    if (parsed) return extractProviderErrorMessage(parsed)
    const match = trimmed.match(/"message"\s*:\s*"([^"]+)"/)
    return match ? match[1] : trimmed.slice(0, 500)
  }
  if (typeof body !== 'object') return String(body)
  const error = body.error
  if (error && typeof error === 'object') return String(error.message || error.type || error.code || '').trim()
  if (error) return String(error)
  return String(body.message || body.type || '').trim()
}

function parseJsonLikeError(text) {
  try { return JSON.parse(text) } catch {}
  const dataLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('data:') && line.includes('{'))
  if (!dataLine) return null
  try { return JSON.parse(dataLine.replace(/^data:\s*/, '')) } catch { return null }
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
  throwIfCheckCancelled(options.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let done = false
    let cancelTimer
    const finish = (value, error = null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(cancelTimer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => {
      terminateProcessTree(child)
      cancelTimer = setTimeout(() => finish(null, new CheckCancelledError()), 2000)
      cancelTimer.unref?.()
    }
    const timer = setTimeout(() => {
      terminateProcessTree(child)
      finish({ exitCode: null, stdout, stderr, timedOut: true })
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => { stdout = appendLimitedOutput(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = appendLimitedOutput(stderr, chunk) })
    child.on('error', (error) => {
      if (options.signal?.aborted) return finish(null, new CheckCancelledError())
      finish({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, timedOut: false })
    })
    child.on('close', (code) => {
      if (options.signal?.aborted) return finish(null, new CheckCancelledError())
      finish({ exitCode: code ?? 0, stdout, stderr, timedOut: false })
    })
    if (options.signal?.aborted) abort()
  })
}

function terminateProcessTree(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-child.pid, 'SIGTERM')
  } catch {}
  const forceKill = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 1500)
  forceKill.unref?.()
}

function appendLimitedOutput(current, chunk) {
  if (current.includes('[truncated cli output]')) return current
  const next = `${current}${chunk.toString()}`
  if (next.length <= maxCliOutputChars) return next
  return `${next.slice(0, maxCliOutputChars)}\n...[truncated cli output]`
}

async function scheduleTick() {
  if (scheduleRunning) return
  scheduleRunning = true
  try {
  const state = await loadState({ includeRuns: false })
  if (!state.settings.scheduleEnabled) return
  const now = Date.now()
  const due = state.providers.filter((provider) => {
    if (!provider.enabled || !provider.scheduleEnabled) return false
    if (!provider.nextRunAt) return true
    return new Date(provider.nextRunAt).getTime() <= now
  })
  for (const provider of due) await enqueueCheck({ providerId: provider.id }, true)
  } finally {
    scheduleRunning = false
  }
}

async function autoUpdateTick() {
  if (updateRunning) return
  updateRunning = true
  try {
    const state = await loadState({ includeRuns: false })
    if (!state.settings.autoUpdateEnabled) return
    const now = Date.now()
    for (const target of ['codex', 'claude']) {
      const field = target === 'codex' ? 'codexLastUpdateAt' : 'claudeLastUpdateAt'
      const last = state.settings[field] ? new Date(state.settings[field]).getTime() : 0
      if (last && now - last < state.settings.autoUpdateIntervalDays * 86400000) continue
      try {
        const result = await runCliUpdate(target)
        if (!result.ok) {
          console.error(`${target} update failed: ${result.output}`)
          continue
        }
        await updateState((current) => {
          current.settings[field] = new Date().toISOString()
          return current
        })
      } catch (error) {
        console.error(`${target} update error: ${error.message}`)
      }
    }
  } finally {
    updateRunning = false
  }
}

async function serveStatic(req, res) {
  const dist = join(root, 'dist')
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const file = requested === '/' ? join(dist, 'index.html') : resolve(join(dist, requested))
  const relativePath = relative(dist, file)
  const finalFile = !relativePath.startsWith('..') && !isAbsolute(relativePath) ? file : join(dist, 'index.html')
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
    const state = await loadState({ includeRuns: false })
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

  if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, await publicAppState())
  if (req.method === 'GET' && pathname === '/api/logs') return send(res, 200, await loadRunSummaries())
  if (req.method === 'GET' && pathname === '/api/checks') {
    return send(res, 200, { jobs: [...jobs.values()].filter((job) => !job.done).map(publicJob) })
  }
  if (req.method === 'GET' && pathname === '/api/backup/export') return send(res, 200, await exportBackup())
  const backupJobMatch = pathname.match(/^\/api\/backup\/import\/([^/]+)$/)
  if (req.method === 'GET' && backupJobMatch) {
    const job = backupJobs.get(backupJobMatch[1])
    if (!job) return send(res, 404, { error: 'backup_job_not_found' })
    return send(res, 200, { job: publicBackupJob(job), state: job.done ? await publicAppState() : undefined })
  }
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (req.method === 'GET' && runMatch) {
    const run = await loadRunDetail(runMatch[1])
    if (!run) return send(res, 404, { error: 'run_not_found' })
    return send(res, 200, run)
  }
  if (req.method === 'POST' && pathname === '/api/providers/reset-config') {
    const body = await readJson(req)
    if (!['codex', 'claude'].includes(body.target)) return send(res, 400, { error: 'invalid_target' })
    return send(res, 200, publicState(await resetProviderConfig(body), { includeRuns: false }))
  }
  if (req.method === 'POST' && pathname === '/api/providers') return send(res, 200, publicState(await upsertProvider(await readJson(req)), { includeRuns: false }))
  if (req.method === 'POST' && pathname === '/api/runs/clear') {
    await clearRuns(await readJson(req))
    return send(res, 200, await publicAppState())
  }
  if (req.method === 'POST' && pathname === '/api/schedule/settings') {
    return send(res, 200, publicState(await updateScheduleSettings(await readJson(req)), { includeRuns: false }))
  }
  if (req.method === 'POST' && pathname === '/api/schedule/provider') {
    return send(res, 200, publicState(await updateProviderSchedule(await readJson(req)), { includeRuns: false }))
  }
  if (req.method === 'POST' && pathname === '/api/schedule/model') {
    return send(res, 200, publicState(await updateModelSchedule(await readJson(req)), { includeRuns: false }))
  }
  if (req.method === 'POST' && pathname === '/api/backup/import') {
    return send(res, 202, { job: publicBackupJob(enqueueBackupImport(await readJson(req))) })
  }
  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readJson(req)
    if (body.adminPassword === '') delete body.adminPassword
    const state = await updateState((current) => {
      current.settings = normalizeSettings({ ...current.settings, ...body })
      return current
    })
    if (hasCodexInstructionFile(state.settings.defaultCodexConfig)) await ensureCodexInstructionFile(state.settings)
    return send(res, 200, publicState(state, { includeRuns: false }))
  }
  if (req.method === 'POST' && pathname === '/api/updates') {
    const body = await readJson(req)
    if (!['codex', 'claude'].includes(body.target)) return send(res, 400, { error: 'invalid_target' })
    const result = await runCliUpdate(body.target)
    if (!result.ok) return send(res, 500, { error: result.output || `${body.target}_update_failed` })
    const field = body.target === 'codex' ? 'codexLastUpdateAt' : 'claudeLastUpdateAt'
    const state = await updateState((current) => {
      current.settings[field] = new Date().toISOString()
      return current
    })
    return send(res, 200, { ...publicState(state, { includeRuns: false }), update: { target: body.target, ...result } })
  }
  if (req.method === 'POST' && pathname === '/api/checks') {
    const body = await readJson(req)
    const result = await enqueueCheck({
      providerId: body.providerId,
      agent: body.agent,
      modelName: body.modelName
    })
    return send(res, 202, { job: publicJob(result.job), reused: result.reused })
  }
  const cancelJobMatch = pathname.match(/^\/api\/checks\/([^/]+)\/cancel$/)
  if (req.method === 'POST' && cancelJobMatch) {
    const job = jobs.get(cancelJobMatch[1])
    if (!job) return send(res, 404, { error: 'job_not_found' })
    const cancelled = cancelCheckJob(job, await readJson(req))
    return send(res, 200, { job: publicJob(job), cancelled })
  }
  const jobMatch = pathname.match(/^\/api\/checks\/([^/]+)$/)
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) return send(res, 404, { error: 'job_not_found' })
    return send(res, 200, { job: publicJob(job), state: job.done ? await publicAppState() : undefined })
  }
  const deleteMatch = pathname.match(/^\/api\/providers\/([^/]+)$/)
  if (req.method === 'DELETE' && deleteMatch) {
    await deleteProvider(deleteMatch[1])
    return send(res, 200, await publicAppState())
  }
  send(res, 404, { error: 'not_found' })
}

await ensureData()
setInterval(() => scheduleTick().catch((error) => console.error(error)), schedulerMs)
setInterval(() => autoUpdateTick().catch((error) => console.error(error)), schedulerMs)

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
