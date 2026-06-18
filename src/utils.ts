import type { AgentType, RunState, TestRunSummary } from './types'

export const agentLabel = (agent: AgentType) => (agent === 'codex' ? 'Codex' : 'Claude Code')

export const stateLabel = (state: RunState) => {
  const labels: Record<RunState | 'empty', string> = {
    success: '正常',
    warning: '警告',
    failed: '异常',
    timeout: '超时',
    empty: '无数据'
  }
  return labels[state]
}

export const runText = (run?: TestRunSummary) => {
  if (!run) return '—'
  if (run.state === 'timeout') return 'TIMEOUT'
  if (run.httpStatus) return String(run.httpStatus)
  if (run.cliExitCode !== null) return `CLI ${run.cliExitCode}`
  return 'ERR'
}

export const isHealthy = (run?: TestRunSummary) => !!run && (run.state === 'success' || run.state === 'warning')

export const formatTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))

export const formatShortTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))

export const stringify = (value: unknown) => JSON.stringify(redact(value), null, 2)

const secretKeys = ['authorization', 'cookie', 'token', 'api_key', 'apikey', 'key', 'secret']

export const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      secretKeys.some((secret) => key.toLowerCase().includes(secret)) ? '***REDACTED***' : redact(entry)
    ])
  )
}
