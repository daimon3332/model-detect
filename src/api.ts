import type { AppState, CheckTarget, GlobalSettings, ProviderConfig } from './types'
import {
  loadState as loadLocalState,
  persistState,
  removeProvider as removeLocalProvider,
  runProviderChecks as runLocalChecks,
  upsertProvider as upsertLocalProvider
} from './mockApi'

export const loadInitialState = () => loadLocalState()

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
  persistState(state)
  return next
}

export async function saveProviderApi(state: AppState, provider: ProviderConfig) {
  try {
    const next = await api<AppState>('/api/providers', { method: 'POST', body: provider })
    assignState(state, next)
  } catch {
    upsertLocalProvider(state, provider)
  }
}

export async function deleteProviderApi(state: AppState, providerId: string) {
  try {
    const next = await api<AppState>(`/api/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' })
    assignState(state, next)
  } catch {
    removeLocalProvider(state, providerId)
  }
}

export async function saveSettingsApi(state: AppState, extra: Partial<GlobalSettings> = {}) {
  try {
    const next = await api<AppState>('/api/settings', { method: 'POST', body: { ...state.settings, ...extra } })
    assignState(state, next)
  } catch {
    persistState(state)
  }
}

export async function runChecksApi(state: AppState, target: CheckTarget = {}) {
  try {
    const result = await api<{ state: AppState; runs: AppState['runs'] }>('/api/checks', {
      method: 'POST',
      body: target
    })
    assignState(state, result.state)
    persistState(state)
    return result.runs
  } catch {
    return runLocalChecks(state, target)
  }
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}

function assignState(target: AppState, source: AppState) {
  target.providers = source.providers ?? []
  target.runs = source.runs ?? []
  target.settings = { ...target.settings, ...(source.settings ?? {}) }
}
