/** One pi-ai route and credential reference per Key. All edits are planned, not applied here. */
export const PROVIDER_PREFIX = 'nikoapi'
export const API_KEY_ENV = 'NIKOAPI_API_KEY' // legacy single-key reference, not used for new routes
export const keyRoute = keyId => `${PROVIDER_PREFIX}-${Number(keyId)}`
export const keyRef = keyId => `${API_KEY_ENV}_${Number(keyId)}`
export const isOwnedRoute = routeId => typeof routeId === 'string' && /^nikoapi(?:-[1-9]\d*)?$/.test(routeId)

/** Shipped pi-ai directory entries expose their actual profile entry id as settingsNs. */
export function findProvidersNamespace(rows) {
  const candidates = [...new Set((Array.isArray(rows) ? rows : []).filter(row =>
    typeof row?.settingsNs === 'string' && row.settingsNs !== '' && Array.isArray(row.settingsPath) && row.settingsPath[0] === 'providers',
  ).map(row => row.settingsNs))]
  if (candidates.includes('llm-pi-ai')) return 'llm-pi-ai'
  return candidates.length === 1 ? candidates[0] : null
}

/** Missing capability metadata follows the user's explicit defaults, not a model-name guess. */
export function modelCapabilities(model = {}) {
  const input = [...new Set((Array.isArray(model.input) ? model.input : []).filter(type => type === 'text' || type === 'image'))]
  const knownEfforts = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  let reasoningEfforts
  if (model.reasoningEfforts === false) {
    reasoningEfforts = false
  } else {
    const source = model.reasoningEfforts
    const entries = Array.isArray(source)
      ? source.map(level => [level, level === 'off' ? null : level])
      : source && typeof source === 'object' ? Object.entries(source) : []
    const valid = entries.filter(([level, value]) => knownEfforts.has(level)
      && ((level === 'off' && value === null) || (typeof value === 'string' && value !== '')))
    reasoningEfforts = valid.length ? Object.fromEntries(valid) : { off: null, low: 'low', high: 'high', max: 'max' }
  }
  return { input: input.length ? input : ['text', 'image'], reasoningEfforts }
}

export function buildProviderRoute({ origin, apiKeyEnv, modelIds, models, label }) {
  const ids = [...new Set((Array.isArray(modelIds) ? modelIds : []).filter(id => typeof id === 'string' && id.trim() !== ''))]
  const metadata = new Map((Array.isArray(models) ? models : []).map(model => [model.id, model]))
  return {
    displayName: typeof label === 'string' && label.trim() !== '' ? `NikoAPI · ${label.trim()}` : 'NikoAPI',
    apiKeyEnv,
    api: 'openai-completions',
    baseURL: `${new URL(origin).origin}/v1`,
    models: ids.map(id => ({ id, ...modelCapabilities(metadata.get(id)) })),
  }
}

/** Only ids recorded in plugin state may be removed; prefixes alone never establish ownership. */
export function planRoutes(ownedRouteIds, entries, origin) {
  const routes = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Number.isSafeInteger(entry?.keyId) || entry.keyId <= 0 || !Array.isArray(entry.modelIds) || entry.modelIds.length === 0) continue
    routes[keyRoute(entry.keyId)] = buildProviderRoute({ origin, apiKeyEnv: keyRef(entry.keyId), modelIds: entry.modelIds, models: entry.models, label: entry.name })
  }
  return { routes, removed: [...new Set((Array.isArray(ownedRouteIds) ? ownedRouteIds : []).filter(id => isOwnedRoute(id) && !Object.hasOwn(routes, id)))] }
}

/** Readback verifies the endpoint, protocol, credential and exact model set. */
export function registrationStatus(section, entries, origin) {
  const providers = section?.providers ?? {}
  const routes = []
  const missing = []
  for (const entry of entries) {
    if (!Array.isArray(entry.modelIds) || entry.modelIds.length === 0) continue
    const id = keyRoute(entry.keyId)
    const route = Object.hasOwn(providers, id) ? providers[id] : undefined
    const current = Array.isArray(route?.models) ? route.models.map(model => model?.id).filter(id => typeof id === 'string').sort() : []
    const wanted = [...new Set(entry.modelIds)].sort()
    const metadata = new Map((entry.models ?? []).map(model => [model.id, model]))
    const capabilitiesMatch = wanted.every(id => {
      const actual = route?.models?.find(model => model.id === id)
      const expected = modelCapabilities(metadata.get(id))
      const sameInput = Array.isArray(actual?.input)
        && JSON.stringify([...actual.input].sort()) === JSON.stringify([...expected.input].sort())
      const actualEfforts = actual?.reasoningEfforts
      const sameEfforts = expected.reasoningEfforts === false ? actualEfforts === false
        : actualEfforts !== null && typeof actualEfforts === 'object' && !Array.isArray(actualEfforts)
          && JSON.stringify(Object.entries(actualEfforts).sort()) === JSON.stringify(Object.entries(expected.reasoningEfforts).sort())
      return sameInput && sameEfforts
    })
    const ok = current.length === wanted.length && current.every((id, i) => id === wanted[i]) && capabilitiesMatch
      && route?.apiKeyEnv === keyRef(entry.keyId) && route?.api === 'openai-completions'
      && (origin === undefined || route?.baseURL === `${new URL(origin).origin}/v1`)
    ;(ok ? routes : missing).push(id)
  }
  return { registered: missing.length === 0 && routes.length > 0, routes, missing }
}
