/** NikoAPI Host: credentials stay server-side; exact model routes own runtime quotes. */
import { createNikoClient, NikoPermissionError } from './lib/niko.js'
import { normalizePricing, hasExpressionBilling } from './lib/pricing.js'
import { normalizeGroups } from './lib/groups.js'
import { calculatePrice, hasManualPrice, usablePrice } from './lib/price-calculator.js'
import { API_KEY_ENV, findProvidersNamespace, isLlmModel, keyRef, keyRoute, groupProtocolMap, modelCapabilities, modelProtocols, normalizeProtocols, planRoutes, registrationStatus, routeEntries } from './lib/models.js'
import { readState, writeState, emptyState, keyMetadata, directoryKeyMetadata, keyPriceIdentity } from './lib/state.js'
import { planBalanceBinding } from './lib/costmeter.js'
import { HttpError } from './lib/http.js'

export const name = 'nikoapi'
export const inject = ['credentials']
const PAT_REF = 'NIKOAPI_MANAGEMENT_TOKEN'
const DEFAULT_BASE_URL = 'https://nikoapi.xyz'
const MAX_BODY_BYTES = 256 * 1024
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })
const pair = (keyId, modelId) => JSON.stringify([keyId, modelId])
const safeFailure = error => {
  if (error instanceof NikoPermissionError) return fail('scope_missing', error.message, { scope: error.scope })
  if (error instanceof HttpError) return fail(error.code === 'UNAUTHORIZED' ? 'credential_invalid' : 'upstream', error.message)
  if (typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code)) return error
  return fail('operation_failed', 'operation failed; existing credentials and unrelated settings were not exposed')
}
const SAFE_FAILURE_CODES = new Set([
  'bad_input', 'credential_invalid', 'disposed', 'key_missing', 'llm_unavailable', 'models_none',
  'model_preview_failed', 'no_credentials', 'operation_failed', 'pat_missing', 'registration_unverified',
  'route_conflict', 'scope_missing', 'state_unavailable', 'unknown_method', 'upstream',
  'invalid_expression', 'unsupported_expression', 'unsupported_context', 'invalid_result', 'invalid_usage',
])
const SAFE_NATIVE_CODES = new Set([
  'EACCES', 'EBUSY', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EEXIST', 'EHOSTUNREACH',
  'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENETUNREACH', 'ENFILE', 'ENOENT', 'ENOTDIR',
  'ENOMEM', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_URL',
  'BAD_URL', 'BAD_SCHEME', 'CROSS_ORIGIN', 'NO_FETCH', 'REDIRECT', 'BAD_JSON', 'TIMEOUT',
  'NETWORK', 'TOO_LARGE', 'UNAUTHORIZED', 'UPSTREAM', 'INCOMPLETE',
])
const SAFE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
  'AggregateError', 'AbortError', 'TimeoutError', 'HttpError', 'NikoPermissionError',
])
export function failureDiagnosticFields(method, error, code) {
  const operation = typeof method === 'string' && /^[a-z][A-Za-z0-9]{0,39}$/.test(method) ? method : 'unknown'
  const failureCode = SAFE_FAILURE_CODES.has(code) ? code : 'operation_failed'
  const errorName = SAFE_ERROR_NAMES.has(error?.name) ? error.name : 'Error'
  const causeCode = SAFE_FAILURE_CODES.has(error?.code) || SAFE_NATIVE_CODES.has(error?.code) ? error.code : 'none'
  return { operation, failureCode, errorName, causeCode, errorCode: causeCode === 'none' ? failureCode : causeCode }
}
export function formatFailureDiagnostic(method, error, code) {
  const fields = failureDiagnosticFields(method, error, code)
  return `nikoapi: ${fields.failureCode} method=${fields.operation} error=${fields.errorName} cause=${fields.causeCode}`
}

export function apply(ctx, config = {}) {
  const origin = new URL(config.baseUrl || DEFAULT_BASE_URL).origin
  let state = emptyState()
  let preview = null
  let disposed = false
  let loadError
  let meter = null
  let meterEpoch = 0
  let meterConfig = null
  let billionContextEpoch = -1
  let queue = Promise.resolve()
  let syncScheduled = false
  let syncRequested = false
  let startupRefresh = false
  let ownRouteRevision = null
  const slots = new Map()
  const ready = readState().then(value => {
    state = value
    // Registrations are process-local. A saved status is never proof of a live callback.
    state.costBinding = { ...state.costBinding, enabled: true, registeredCount: 0, lastStatus: 'waiting', lastMessage: '' }
  }).catch(error => { loadError = error })
  const save = () => disposed ? Promise.resolve() : writeState(state)
  const bump = () => { preview = null }
  const credentials = () => ctx.get('credentials')
  const settings = () => ctx.get('settings')
  const niko = () => createNikoClient({ baseUrl: origin })

  async function requirePat() {
    const store = credentials()
    if (!store) throw fail('no_credentials', 'credential store is unavailable')
    const hit = await store.resolve(PAT_REF)
    if (!hit?.value) throw fail('pat_missing', 'save a management token first')
    return hit.value
  }
  async function requireKey(id) {
    const store = credentials()
    if (!store) throw fail('no_credentials', 'credential store is unavailable')
    const hit = await store.resolve(keyRef(id))
    if (hit?.value) return hit.value
    if (state.legacyKeyId === id) {
      const legacy = await store.resolve(API_KEY_ENV)
      if (legacy?.value) {
        await store.set(keyRef(id), legacy.value)
        state.legacyKeyId = null
        await save()
        return legacy.value
      }
    }
    throw fail('key_missing', `stored credential for Key #${id} is missing; select it again`)
  }
  function section(ns) { return settings()?.describe?.({ redactSecrets: true })?.find(row => row.ns === ns) }
  function providerNamespace() { return findProvidersNamespace(ctx.get('llm')?.listConfigurableProviders?.()) }
  function protocolIdentityFor(key) {
    return JSON.stringify([key?.group ?? '', key?.group === 'auto' ? [...(key.autoGroups ?? [])].sort() : [], key?.crossGroupRetry === true])
  }
  function protocolEntries(keys = state.selectedKeys, confirmed = state.confirmed) {
    return keys.filter(key => key.status === 'enabled').map(key => {
      const rows = confirmed.filter(row => row.keyId === key.id)
      return { keyId: key.id, name: `${key.name} · ${key.group || 'inherited'} · #${key.id}`,
        modelIds: rows.map(row => row.modelId), models: rows.map(row => ({ id: row.modelId, supportedEndpoints: row.supportedEndpoints,
          protocols: row.protocolIdentity === protocolIdentityFor(key) ? row.protocols : ['openai-completions'],
          reasoningEffortsDeclared: row.reasoningEffortsDeclared === true,
          ...modelCapabilities(row) })) }
    }).filter(row => row.modelIds.length)
  }
  function entriesFor(keys = state.selectedKeys, confirmed = state.confirmed) {
    return protocolEntries(keys, confirmed)
  }
  function describeRegistration() {
    const ns = providerNamespace()
    const entries = protocolEntries()
    const status = ns ? registrationStatus(section(ns)?.value, entries, origin) : { registered: false, routes: [], missing: [] }
    const routes = routeEntries(entries)
    const routeByModel = new Map()
    for (const route of routes) for (const modelId of route.modelIds) {
      const key = pair(route.keyId, modelId)
      routeByModel.set(key, [...(routeByModel.get(key) ?? []), route.providerId])
    }
    const registered = new Set(status.routes)
    const models = state.confirmed.map(row => {
      const modelRoutes = (routeByModel.get(pair(row.keyId, row.modelId)) ?? []).filter(id => registered.has(id))
      return { route: modelRoutes[0] ?? keyRoute(row.keyId), routes: modelRoutes, id: row.modelId }
    })
    const count = models.filter(row => row.routes.length > 0).length
    return { supported: ns !== null, ...status, count, routeCount: status.routes.length, models, ns: ns || '',
      lastStatus: state.registration.lastStatus, lastMessage: state.registration.lastMessage }
  }
  /** CAS and readback protect unrelated routes and concurrent settings edits. */
  async function writeRoutes(entries) {
    const ns = state.registration.ns || providerNamespace()
    if (!ns) {
      if (entries.length === 0 && state.registration.routes.length === 0) return
      throw fail('llm_unavailable', 'the pi-ai settings namespace is unavailable')
    }
    const service = settings()
    const before = section(ns)
    if (!before || typeof service?.mutate !== 'function') throw fail('llm_unavailable', 'pi-ai requires the settings mutate API')
    const providers = before.value?.providers ?? {}
    const owned = state.registration.routes
    const plan = planRoutes(owned, entries, origin)
    for (const id of Object.keys(plan.routes)) {
      if (Object.hasOwn(providers, id) && !owned.includes(id)) throw fail('route_conflict', `provider ${id} already exists and is not owned by this plugin`)
    }
    const removed = plan.removed.filter(id => Object.hasOwn(providers, id))
    const ops = removed.map(id => ({ op: 'unset', path: ['providers', id] }))
    for (const [id, value] of Object.entries(plan.routes)) ops.push({ op: 'set', path: ['providers', id], value })
    if (ops.length) {
      ownRouteRevision = { ns, revision: before.revision + 1 }
      try { await service.mutate(ns, ops, before.revision) }
      catch (error) { ownRouteRevision = null; throw error }
    }
    state.registration = { ...state.registration, routes: Object.keys(plan.routes), ns }
    await save()
    const after = section(ns)?.value
    const status = registrationStatus(after, entries, origin)
    if ((entries.length && !status.registered) || removed.some(id => Object.hasOwn(after?.providers ?? {}, id))) {
      throw fail('registration_unverified', 'provider route readback did not match; retry after refreshing settings')
    }
    state.registration = { routes: Object.keys(plan.routes), ns, at: new Date().toISOString(),
      lastStatus: entries.length ? 'registered' : 'unregistered', lastMessage: '' }
    await save()
  }

  function costFacts() {
    const service = meter ?? ctx.get('costMeter')
    return !service ? { available: false, reason: 'not-installed' }
      : typeof service.registerPriceCalculator !== 'function' || typeof service.getLocalState !== 'function'
        ? { available: false, reason: 'unsupported' } : { available: meter === service, reason: meter === service ? undefined : 'waiting' }
  }
  function costDescription() {
    return { ...costFacts(), automatic: true, enabled: true, refreshMinutes: state.costBinding.refreshMinutes,
      registeredCount: slots.size, confirmedCount: state.confirmed.length,
      conflicts: state.costBinding.conflicts ?? [], unavailable: state.costBinding.unavailable ?? [],
      status: state.costBinding.lastStatus, message: state.costBinding.lastMessage, boundAt: state.costBinding.boundAt }
  }
  /** Pure local read; opening Settings never lists remote Keys or starts a refresh. */
  async function describe() {
    const store = credentials()
    const pat = await store?.describe(PAT_REF).catch(() => ({ configured: false }))
    const keys = []
    for (const key of state.selectedKeys) {
      const info = await store?.describe(keyRef(key.id)).catch(() => ({ configured: false }))
      keys.push({ ...key, credentialConfigured: info?.configured === true || state.legacyKeyId === key.id })
    }
    return { site: { origin, name: 'NikoAPI', version: state.site?.version ?? '', currency: state.site?.currency ?? '', quotaPerUnit: state.site?.quotaPerUnit ?? 500_000 },
      connection: { managementToken: { configured: pat?.configured === true, writable: pat?.writable !== false }, keys, primaryKeyId: keys[0]?.id ?? null },
      keyDirectory: { ...state.keyDirectory, selectedKeys: state.selectedKeys },
      confirmed: state.confirmed, cost: costDescription(), lastSyncedAt: state.lastSyncedAt, modelRegistration: describeRegistration() }
  }
  function removeSlot(id) {
    const slot = slots.get(id)
    if (!slot) return
    slot.active = false
    slots.delete(id)
    try { slot.dispose() } catch { ctx.logger?.warn?.('nikoapi: calculator cleanup failed') }
  }
  function clearCalculators() { for (const id of [...slots.keys()]) removeSlot(id) }
  function validSnapshot(row) {
    const key = state.selectedKeys.find(key => key.id === row.keyId)
    return key?.status === 'enabled' && row.keyIdentity === keyPriceIdentity(key)
      && state.confirmed.some(model => pair(model.keyId, model.modelId) === pair(row.keyId, row.modelId))
  }
  function prunePrices() {
    state.priceSnapshots = state.priceSnapshots.filter(validSnapshot)
    const wanted = new Set(routeEntries(entriesFor()).flatMap(entry => entry.models.map(model => pair(entry.keyId, model.id))))
    for (const id of slots.keys()) if (!wanted.has(id)) removeSlot(id)
  }
  function cachePrices(snapshot) {
    const old = new Map(state.priceSnapshots.filter(validSnapshot).map(row => [pair(row.keyId, row.modelId), row]))
    const next = []
    for (const row of state.confirmed) {
      const key = state.selectedKeys.find(key => key.id === row.keyId)
      if (key?.status !== 'enabled') continue
      const source = snapshot.keys.find(entry => entry.id === row.keyId)
      const model = source?.models.find(entry => entry.modelId === row.modelId)
      // Network failure retains the last known rate only for the unchanged Key/group identity.
      if (!source?.modelsLoaded || source.priceTableLoaded === false) {
        if (model || !source?.modelsLoaded) {
          const prior = old.get(pair(row.keyId, row.modelId))
          if (prior) next.push(prior)
        }
        continue
      }
      if (model && usablePrice(model.price, Date.parse(snapshot.at))) next.push({ keyId: row.keyId, modelId: row.modelId,
        keyIdentity: keyPriceIdentity(key), price: model.price, at: snapshot.at })
    }
    state.priceSnapshots = next
    prunePrices()
  }
  /** Registration only. This never changes cost-meter prices, balances, or recorded bills. */
  async function syncCosts({ stale = false } = {}) {
    prunePrices()
    // Reconcile the one-provider-per-Key route even when the cost-meter service is absent.
    // This also removes legacy protocol-suffix routes recorded as plugin-owned.
    const entries = entriesFor()
    let registration = describeRegistration()
    const wantedRouteIds = routeEntries(entries).map(entry => entry.providerId).sort()
    const recordedRouteIds = [...new Set(state.registration.routes)].sort()
    const ownershipNeedsReconcile = JSON.stringify(wantedRouteIds) !== JSON.stringify(recordedRouteIds)
    const needsRouteWrite = registration.supported && (ownershipNeedsReconcile
      || (entries.length > 0 && (!registration.registered || registration.missing.length > 0)))
    if (needsRouteWrite) {
      try {
        await writeRoutes(entries)
        registration = describeRegistration()
      } catch { registration = describeRegistration() }
    }
    const service = meter
    const epoch = meterEpoch
    if (!service || !costFacts().available) {
      clearCalculators()
      state.costBinding = { ...state.costBinding, registeredCount: 0, conflicts: [], unavailable: [], lastStatus: 'waiting',
        lastMessage: 'waiting for cost-meter 1.9.78 or later' }
      await save()
      return costDescription()
    }
    if (!state.confirmed.length) {
      clearCalculators()
      state.costBinding = { ...state.costBinding, registeredCount: 0, conflicts: [], unavailable: [], lastStatus: 'waiting',
        lastMessage: 'select and confirm models to start automatic pricing' }
      await save()
      return costDescription()
    }
    let current
    try { current = await service.getLocalState() }
    catch { current = null }
    if (disposed || meter !== service || meterEpoch !== epoch) return costDescription()
    if (!current?.config || typeof current.config !== 'object') {
      clearCalculators()
      meterConfig = null
      state.costBinding = { ...state.costBinding, registeredCount: 0, lastStatus: 'error', lastMessage: 'cost configuration is unavailable; user price conflicts could not be checked' }
      await save()
      return costDescription()
    }
    meterConfig = current.config
    if (typeof service.updateConfig === 'function' && meterConfig.billionContextEnabled === true && billionContextEpoch !== epoch) {
      billionContextEpoch = epoch
      try {
        await service.updateConfig({ billionContextEnabled: false })
        meterConfig = { ...meterConfig, billionContextEnabled: false }
        ctx.logger?.info?.('nikoapi: billion-context assistance disabled for cost-meter billing')
      } catch { /* the switch is advisory; price calculators keep working without it */ }
    }
    if (typeof service.updateConfig === 'function') {
      const planned = planBalanceBinding(meterConfig, { origin, refreshMinutes: state.costBinding.refreshMinutes, ownedBalance: state.costBinding.balance })
      if (planned.changed && planned.patch) {
        try {
          await service.updateConfig(planned.patch)
          meterConfig = { ...meterConfig, ...planned.patch }
          state.costBinding = { ...state.costBinding, balance: planned.balance }
          ctx.logger?.info?.(planned.created
            ? 'nikoapi: linked the NikoAPI account balance query in cost-meter'
            : 'nikoapi: moved the owned account balance query to the current site')
        } catch { /* balance linking is optional; prices keep working without it */ }
        if (disposed || meter !== service || meterEpoch !== epoch) return costDescription()
      }
    }
    const routes = new Set(registration.routes)
    const cached = new Map(state.priceSnapshots.map(row => [pair(row.keyId, row.modelId), row]))
    const desired = new Set(), conflicts = [], unavailable = []
    for (const entry of routeEntries(entries)) {
      for (const model of entry.models) {
        const id = pair(entry.keyId, model.id), rate = cached.get(id)
        const label = `${entry.providerId}:${model.id}`
        if (!routes.has(entry.providerId) || !rate || !usablePrice(rate.price, Date.now())) { unavailable.push(label); continue }
        if (hasManualPrice(meterConfig, entry.providerId, model.id, state.costBinding)) { conflicts.push(label); continue }
        desired.add(id)
        const existing = slots.get(id)
        if (existing) { existing.rate = rate; continue }
        const slot = { active: true, rate, dispose: () => {} }
        try {
          const dispose = service.registerPriceCalculator({ provider: entry.providerId, model: model.id, calculate({ usage, atMs }) {
            if (!slot.active || disposed || meter !== service || meterEpoch !== epoch || !validSnapshot(slot.rate)
              || !describeRegistration().routes.includes(entry.providerId)) return null
            return calculatePrice(slot.rate.price, usage, atMs)
          } })
          if (typeof dispose !== 'function') throw new Error('calculator registration did not return a disposer')
          slot.dispose = dispose
          slots.set(id, slot)
        } catch {
          slot.active = false
          desired.delete(id)
          conflicts.push(label)
        }
      }
    }
    for (const id of [...slots.keys()]) if (!desired.has(id)) removeSlot(id)
    const count = slots.size
    const status = !state.confirmed.length ? 'waiting' : !count ? 'pending'
      : stale ? 'bound-stale' : conflicts.length || unavailable.length ? 'bound-partial' : 'bound'
    state.costBinding = { ...state.costBinding, enabled: true, registeredCount: count, conflicts, unavailable,
      boundAt: count ? new Date().toISOString() : state.costBinding.boundAt, lastStatus: status,
      lastMessage: [!state.confirmed.length ? 'select and confirm models to start automatic pricing' : '',
        conflicts.length ? `${conflicts.length} existing user price(s) or calculator owner(s) kept` : '',
        unavailable.length ? `${unavailable.length} model(s) await a valid route or exact rate` : '',
        stale ? 'refresh incomplete; unchanged Keys retain their last known rates' : ''].filter(Boolean).join('; ') }
    await save()
    return costDescription()
  }

  async function listKeys() {
    const pat = await requirePat(), client = niko()
    const [site, result, auto, pricing] = await Promise.all([client.status(), client.allKeys(pat),
      client.autoGroups(pat).catch(() => ({ groups: [], maxCount: null })),
      client.pricing(pat).catch(() => ({ rows: [], groupRatio: {}, usableGroup: {}, autoGroups: [] }))])
    state.site = { version: site.version, currency: site.displayCurrency, quotaPerUnit: site.quotaPerUnit, usdExchangeRate: site.usdExchangeRate }
    const fresh = new Map(result.items.map(key => [key.id, key]))
    let identityChanged = false
    state.selectedKeys = state.selectedKeys.map(key => {
      const next = fresh.get(key.id)
      const metadata = next ? keyMetadata(next) : { ...key, status: 'missing' }
      identityChanged ||= keyPriceIdentity(key) !== keyPriceIdentity(metadata)
      return metadata
    })
    if (identityChanged) {
      bump(); prunePrices()
      await writeRoutes(entriesFor())
    }
    const groups = normalizeGroups({ usableGroup: pricing.usableGroup, groupRatio: pricing.groupRatio })
    state.lastSyncedAt = new Date().toISOString()
    state.keyDirectory = { keys: result.items.map(directoryKeyMetadata).filter(Boolean), total: result.total, complete: true,
      autoGroups: auto.groups, autoGroupLimit: auto.maxCount, groups, groupDescriptions: groups.some(group => group.desc !== ''), at: state.lastSyncedAt }
    await save()
    if (identityChanged && state.confirmed.length) await previewModels({ force: true })
    else await syncCosts()
    return { site, ...state.keyDirectory, selectedKeys: state.selectedKeys }
  }
  async function connect({ managementToken }) {
    if (typeof managementToken !== 'string' || !managementToken.trim()) throw fail('bad_input', 'management token is empty')
    const token = managementToken.trim()
    await niko().listKeys(token, { size: 1 })
    await credentials().set(PAT_REF, token)
    bump()
    return listKeys()
  }
  async function selectKeys({ keys }) {
    if (!Array.isArray(keys) || keys.some(key => !Number.isSafeInteger(key?.id) || key.id <= 0)) throw fail('bad_input', 'invalid Key selection')
    const ids = [...new Set(keys.map(key => key.id))], store = credentials()
    if (!ids.length) {
      clearCalculators()
      if (state.registration.routes.length) await writeRoutes([])
      const previous = state.selectedKeys
      state.selectedKeys = []; state.confirmed = []; state.priceSnapshots = []; state.legacyKeyId = null
      bump()
      for (const key of previous) await store?.unset(keyRef(key.id))
      await store?.unset(API_KEY_ENV)
      await syncCosts()
      return { ...(await describe()), failed: [] }
    }
    const pat = await requirePat()
    const result = await niko().allKeys(pat)
    const known = new Map(result.items.map(key => [key.id, key]))
    const invalid = ids.find(id => !known.has(id) || known.get(id).status !== 'enabled')
    if (invalid !== undefined) throw fail('bad_input', `Key #${invalid} is absent or not enabled; refresh the Key list`)
    const selected = [], staged = new Map(), failed = []
    for (const id of ids) {
      try {
        const existing = state.selectedKeys.find(key => key.id === id)
        const configured = await store.describe(keyRef(id)).catch(() => ({ configured: false }))
        if (configured.configured === true && existing) { selected.push(keyMetadata(known.get(id))); continue }
        if (state.legacyKeyId === id) {
          const legacy = await store.resolve(API_KEY_ENV)
          if (legacy?.value) { staged.set(id, legacy.value); selected.push(keyMetadata(known.get(id))); continue }
        }
        staged.set(id, await niko().revealKey(pat, id))
        selected.push(keyMetadata(known.get(id)))
      } catch (error) { failed.push({ id, name: known.get(id).name, message: safeFailure(error).message }) }
    }
    if (failed.length) throw fail('key_missing', `could not securely select every Key; selection was left unchanged (${failed.map(row => `${row.name}: ${row.message}`).join('; ')})`)
    const previous = state.selectedKeys
    for (const [id, secret] of staged) await store.set(keyRef(id), secret)
    state.selectedKeys = selected
    state.confirmed = state.confirmed.filter(row => selected.some(key => key.id === row.keyId))
    state.legacyKeyId = null
    bump(); prunePrices()
    if (state.registration.routes.length || state.confirmed.length) await writeRoutes(entriesFor())
    await save()
    for (const key of previous) if (!selected.some(next => next.id === key.id)) {
      await store.unset(keyRef(key.id))
    }
    await syncCosts()
    return { ...(await describe()), failed }
  }
  async function setGroup({ keyId, group, autoGroups, crossGroupRetry }) {
    if (!Number.isSafeInteger(keyId) || keyId <= 0 || typeof group !== 'string' || !group.trim()) throw fail('bad_input', 'invalid Key or group')
    const pat = await requirePat()
    const source = (await niko().allKeys(pat)).items.find(key => key.id === keyId)
    if (!source) throw fail('bad_input', 'Key is no longer available')
    const nextGroup = group.trim()
    try {
      await niko().updateGroup(pat, keyId, { group: nextGroup,
        autoGroups: Array.isArray(autoGroups) ? autoGroups.filter(value => typeof value === 'string') : source.autoGroups,
        crossGroupRetry: typeof crossGroupRetry === 'boolean' ? crossGroupRetry : source.crossGroupRetry })
      const updated = (await niko().allKeys(pat)).items.find(key => key.id === keyId)
      if (!updated || updated.group !== nextGroup) throw fail('upstream', 'updated Key metadata was not confirmed; refresh the list')
      // Changing pricing identity invalidates only this Key's rates; its explicit model choices remain.
      state.priceSnapshots = state.priceSnapshots.filter(row => row.keyId !== keyId)
      prunePrices()
      state.selectedKeys = state.selectedKeys.map(key => key.id === keyId ? keyMetadata(updated) : key)
      state.keyDirectory.keys = state.keyDirectory.keys.map(key => key.id === keyId ? directoryKeyMetadata(updated) : key)
      if (state.registration.routes.length) await writeRoutes(entriesFor())
      bump(); await save()
      await previewModels({ force: true })
      return { key: directoryKeyMetadata(updated), selectedKeys: state.selectedKeys }
    } catch (error) {
      const refreshed = (await niko().allKeys(pat).catch(() => ({ items: [] }))).items.find(key => key.id === keyId)
      if (refreshed) {
        state.selectedKeys = state.selectedKeys.map(key => key.id === keyId ? keyMetadata(refreshed) : key)
        state.keyDirectory.keys = state.keyDirectory.keys.map(key => key.id === keyId ? directoryKeyMetadata(refreshed) : key)
        if (state.registration.routes.length) await writeRoutes(entriesFor())
        bump(); await save(); await syncCosts({ stale: true })
      }
      throw error
    }
  }

  async function previewModels({ force = false } = {}) {
    if (!force && preview) return preview
    const pat = await requirePat(), client = niko()
    const freshSite = await client.status()
    state.site = { version: freshSite.version, currency: freshSite.displayCurrency, quotaPerUnit: freshSite.quotaPerUnit, usdExchangeRate: freshSite.usdExchangeRate }
    const table = await client.pricing(pat, { requireIdentity: true }).catch(() => null)
    const currency = state.site?.currency || 'USD', keys = []
    for (const key of state.selectedKeys) {
      const entry = { id: key.id, name: key.name, group: key.group, usage: null, models: [], error: '', modelsLoaded: false, priceTableLoaded: table !== null }
      try {
        if (key.status !== 'enabled') throw fail('key_missing', `Key #${key.id} is not enabled; refresh the Key list`)
        const credential = await requireKey(key.id)
        const [usage, models] = await Promise.all([client.usage(credential).catch(() => null), client.listModels(credential)])
        entry.usage = usage; entry.modelsLoaded = true
        const autoGroups = Array.isArray(key.autoGroups) && key.autoGroups.length ? key.autoGroups : (Array.isArray(table?.autoGroups) ? table.autoGroups : [])
        const candidates = key.group === 'auto' ? autoGroups : key.group ? [key.group] : []
        const prices = table === null ? new Map() : normalizePricing(table.rows, { groupRatio: table.groupRatio,
          quotaPerUnit: state.site?.quotaPerUnit ?? 500_000, usdExchangeRate: state.site?.usdExchangeRate ?? 1, currency,
          candidateGroups: candidates, reference: key.group === 'auto', unknownGroup: !key.group || (key.group === 'auto' && !candidates.length) })
        entry.models = [...new Map(models.map(model => [model.id, model])).values()].map(model => {
          const prior = state.confirmed.find(row => row.keyId === key.id && row.modelId === model.id)
          const pricingRows = table?.rows?.filter(row => row?.model_name === model.id) ?? []
          const pricingEndpoints = [...new Set(pricingRows.flatMap(row => Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : []))]
          const supportedEndpoints = model.supportedEndpoints ?? (pricingEndpoints.length ? pricingEndpoints : null)
          return { modelId: model.id, name: model.name, supportedEndpoints,
            ...modelCapabilities({ input: model.inputModalities, reasoningEfforts: model.reasoningEfforts }),
            // Preserve whether the upstream API explicitly declared a reasoning-efforts policy.
            // null means "not declared"; false means "declared as unsupported". Both differ from
            // an object with levels. buildProviderRoute uses this to default anthropic-messages
            // routes to false only when the server never declared a policy.
            reasoningEffortsDeclared: model.reasoningEfforts !== null && model.reasoningEfforts !== undefined,
            price: prices.get(model.id) ?? { kind: 'unknown', currency, note: table === null ? 'price table unavailable for this Key' : 'no exact applicable price' },
            confirmed: Boolean(prior) }
        }).filter(isLlmModel)
      } catch (error) { entry.error = safeFailure(error).message }
      keys.push(entry)
    }
    if (disposed) throw fail('disposed', 'plugin is no longer active')

    const knownGroups = [...new Set([
      ...Object.keys(table?.groupRatio ?? {}),
      ...keys.flatMap(entry => [entry.group, ...(state.selectedKeys.find(key => key.id === entry.id)?.autoGroups ?? [])]),
    ].filter(group => typeof group === 'string' && group && group !== 'auto'))]
    const modelProtocolRows = keys.flatMap(entry => {
      const key = state.selectedKeys.find(row => row.id === entry.id)
      if (!key || key.group === 'auto') return []
      return entry.models.map(model => ({ group: key.group, supportedEndpoints: model.supportedEndpoints }))
    })
    const protocolGroups = groupProtocolMap([...(table?.rows ?? []), ...modelProtocolRows], knownGroups)
    const groupsFor = key => key.group === 'auto'
      ? (Array.isArray(key.autoGroups) && key.autoGroups.length ? key.autoGroups : table?.autoGroups ?? [])
      : [key.group]
    const groupSetKnown = key => {
      const groups = groupsFor(key).filter(group => typeof group === 'string' && group && group !== 'auto')
      return groups.length > 0 && groups.every(group => protocolGroups.has(group) && protocolGroups.get(group).length > 0)
    }
    const identityFor = key => protocolIdentityFor(key)
    for (const entry of keys) {
      const key = state.selectedKeys.find(row => row.id === entry.id)
      if (!key) continue
      entry.protocolGroups = Object.fromEntries([...protocolGroups].map(([group, values]) => [group, values]))
      for (const model of entry.models) {
        const prior = state.confirmed.find(row => row.keyId === key.id && row.modelId === model.modelId)
        const sameIdentity = prior?.protocolIdentity === identityFor(key)
        if (!Array.isArray(model.supportedEndpoints) && sameIdentity) model.supportedEndpoints = prior.supportedEndpoints
        const known = groupSetKnown(key) && isLlmModel(model)
        const reusable = sameIdentity ? normalizeProtocols(prior.protocols) : []
        const routingKey = key.group === 'auto' ? { ...key, autoGroups: groupsFor(key) } : key
        model.protocols = known ? modelProtocols(model, routingKey, protocolGroups) : reusable.length ? reusable : ['openai-completions']
        model.protocolIdentity = identityFor(key)
      }
    }
    const confirmedProtocolSignature = rows => JSON.stringify(rows.map(row => [row.keyId, row.modelId, normalizeProtocols(row.protocols), row.protocolIdentity]))
    const previousConfirmed = confirmedProtocolSignature(state.confirmed)
    const discovered = new Map(keys.flatMap(key => key.models.map(model => [pair(key.id, model.modelId), model])))
    state.confirmed = state.confirmed.map(row => {
      const model = discovered.get(pair(row.keyId, row.modelId))
      if (!model) return row
      return { ...row, name: model.name, supportedEndpoints: model.supportedEndpoints ?? [], protocols: normalizeProtocols(model.protocols),
        protocolIdentity: model.protocolIdentity }
    })
    state.protocolGroups = Object.fromEntries([...protocolGroups].map(([group, values]) => [group, normalizeProtocols(values)]))
    const protocolChanged = previousConfirmed !== confirmedProtocolSignature(state.confirmed)
    if (protocolChanged && state.registration.routes.length) await writeRoutes(entriesFor())
    preview = { keys, groups: normalizeGroups({ usableGroup: table?.usableGroup, groupRatio: table?.groupRatio }), confirmed: state.confirmed, site: state.site, at: new Date().toISOString() }
    cachePrices(preview)
    await syncCosts({ stale: table === null || keys.some(key => !key.modelsLoaded) })
    return { ...preview, cost: costDescription() }
  }
  async function registerModels() {
    if (!state.confirmed.length) throw fail('models_none', 'confirm at least one model first')
    await writeRoutes(entriesFor())
    await syncCosts()
    return describeRegistration()
  }
  async function unregisterModels() {
    clearCalculators()
    await writeRoutes([])
    state.confirmed = []; state.priceSnapshots = []
    bump()
    await syncCosts()
    return describeRegistration()
  }
  async function confirmModels({ selections }) {
    if (!Array.isArray(selections) || selections.some(row => !Number.isSafeInteger(row?.keyId) || !Array.isArray(row.modelIds) || row.modelIds.some(id => typeof id !== 'string' || !id))) throw fail('bad_input', 'invalid model selection')
    const snapshot = await previewModels()
    const errored = snapshot.keys.find(key => key.error)
    if (errored) throw fail('model_preview_failed', `model preview failed for Key #${errored.id}; refresh it before changing registered models`)
    const known = new Map(snapshot.keys.flatMap(key => key.models.map(model => [pair(key.id, model.modelId), model]))), rows = new Map()
    for (const entry of selections) {
      if (!state.selectedKeys.some(key => key.id === entry.keyId)) throw fail('bad_input', 'selection includes a Key that is not active')
      for (const modelId of entry.modelIds) {
        const model = known.get(pair(entry.keyId, modelId))
        if (!model) throw fail('bad_input', 'a selected model is not in this Key preview; refresh the preview')
        const key = state.selectedKeys.find(item => item.id === entry.keyId)
        rows.set(pair(entry.keyId, modelId), { keyId: entry.keyId, modelId, name: model.name,
          supportedEndpoints: Array.isArray(model.supportedEndpoints) ? model.supportedEndpoints : [],
          protocols: normalizeProtocols(model.protocols).length ? normalizeProtocols(model.protocols) : ['openai-completions'],
          protocolIdentity: typeof model.protocolIdentity === 'string' ? model.protocolIdentity : protocolIdentityFor(key),
          reasoningEffortsDeclared: model.reasoningEffortsDeclared === true,
          ...modelCapabilities(model) })
      }
    }
    state.confirmed = [...rows.values()]
    prunePrices()
    await save()
    try { await writeRoutes(entriesFor()) }
    catch (error) { const failure = safeFailure(error); state.registration.lastStatus = 'error'; state.registration.lastMessage = failure.message; await save() }
    preview = { ...snapshot, confirmed: state.confirmed }
    cachePrices(preview)
    await syncCosts({ stale: snapshot.keys.some(key => !key.priceTableLoaded) })
    return { confirmed: state.confirmed, registration: describeRegistration(), cost: costDescription() }
  }
  /** Kept as a compatible endpoint name; only the interval is saved, no opt-in gate. */
  async function saveCostBinding({ refreshMinutes }) {
    if (refreshMinutes !== undefined && (!Number.isFinite(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 1440)) throw fail('bad_input', 'refresh interval must be between 1 and 1440 minutes')
    if (refreshMinutes !== undefined) state.costBinding.refreshMinutes = Math.round(refreshMinutes)
    await syncCosts()
    return { cost: costDescription() }
  }
  async function refresh() {
    const snapshot = await previewModels({ force: true })
    return { ...snapshot, cost: costDescription() }
  }
  async function disconnect() {
    clearCalculators()
    await writeRoutes([])
    const store = credentials()
    for (const key of state.selectedKeys) await store.unset(keyRef(key.id))
    await store.unset(API_KEY_ENV); await store.unset(PAT_REF)
    state = emptyState(); bump()
    await save()
    return describe()
  }

  function enqueue(work) {
    const result = queue.then(async () => {
      await ready
      if (loadError) throw fail('state_unavailable', loadError.message)
      if (disposed) throw fail('disposed', 'plugin is no longer active')
      return work()
    })
    queue = result.catch(() => {})
    return result
  }
  function scheduleCostSync(refreshIfStale = false) {
    if (disposed) return
    startupRefresh ||= refreshIfStale
    syncRequested = true
    if (syncScheduled) return
    syncScheduled = true
    void enqueue(async () => {
      do {
        syncRequested = false
        const shouldRefresh = startupRefresh
        startupRefresh = false
        await syncCosts()
        const snapshots = new Map(state.priceSnapshots.map(row => [pair(row.keyId, row.modelId), row]))
        const stale = state.confirmed.some(row => {
          const at = Date.parse(snapshots.get(pair(row.keyId, row.modelId))?.at)
          return !Number.isFinite(at) || Date.now() - at >= state.costBinding.refreshMinutes * 60_000
        })
        if (!disposed && shouldRefresh && meter && state.confirmed.length && stale) {
          try { await previewModels({ force: true }) }
          catch { await syncCosts({ stale: true }) }
        }
      } while (!disposed && syncRequested)
    }).catch(() => {}).finally(() => {
      syncScheduled = false
      if (!disposed && syncRequested) scheduleCostSync()
    })
  }
  const operations = { describe, connect, disconnect, listKeys, selectKeys, setGroup, previewModels, confirmModels, registerModels, unregisterModels, saveCostBinding, refresh }
  function dispatch(method, params) {
    if (typeof method !== 'string' || !Object.hasOwn(operations, method)) return Promise.reject(fail('unknown_method', 'unknown NikoAPI operation'))
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return Promise.reject(fail('bad_input', 'operation parameters must be an object'))
    // Local reads do not wait behind an unrelated remote refresh.
    if (method === 'describe') return ready.then(() => {
      if (loadError) throw fail('state_unavailable', loadError.message)
      if (disposed) throw fail('disposed', 'plugin is no longer active')
      return describe()
    })
    return enqueue(() => operations[method](params ?? {}))
  }
  ctx.inject(['webServer'], web => {
    web.effect(() => web.webServer.register({ kind: 'prefix', path: '/nikoapi/api', handler: async (req, res) => {
      if (!isTrustedRequest(req, ctx.get('webStartup')?.trustedHosts ?? [])) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      if (!String(headerOf(req.headers, 'content-type') ?? '').toLowerCase().startsWith('application/json')) return sendJson(res, 400, { ok: false, error: { code: 'bad_body', message: 'JSON content-type required' } })
      let payload
      try { payload = await readJsonBody(req) } catch { return sendJson(res, 400, { ok: false, error: { code: 'bad_body', message: 'request must be JSON under 256 KiB' } }) }
      try { sendJson(res, 200, { ok: true, data: await dispatch(payload?.method, payload?.params) }) }
      catch (error) {
        const failure = safeFailure(error)
        const operation = typeof payload?.method === 'string' && Object.hasOwn(operations, payload.method) ? payload.method : 'unknown'
        const diagnostic = failureDiagnosticFields(operation, error, failure.code)
        ctx.logger?.warn?.(formatFailureDiagnostic(operation, error, failure.code))
        sendJson(res, ['unknown_method', 'bad_input'].includes(failure.code) ? 400 : 200, { ok: false, error: {
          code: failure.code, message: failure.message, scope: failure.scope,
          diagnostic: { method: diagnostic.operation, errorType: diagnostic.errorName, errorCode: diagnostic.errorCode },
        } })
      }
    } }), 'nikoapi: web api')
  })
  ctx.inject(['costMeter'], linked => {
    linked.effect(() => {
      const service = linked.get('costMeter')
      if (typeof service?.registerPriceCalculator !== 'function' || typeof service?.getLocalState !== 'function') return
      clearCalculators()
      meter = service; meterConfig = null; meterEpoch++
      scheduleCostSync(true)
      return () => {
        if (meter !== service) return
        meterEpoch++; meter = null; meterConfig = null
        clearCalculators()
        state.costBinding.lastStatus = 'waiting'
        state.costBinding.lastMessage = 'waiting for cost-meter 1.9.78 or later'
      }
    }, 'nikoapi: official price calculators')
  })
  ctx.on?.('settings/document-updated', (ns, revision) => {
    if (ownRouteRevision?.ns === ns && ownRouteRevision.revision === revision) { ownRouteRevision = null; return }
    if (ns === providerNamespace()) scheduleCostSync()
  })
  ctx.effect(() => {
    let lastTimer = Date.now(), timerPending = false
    const timer = setInterval(() => {
      if (disposed || timerPending || !meter || !state.confirmed.length || Date.now() - lastTimer < state.costBinding.refreshMinutes * 60_000) return
      timerPending = true; lastTimer = Date.now()
      void dispatch('refresh').catch(() => enqueue(() => syncCosts({ stale: true })).catch(() => {})).finally(() => { timerPending = false })
    }, 30_000)
    timer.unref?.()
    return () => { disposed = true; clearInterval(timer); meterEpoch++; clearCalculators(); meter = null; meterConfig = null }
  }, 'nikoapi: refresh timer')
}

function headerOf(headers, name) { const value = headers?.[name]; return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined }
function loopback(host) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase()) }
export function isTrustedRequest(req, trustedHosts = []) {
  const host = headerOf(req.headers, 'host')
  if (!host || /[\s\/@?#]/.test(host)) return false
  try {
    const expected = new URL(`${req.socket?.encrypted ? 'https:' : 'http:'}//${host}`)
    const trusted = Array.isArray(trustedHosts) && trustedHosts.some(value => typeof value === 'string' && value.toLowerCase() === expected.host.toLowerCase())
    if (!loopback(expected.hostname) && !trusted) return false
    if (headerOf(req.headers, 'sec-fetch-site') === 'cross-site') return false
    const raw = headerOf(req.headers, 'origin')
    if (!raw) return !headerOf(req.headers, 'sec-fetch-site')
    const requestOrigin = new URL(raw)
    return requestOrigin.origin === expected.origin && requestOrigin.href === `${requestOrigin.origin}/` && !requestOrigin.username && !requestOrigin.password
  } catch { return false }
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
async function readJsonBody(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new Error('body too large'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export { hasExpressionBilling }
