/** Adapt preloaded Niko rates to cost-meter >=1.9.78's synchronous Host API. */
import { nikoBillingBreakdown } from './billing-expression.js'
import { priceSignature } from './costmeter-prices.js'

export const usageFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const amount = value => Number.isFinite(value) && value >= 0 && value <= 1e12
const own = (object, key) => Object.hasOwn(object ?? {}, key)

/** User prices are left in place. Legacy owned prices may be superseded in memory only. */
export function hasManualPrice(config, provider, model, ownership = {}) {
  const key = `${provider}:${model}`
  const table = config?.prices?.providers?.[provider]?.models
  const override = config?.priceOverrides?.[key]
  const custom = config?.prices?.custom
  if (!own(config?.priceOverrides, key) && !own(custom, key) && !own(table, model)) return false
  // Any explicit remapping/free rule is user-owned even if an old owned table survives.
  if (own(config?.priceOverrides, key) && override !== '__custom__') return true
  if (own(custom, key) && override !== '__custom__') return true
  const entry = override === '__custom__' ? custom?.[key] : table?.[model]
  const expected = ownership.ownedPriceSnapshots?.[key]
  return typeof expected !== 'string' || expected !== priceSignature(entry)
}

/** No fetching, credential reads, settings writes, or asynchronous work occurs here. */
export function calculatePrice(price, usage, atMs) {
  if (!Number.isFinite(atMs) || !price || price.reference === true || usageFields.some(key => !Number.isSafeInteger(usage?.[key] ?? 0) || (usage?.[key] ?? 0) < 0)) return null
  const tokens = Object.fromEntries(usageFields.map(key => [key, usage?.[key] ?? 0]))
  if (price.kind === 'perMillion') {
    if (price.reference === true || !['USD', 'CNY', 'EUR'].includes(price.currency)) return null
    const rates = { input: price.input, output: price.output, cacheRead: price.cacheHit, cacheWrite: price.cacheWrite ?? price.cacheHit }
    if (Object.values(rates).some(rate => !amount(rate))) return null
    // DSH output already includes reasoning tokens; do not charge reasoning a second time.
    const breakdown = Object.fromEntries(usageFields.map(key => [key, tokens[key] * (rates[key] ?? 0) / 1_000_000]))
    const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
    return amount(total) ? { currency: price.currency, total, breakdown, context: { version: 1 } } : null
  }
  if (!['nikoExpression', 'nikoZero', 'perCall'].includes(price.kind) || price.currency !== 'CNY') return null
  if (price.kind === 'perCall' && (price.reference === true || !amount(price.perCall))) return null
  const quote = nikoBillingBreakdown(tokens, {
    billingExpr: price.expression,
    billingQuotaPerUnit: price.quotaPerUnit,
    billingGroupRatio: price.groupRatio,
    ...(price.kind === 'nikoZero' ? { zeroByPolicy: true } : {}),
    ...(price.kind === 'perCall' ? { requestPriceCny: price.perCall } : {}),
  }, atMs)
  if (!quote || !amount(quote.cost)) return null
  const context = { version: 1 }
  if (amount(price.groupRatio)) context.multiplier = price.groupRatio
  // The official API has no modelRequests breakdown field. Keep legitimate request totals
  // without inventing token amounts; official web request fees remain cost-meter's concern.
  if (quote.billingUnit === 'request') return { currency: quote.currency, total: quote.cost, context }
  const breakdown = Object.fromEntries(usageFields.map(key => [key, 0]))
  for (const row of quote.rows) {
    if (!usageFields.includes(row.bucket) || !amount(row.cost)) return null
    breakdown[row.bucket] += row.cost
  }
  if (usageFields.some(key => !amount(breakdown[key]) || tokens[key] === 0 && breakdown[key] !== 0)) return null
  if (Math.abs(Object.values(breakdown).reduce((sum, value) => sum + value, 0) - quote.cost) > Math.max(1e-12, quote.cost * 1e-10)) return null
  return { currency: quote.currency, total: quote.cost, breakdown, context }
}

export function usablePrice(price, atMs) {
  try { return calculatePrice(price, { input: 1000, output: 200, cacheRead: 10, cacheWrite: 0, reasoning: 20 }, atMs) !== null }
  catch { return false }
}
