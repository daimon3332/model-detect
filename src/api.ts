import type { AppState, CheckJob, CheckTarget, GlobalSettings, ProviderConfig } from './types'
import { loadState as loadLocalState } from './mockApi'

export const loadInitialState = () => loadLocalState()
export const loadShellState = () => {
  const state = loadLocalState()
  return { ...state, providers: [], runs: [] }
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function checkSessionApi() {
  try {
    const result = await api<{ authenticated: boolean }>('/api/session')
    return result.authenticated
  } catch {
    return false
  }
}

export async function loginApi(password: string) {
  return api<{ ok: boolean }>('/api/login', { method: 'POST', body: { password } })
}

export async function logoutApi() {
  return api<{ ok: boolean }>('/api/logout', { method: 'POST' })
}

export async function refreshState(state: AppState) {
  const next = await api<AppState>('/api/state')
  assignState(state, next)
  return next
}

export async function saveProviderApi(state: AppState, provider: ProviderConfig) {
  const next = await api<AppState>('/api/providers', { method: 'POST', body: provider })
  assignState(state, next)
}

export async function deleteProviderApi(state: AppState, providerId: string) {
  const next = await api<AppState>(`/api/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' })
  assignState(state, next)
}

export async function saveSettingsApi(state: AppState, extra: Partial<GlobalSettings> = {}) {
  const next = await api<AppState>('/api/settings', { method: 'POST', body: { ...state.settings, ...extra } })
  assignState(state, next)
}

export async function startChecksApi(target: CheckTarget = {}) {
  const result = await api<{ job: CheckJob }>('/api/checks', {
    method: 'POST',
    body: target
  })
  return result.job
}

export async function getCheckJobApi(state: AppState, jobId: string) {
  const result = await api<{ job: CheckJob; state?: AppState }>(`/api/checks/${encodeURIComponent(jobId)}`)
  if (result.state) assignState(state, result.state)
  return result.job
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  if (!response.ok) throw new ApiError(response.status, await response.text())
  return (await response.json()) as T
}

function assignState(target: AppState, source: AppState) {
  target.providers = source.providers ?? []
  target.runs = source.runs ?? []
  target.settings = { ...target.settings, ...(source.settings ?? {}) }
}
