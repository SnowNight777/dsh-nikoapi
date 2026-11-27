/** Build one owned pi-ai route per Niko Key; the route selects one shared group protocol. */
export const PROVIDER_PREFIX = 'nikoapi'
export const API_KEY_ENV = 'NIKOAPI_API_KEY' // legacy single-key reference, not used for new routes
export const DSH_PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'])
const ENDPOINT_PROTOCOL = Object.freeze({
  openai: 'openai-completions',
  'openai-response': 'openai-responses',
  anthropic: 'anthropic-messages',
  gemini: 'google-generative-ai',
  ...Object.fromEntries(DSH_PROTOCOLS.map(protocol => [protocol, protocol])),
})
const ROUTE_PROTOCOL_PRIORITY = Object.freeze(['openai-responses', 'anthropic-messages', 'google-generative-ai', 'openai-completions'])
export function keyRoute(keyId) { return `${PROVIDER_PREFIX}-${Number(keyId)}` }
export function selectRouteProtocol(protocols) {
  const supported = new Set(normalizeProtocols(protocols))
  return ROUTE_PROTOCOL_PRIORITY.find(protocol => supported.has(protocol)) ?? 'openai-completions'
}
export const keyRef = keyId => `${API_KEY_ENV}_${Number(keyId)}`
export const isOwnedRoute = routeId => typeof routeId === 'string' && /^nikoapi(?:-[1-9]\d*(?:-(?:responses|anthropic|gemini))?)?$/.test(routeId)

/** Protocol capability is shared by a NikoAPI group, aggregated from its LLM catalogue rows. */
export function groupProtocolMap(rows, knownGroups = []) {
  const source = Array.isArray(rows) ? rows : []
  const allGroups = new Set((Array.isArray(knownGroups) ? knownGroups : []).filter(group => typeof group === 'string' && group))
  for (const row of source) for (const group of rowGroups(row)) if (group !== 'all') allGroups.add(group)
  const groups = new Map()
  for (const row of source) {
    const hasEndpoints = Array.isArray(row?.supportedEndpoints) || Array.isArray(row?.supported_endpoint_types)
    const endpointTypes = Array.isArray(row?.supportedEndpoints) && row.supportedEndpoints.length ? row.supportedEndpoints
      : Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : []
    // Image-only catalogue rows are not chat-route capability declarations.
    if (endpointTypes.length && endpointTypes.every(type => type === 'image-generation')) continue
    if (!hasEndpoints) continue
    const supported = new Set(endpointTypes.map(type => ENDPOINT_PROTOCOL[type]).filter(Boolean))
    if (!supported.size) continue
    const names = rowGroups(row)
    const targets = names.includes('all') ? [...allGroups] : names
    for (const group of targets) {
      if (!groups.has(group)) groups.set(group, new Set())
      for (const protocol of supported) groups.get(group).add(protocol)
    }
  }
  return new Map([...groups].map(([group, protocols]) => [group, DSH_PROTOCOLS.filter(protocol => protocols.has(protocol))]))
}
function rowGroups(row) {
  if (typeof row?.group === 'string' && row.group) return [row.group]
  const values = Array.isArray(row?.enable_groups) ? row.enable_groups : Array.isArray(row?.enable_group) ? row.enable_group : []
  const groups = values.filter(group => typeof group === 'string' && group)
  return groups
}

/** Auto groups can route to any member, so expose only protocols common to all candidates. */
export function protocolsForKey(key, groupProtocols) {
  const groups = key?.group === 'auto'
    ? [...new Set(Array.isArray(key.autoGroups) ? key.autoGroups.filter(group => typeof group === 'string' && group) : [])]
    : typeof key?.group === 'string' && key.group ? [key.group] : []
  if (!groups.length) return ['openai-completions']
  const sets = groups.map(group => new Set(groupProtocols.get(group) ?? []))
  const shared = DSH_PROTOCOLS.filter(protocol => sets.every(protocols => protocols.has(protocol)))
  return shared.length ? shared : ['openai-completions']
}
export function isLlmModel(model) {
  const endpoints = model?.supportedEndpoints
  if (Array.isArray(endpoints) && endpoints.length > 0 && endpoints.every(endpoint => endpoint === 'image-generation')) return false
  return isGptModel(model) || (Array.isArray(endpoints) && endpoints.some(endpoint => Object.hasOwn(ENDPOINT_PROTOCOL, endpoint)))
}
export function modelProtocols(model, key, groupProtocols) {
  const endpoints = model?.supportedEndpoints
  if (!Array.isArray(endpoints) || endpoints.length === 0) return ['openai-completions']
  if (!isLlmModel(model)) return ['openai-completions']
  return protocolsForKey(key, groupProtocols)
}
export function normalizeProtocols(protocols) {
  const values = [...new Set(Array.isArray(protocols) ? protocols.filter(protocol => DSH_PROTOCOLS.includes(protocol)) : [])]
  return DSH_PROTOCOLS.filter(protocol => values.includes(protocol))
}

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

export function buildProviderRoute({ origin, apiKeyEnv, modelIds, models, label, protocol = 'openai-completions' }) {
  if (!DSH_PROTOCOLS.includes(protocol)) throw new TypeError('unsupported DSH protocol')
  const ids = [...new Set((Array.isArray(modelIds) ? modelIds : []).filter(id => typeof id === 'string' && id.trim() !== ''))]
  const metadata = new Map((Array.isArray(models) ? models : []).map(model => [model.id, model]))
  // anthropic-messages: the Anthropic SDK appends its own path segments; omit /v1 from the base.
  const baseURL = protocol === 'anthropic-messages' ? new URL(origin).origin : `${new URL(origin).origin}/v1`
  return {
    displayName: typeof label === 'string' && label.trim() !== '' ? `NikoAPI · ${label.trim()}` : 'NikoAPI',
    apiKeyEnv,
    api: protocol,
    baseURL,
    models: ids.map(id => {
      const caps = modelCapabilities(metadata.get(id))
      // DSH requires false (not an off-only map) to disable reasoning.
      // Respect explicit server capabilities; apply this default only when undeclared.
      if (protocol === 'anthropic-messages' && !metadata.get(id)?.reasoningEffortsDeclared) caps.reasoningEfforts = false
      return { id, ...caps }
    }),
  }
}

export function isGptModel(model) {
  const endpoints = model?.supportedEndpoints
  if (Array.isArray(endpoints) && endpoints.length > 0 && endpoints.every(endpoint => endpoint === 'image-generation')) return false
  return [model?.id, model?.modelId, model?.name].some(value => typeof value === 'string' && /(?:^|[^a-z0-9])gpt(?:$|[-_. ]|[0-9])/i.test(value))
}

/** One DSH Provider per Key: select one API shared by every confirmed model on that Key. */
export function routeEntries(entries) {
  const byKey = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Number.isSafeInteger(entry?.keyId) || entry.keyId <= 0 || !Array.isArray(entry.modelIds) || entry.modelIds.length === 0) continue
    let target = byKey.get(entry.keyId)
    if (!target) { target = { ...entry, modelIds: [], models: [] }; byKey.set(entry.keyId, target) }
    const metadata = new Map((Array.isArray(entry.models) ? entry.models : []).map(model => [model.id, model]))
    for (const modelId of entry.modelIds) {
      if (target.modelIds.includes(modelId)) continue
      const model = metadata.get(modelId) ?? { id: modelId }
      target.modelIds.push(modelId)
      target.models.push(model)
    }
  }
  return [...byKey.values()].map(entry => {
    const supportedByAll = entry.models.map(model => {
      const declared = normalizeProtocols(model.protocols ?? entry.protocols)
      return new Set(declared.length ? declared : ['openai-completions'])
    })
    const common = DSH_PROTOCOLS.filter(protocol => supportedByAll.every(protocols => protocols.has(protocol)))
    const protocol = entry.models.some(isGptModel) ? 'openai-responses' : selectRouteProtocol(common)
    return { ...entry, protocol, providerId: keyRoute(entry.keyId) }
  })
}

export function planRoutes(ownedRouteIds, entries, origin) {
  const routes = {}
  for (const entry of routeEntries(entries)) {
    routes[entry.providerId] = buildProviderRoute({ origin, apiKeyEnv: keyRef(entry.keyId), modelIds: entry.modelIds, models: entry.models,
      label: entry.name, protocol: entry.protocol })
  }
  return { routes, removed: [...new Set((Array.isArray(ownedRouteIds) ? ownedRouteIds : []).filter(id => isOwnedRoute(id) && !Object.hasOwn(routes, id)))] }
}

/** Readback verifies one selected protocol, endpoint, credential and exact model set per Key. */
export function registrationStatus(section, entries, origin) {
  const providers = section?.providers ?? {}
  const routes = []
  const missing = []
  for (const entry of routeEntries(entries)) {
    const id = entry.providerId
    const route = Object.hasOwn(providers, id) ? providers[id] : undefined
    const current = Array.isArray(route?.models) ? route.models.map(model => model?.id).filter(id => typeof id === 'string').sort() : []
    const wanted = [...new Set(entry.modelIds)].sort()
    // Capabilities (input modalities, reasoningEfforts) are user-adjustable after first write;
    // only check the parts that must never drift: credential, protocol, endpoint, model set,
    // and that each model entry is structurally complete (input array must exist).
    const structureOk = wanted.every(modelId => {
      const actual = route?.models?.find(model => model.id === modelId)
      return Array.isArray(actual?.input)
    })
    const ok = current.length === wanted.length && current.every((modelId, index) => modelId === wanted[index])
      && structureOk
      && route?.apiKeyEnv === keyRef(entry.keyId) && route?.api === entry.protocol
      && (origin === undefined || route?.baseURL === (entry.protocol === 'anthropic-messages' ? new URL(origin).origin : `${new URL(origin).origin}/v1`))
    ;(ok ? routes : missing).push(id)
  }
  return { registered: missing.length === 0 && routes.length > 0, routes, missing }
}
