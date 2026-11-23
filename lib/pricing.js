import { analyzeNikoBillingExpression } from './billing-expression.js'

/**
 * Price normalization: New API ratio rows to per-million-token money.
 *
 * Upstream math (verified against the deployed fork's `service/quota.go`):
 * a token-billed call costs `tokens * model_ratio * group_ratio` quota, and
 * `quota_per_unit` quota make one display-currency unit. So one million input
 * tokens cost `1e6 * model_ratio * group_ratio / quota_per_unit`.
 *
 * Fixed token prices remain compatible with the original normalizer. Niko
 * expressions are retained as dynamic snapshots; missing billing context stays unknown.
 */

/**
 * @param {object[]} rows `/api/pricing` rows
 * @param {object} context
 * @param {Record<string, number>} context.groupRatio
 * @param {number} context.quotaPerUnit
 * @param {string} context.currency
 * @param {string[]} [context.candidateGroups] groups the selected key may use
 * @param {boolean} [context.reference] whether pricing is only a reference
 * @param {boolean} [context.unknownGroup] whether the key has no known billing group
 * @returns {Map<string, object>} model id → price fact
 */
export function normalizePricing(rows, context) {
  const prices = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = typeof row?.model_name === 'string' ? row.model_name : ''
    if (id === '') continue
    prices.set(id, priceOf(row, context))
  }
  return prices
}

function priceOf(row, context) {
  const currency = context.currency
  const quotaPerUnit = context.quotaPerUnit > 0 ? context.quotaPerUnit : 500_000
  if (Array.isArray(row?.supported_endpoint_types) && row.supported_endpoint_types.includes('image-generation')) {
    return { kind: 'nikoZero', currency: 'CNY', expression: typeof row.billing_expr === 'string' ? row.billing_expr.trim() : '',
      groupRatio: 1, quotaPerUnit, zeroByPolicy: true, adapterSupported: true,
      note: 'image-generation requests are excluded by the local zero-cost policy', enableGroups: enableGroupsOf(row) }
  }
  if (hasExpressionBilling(row)) {
    const ratios = ratioCandidates(row, context)
    const expression = typeof row?.billing_expr === 'string' ? row.billing_expr.trim() : ''
    const analyzed = analyzeNikoBillingExpression(expression)
    const unsupported = !analyzed.supported && !analyzed.zeroByPolicy
    if (context.currency !== 'CNY' || ratios.kind !== 'ratio' || ratios.range === true || expression === '' || unsupported) {
      return { kind: 'unknown', currency, note: context.currency !== 'CNY' ? 'site billing currency is not CNY'
        : ratios.kind !== 'ratio' ? ratios.note
        : ratios.range ? 'group ratio varies per request; request group cannot be inferred safely'
          : unsupported ? analyzed.reason : 'billing expression is missing',
      groups: ratios.groups, enableGroups: enableGroupsOf(row) }
    }
    const shared = { currency: 'CNY', expression, groupRatio: ratios.ratio,
      usdExchangeRate: Number.isFinite(context.usdExchangeRate) && context.usdExchangeRate > 0 ? context.usdExchangeRate : 1,
      quotaPerUnit, groups: ratios.groups, reference: ratios.reference, enableGroups: enableGroupsOf(row), note: ratios.note }
    if (analyzed.zeroByPolicy) return { kind: 'nikoZero', ...shared, zeroByPolicy: true, adapterSupported: true,
      note: analyzed.reason || 'billing expression uses a field excluded by the local policy' }
    return { kind: 'nikoExpression', ...shared }
  }
  const ratios = ratioCandidates(row, context)
  if (ratios.kind !== 'ratio') {
    return { kind: ratios.kind, currency, note: ratios.note, groups: ratios.groups, enableGroups: enableGroupsOf(row) }
  }
  const base = ratios.ratio
  if (!(base > 0)) {
    return { kind: 'unknown', currency, note: 'group ratio unavailable', groups: ratios.groups, enableGroups: enableGroupsOf(row) }
  }
  const quotaType = row.quota_type
  if (quotaType === 1) {
    if (currency !== 'CNY') return { kind: 'unknown', currency, note: 'site billing currency is not CNY', groups: ratios.groups, enableGroups: enableGroupsOf(row) }
    const perCall = number(row.model_price)
    if (perCall === null) return { kind: 'unknown', currency, note: 'per-call price missing', groups: ratios.groups, enableGroups: enableGroupsOf(row) }
    return {
      kind: 'perCall',
      currency,
      perCall: round(perCall * base),
      groups: ratios.groups,
      reference: ratios.reference,
      enableGroups: enableGroupsOf(row),
      note: 'billed per call; not convertible to a per-token rate',
    }
  }
  const modelRatio = number(row.model_ratio)
  if (modelRatio === null) return { kind: 'unknown', currency, note: 'model ratio missing', groups: ratios.groups, enableGroups: enableGroupsOf(row) }
  const perMillion = ratio => round(1_000_000 * ratio * base / quotaPerUnit)
  const input = perMillion(modelRatio)
  const completion = number(row.completion_ratio)
  const cacheRatio = number(row.cache_ratio)
  const createCacheRatio = number(row.create_cache_ratio)
  if (completion === null) {
    return { kind: 'unknown', currency, note: 'completion ratio is missing', groups: ratios.groups, enableGroups: enableGroupsOf(row) }
  }
  const cacheInputFactor = cacheRatio ?? 1
  const output = perMillion(modelRatio * completion)
  const cacheHit = perMillion(modelRatio * cacheInputFactor)
  const cacheWriteRatio = createCacheRatio === null ? cacheInputFactor : createCacheRatio
  const cacheWrite = perMillion(modelRatio * cacheWriteRatio)
  return {
    kind: 'perMillion',
    currency,
    input,
    output,
    cacheHit,
    cacheWrite,
    groups: ratios.groups,
    reference: ratios.reference,
    enableGroups: enableGroupsOf(row),
    note: ratios.note,
  }
}

/**
 * Which group ratio applies to this row for the selected key.
 * A fixed-group key has one answer. An auto key has a range, and the site
 * picks at request time, so the cheapest candidate is reported as a reference
 * price and flagged.
 */
function ratioCandidates(row, context) {
  const groupRatio = context.groupRatio ?? {}
  const enableGroups = enableGroupsOf(row)
  const usable = (context.candidateGroups ?? []).filter(group => group !== 'auto')
  if (context.unknownGroup === true && usable.length === 0) return { kind: 'unknown', note: 'key billing group is unknown', groups: [] }
  const candidates = usable.length > 0 ? usable : Object.keys(groupRatio)
  const applicable = candidates.filter(group => enableGroups.length === 0 || enableGroups.includes('all') || enableGroups.includes(group))
  if (usable.length > 0 && applicable.length === 0) return { kind: 'unknown', note: 'model is not enabled for the key group', groups: [] }
  const pool = applicable.length > 0 ? applicable : candidates
  const rawValues = pool.map(group => number(groupRatio[group]))
  if (rawValues.length === 0 || rawValues.some(value => value === null)) return { kind: 'unknown', note: 'group ratio missing for one or more possible key groups', groups: pool }
  const values = rawValues
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min !== max) {
    return {
      kind: 'ratio',
      ratio: min,
      groups: pool,
      reference: true,
      range: true,
      minRatio: min,
      maxRatio: max,
      note: context.reference === true ? `auto group: ${min}×–${max}× depending on the server's choice; shown at the lowest ratio` : `multiple possible groups: ${min}×–${max}×; shown at the lowest ratio`,
    }
  }
  return { kind: 'ratio', ratio: min, groups: pool, reference: context.reference === true || pool.length > 1, note: context.reference === true ? `auto group: estimated at the lowest of ${pool.length} candidate ratios` : pool.length > 1 ? `multiple groups: ${pool.length} candidates at ${min}×` : undefined }
}

function enableGroupsOf(row) {
  if (Array.isArray(row?.enable_groups)) return row.enable_groups.filter(group => typeof group === 'string')
  if (Array.isArray(row?.enable_group)) return row.enable_group.filter(group => typeof group === 'string')
  return []
}

/** Billing expressions cannot be evaluated here, and `model_price: 0` is not free. */
export function hasExpressionBilling(row) {
  const mode = typeof row?.billing_mode === 'string' ? row.billing_mode : ''
  const expr = typeof row?.billing_expr === 'string' ? row.billing_expr.trim() : ''
  return mode === 'tiered_expr' || expr !== ''
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function round(value) {
  return Math.round(value * 1e8) / 1e8
}
