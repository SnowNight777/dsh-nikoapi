/** Plan cost-meter edits. Never write a partial replacement table or claim foreign configuration. */
export const BALANCE_LABEL = 'NikoAPI'
export const PRICE_PROVIDER = 'nikoapi'
export const BALANCE_VAR = 'NIKOAPI_MANAGEMENT_TOKEN'
const UNPRICED_NOTE = 'dsh-nikoapi: unavailable rate; '

/**
 * Portable account-balance template supplied by the user.
 * The final screenshot selects CNY as the source currency (no FX conversion).
 * extract.unit is retained verbatim; cost-meter's top-level unit takes precedence.
 * /api/user/self requires an account credential with profile:read, not a model Key.
 */
export function balanceEntry({ origin, refreshMinutes = 15, credentialVar = BALANCE_VAR }) {
  const site = new URL(origin)
  return {
    enabled: true, display: 'both', refreshMinutes,
    label: BALANCE_LABEL, labelEn: BALANCE_LABEL,
    unit: 'CNY', convertToDisplayCurrency: false,
    dashboardUrl: `${site.origin}/console`, allowedHosts: [site.host], allowInsecureHttp: false,
    request: { url: `${site.origin}/api/user/self`, method: 'GET', headers: { Authorization: `Bearer {{${credentialVar}}}` } },
    extract: { remaining: { op: 'divide', path: 'data.quota', by: 500_000 }, maxBudget: 200, spend: 'info.spend', unit: 'USD' },
  }
}

function credentialOf(entry) {
  const value = Object.entries(entry?.request?.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
  return typeof value === 'string' ? /^Bearer\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/i.exec(value)?.[1] : undefined
}

/** A user's working account query can be reused, but never rewritten or claimed as ours. */
export function isNikoAccountBalance(entry, origin) {
  if (!entry || typeof entry !== 'object') return false
  const extract = entry.extract ?? {}
  return entry.request?.url === `${new URL(origin).origin}/api/user/self`
    && (entry.request?.method ?? 'GET').toUpperCase() === 'GET' && !!credentialOf(entry)
    && entry.unit === 'CNY' && entry.convertToDisplayCurrency !== true
    && extract.remaining?.op === 'divide' && extract.remaining.path === 'data.quota' && extract.remaining.by === 500_000
    && extract.maxBudget === 200 && extract.spend === 'info.spend'
}

/** Recognize the *old generated shape* only in conjunction with the persisted ownership reference. */
function isLegacyShape(entry) {
  const extract = entry?.extract ?? {}
  return entry?.label === BALANCE_LABEL && (entry.request?.method ?? 'GET') === 'GET'
    && extract.remaining?.op === 'divide' && extract.remaining.path === 'data.total_available' && extract.remaining.by > 0
    && extract.maxBudget?.op === 'divide' && extract.maxBudget.path === 'data.total_granted' && extract.maxBudget.by === extract.remaining.by
    && extract.spend?.op === 'divide' && extract.spend.path === 'data.total_used' && extract.spend.by === extract.remaining.by
}
function ownedBalanceMatches(entry, ownership, origin) {
  if (!ownership?.url || !ownership?.credentialVar || entry?.request?.url !== ownership.url || credentialOf(entry) !== ownership.credentialVar) return false
  const site = new URL(origin ?? ownership.url).origin
  return isNikoAccountBalance(entry, site) || (ownership.url === `${site}/api/usage/token/` && isLegacyShape(entry))
}

export const priceKeyOf = (provider, model) => `${provider}:${model}`
function splitPriceKey(key) {
  const at = typeof key === 'string' ? key.indexOf(':') : -1
  return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : []
}
function marker(entry) { return entry?.unpriced === true && entry.notes?.startsWith(UNPRICED_NOTE) === true }
function mutableProvider(config, changes, provider) {
  if (!Object.hasOwn(changes, provider)) {
    const previous = config.prices?.providers?.[provider] ?? {}
    changes[provider] = { ...previous, models: { ...(previous.models ?? {}) } }
  }
  return changes[provider].models
}
function removeMarker(config, changes, key) {
  const [provider, model] = splitPriceKey(key)
  if (!provider) return
  const current = (changes[provider]?.models ?? config.prices?.providers?.[provider]?.models ?? {})[model]
  if (marker(current)) delete mutableProvider(config, changes, provider)[model]
}
function exactPrice(price) {
  return price?.kind === 'perMillion' && price.reference !== true && ['USD', 'CNY'].includes(price.currency)
    && ['input', 'output', 'cacheHit'].every(key => Number.isFinite(price[key]) && price[key] >= 0)
}

export function planBinding(current, options) {
  const config = current ?? {}
  let balances = [...(config.customBalances ?? [])]
  const previousOwned = options.ownedBalance
  const oldMatches = balances.filter(entry => ownedBalanceMatches(entry, previousOwned, options.origin))
  // Migrate only the precisely owned wrong token-quota entry. Ambiguous/untracked entries stay untouched.
  if (oldMatches.length === 1 && isLegacyShape(oldMatches[0])) balances = balances.filter(entry => entry !== oldMatches[0])
  let index = balances.findIndex(entry => isNikoAccountBalance(entry, options.origin))
  const created = index < 0
  if (created && balances.length >= 8) return { ok: false, reason: 'cost-meter already holds 8 custom balance entries; no existing entry was changed' }
  let ownedBalance = null
  if (created) {
    index = balances.length
    balances.push(balanceEntry(options))
    ownedBalance = { url: balances[index].request.url, credentialVar: options.credentialVar ?? BALANCE_VAR }
  } else if (ownedBalanceMatches(balances[index], previousOwned, options.origin)) {
    ownedBalance = previousOwned
  }

  const overrides = { ...(config.priceOverrides ?? {}) }
  const custom = { ...(config.prices?.custom ?? {}) }
  const providerChanges = {}
  const owned = new Set(options.ownedPriceKeys ?? [])
  const ownedUnknown = new Set(options.ownedUnpricedKeys ?? [])
  const expected = new Set(options.models.map(model => priceKeyOf(model.provider || PRICE_PROVIDER, model.id)))
  for (const key of owned) if (!expected.has(key)) {
    if (overrides[key] === '__custom__') { delete overrides[key]; delete custom[key] }
  }
  for (const key of ownedUnknown) if (!expected.has(key)) removeMarker(config, providerChanges, key)

  const priced = [], unpriced = [], conflicts = [], ownedPriceKeys = [], ownedUnpricedKeys = []
  for (const model of options.models) {
    const provider = model.provider || PRICE_PROVIDER
    const key = priceKeyOf(provider, model.id)
    const oldTable = config.prices?.providers?.[provider]?.models ?? {}
    // An explicit user mapping wins. Do not replace it, even if it uses the same provider/model name.
    if ((Object.hasOwn(overrides, key) && !owned.has(key))
      || (Object.hasOwn(custom, key) && !owned.has(key))
      || (Object.hasOwn(oldTable, model.id) && !(ownedUnknown.has(key) && marker(oldTable[model.id])))) {
      conflicts.push({ key, reason: 'existing user price kept' })
      continue
    }
    if (exactPrice(model.price)) {
      removeMarker(config, providerChanges, key)
      overrides[key] = '__custom__'
      custom[key] = { currency: model.price.currency, cacheMiss: model.price.input, cacheHit: model.price.cacheHit, output: model.price.output,
        ...(Number.isFinite(model.price.cacheWrite) ? { cacheWrite: model.price.cacheWrite } : {}) }
      ownedPriceKeys.push(key)
      priced.push({ provider, id: model.id, key })
    } else {
      if (owned.has(key) && overrides[key] === '__custom__') { delete overrides[key]; delete custom[key] }
      // __custom__ requires three numeric buckets and CANNOT carry unpriced. Use the real provider-table contract.
      mutableProvider(config, providerChanges, provider)[model.id] = {
        unpriced: true, notes: UNPRICED_NOTE + (model.price?.note || 'the API does not provide an exact representable tariff'),
        sourceUrl: `${new URL(options.origin).origin}/api/pricing`,
      }
      ownedUnpricedKeys.push(key)
      unpriced.push({ provider, id: model.id, key, kind: model.price?.kind ?? 'unknown', note: model.price?.note ?? '' })
    }
  }
  return { ok: true,
    patch: { customBalances: balances, priceOverrides: overrides,
      prices: { custom, ...(Object.keys(providerChanges).length ? { providers: providerChanges } : {}) } },
    summary: { balanceIndex: index, balance: ownedBalance, balanceCreated: created, balanceReused: !created,
      legacyBalanceRetained: oldMatches.length > 1, priced, unpriced, conflicts, ownedPriceKeys, ownedUnpricedKeys },
  }
}

/** Remove precisely owned generated entries; an existing working account template is never owned. */
export function planUnbind(current, ownership = {}) {
  const config = current ?? {}
  const rows = [...(config.customBalances ?? [])]
  const matches = rows.filter(entry => ownedBalanceMatches(entry, ownership.balance))
  const balances = matches.length === 1 ? rows.filter(entry => entry !== matches[0]) : rows
  const overrides = { ...(config.priceOverrides ?? {}) }, custom = { ...(config.prices?.custom ?? {}) }, providerChanges = {}
  const removed = []
  for (const key of new Set(ownership.ownedPriceKeys ?? [])) {
    if (overrides[key] === '__custom__') { delete overrides[key]; delete custom[key]; removed.push(key) }
  }
  for (const key of new Set(ownership.ownedUnpricedKeys ?? [])) removeMarker(config, providerChanges, key)
  return { patch: { customBalances: balances, priceOverrides: overrides,
    prices: { custom, ...(Object.keys(providerChanges).length ? { providers: providerChanges } : {}) } },
    removed, legacyBalanceAmbiguous: false, balanceRetained: matches.length > 1 }
}
