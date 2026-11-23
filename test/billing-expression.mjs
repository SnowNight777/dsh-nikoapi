import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { analyzeNikoBillingExpression, nikoBillingBreakdown } from '../lib/billing-expression.js'
import { normalizePricing } from '../lib/pricing.js'
const entry = billingExpr => ({ billingExpr, billingQuotaPerUnit: 500_000, billingGroupRatio: 0.5 })
const tokens = { input: 100, output: 15, reasoning: 5, cacheRead: 100, cacheWrite: 0 }
const rate = 'len < 272000 ? tier("short", p * 5 + c * 30 + cr * 0.5 + cc * 6.25) : tier("long", p * 10 + c * 45 + cr * 1 + cc * 12.5)'
let checks = 0
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-12, `${a} != ${b}`)
const short = nikoBillingBreakdown(tokens, entry(rate), 0)
assert.equal(short.matchedTier, 'short'); near(short.cost, 0.0005)
near(short.rows.reduce((n,r)=>n+r.cost,0), short.cost)
assert.deepEqual(short.rows.map(r=>r.bucket), ['input','cacheRead','output']);
near(nikoBillingBreakdown({ ...tokens, cacheWrite: 50 }, entry(rate), 0).cost, 0.000656); checks++
// Cache is restored into p when the expression does not price it separately.
near(nikoBillingBreakdown(tokens, entry('tier("base", p * 5 + c * 30)'), 0).cost, 0.000726); checks++
// Reasoning is already contained in pi-ai output; never add it again.
assert.deepEqual(nikoBillingBreakdown(tokens, entry(rate), 0), nikoBillingBreakdown({ ...tokens, reasoning: 0 }, entry(rate), 0)); checks++
for (const [input, cached, tier, expected] of [[271999,0,'short',0.679998], [272000,0,'long',1.36], [1,271999,'long',0.136004]]) {
  const result = nikoBillingBreakdown({ input, cacheRead: cached, output: 0 }, entry(rate), 0)
  assert.equal(result.matchedTier, tier); near(result.cost, expected)
} checks++
const fixed = nikoBillingBreakdown({}, entry('tier("request", fixed(0.12))'), 0)
assert.equal(fixed.cost, 0.06); assert.equal(fixed.rows[0].requests, 1); checks++
assert.equal(nikoBillingBreakdown({}, entry('tier("free", fixed(0))'), 0).cost, 0); checks++
const ttl = analyzeNikoBillingExpression('tier("x", p * 2 + cc1h * 20)')
assert.equal(ttl.supported, true); assert.equal(ttl.zeroOnCacheWrite, true)
near(nikoBillingBreakdown({ input: 100, output: 2, cacheWrite: 0 }, entry('tier("x", p * 2 + cc1h * 20)'), 0).cost, 0.0001)
const ttlZero = nikoBillingBreakdown({ input: 100, output: 2, cacheWrite: 1 }, entry('tier("x", p * 2 + cc1h * 20)'), 0)
assert.equal(ttlZero.cost, 0); assert.deepEqual(ttlZero.rows, [{ bucket: 'modelRequests', tokens: 0, requests: 1, rate: 0, cost: 0, priced: true }])
const special = nikoBillingBreakdown({ input: 100, output: 2 }, entry('tier("video", u("seconds") * 0.1)'), 0)
assert.equal(special.cost, 0); assert.equal(special.rows[0].bucket, 'modelRequests'); assert.equal(special.rows[0].priced, true); checks++
const image = nikoBillingBreakdown({ input: 100, output: 2 }, entry('tier("image", fixed(0.12)) * image_count'), 0)
assert.equal(image.cost, 0); assert.equal(image.rows[0].requests, 1); checks++
near(nikoBillingBreakdown(tokens, entry('v1:tier("x", p * 5 + c * 30)'), 0).cost, 0.000726); checks++
for (const expr of [
  'tier("x", p * 1) * (hour("Asia/Shanghai") >= 12 ? 2 : -1)',
  'tier("x", p * 1) * (hour("Asia/Shanghai") >= 12 ? 2 : 1e308 * 2)',
  'tier("x", p * 1) + (hour("Asia/Shanghai") >= 12 ? 0 : 1)',
  'tier("x", hour("Asia/Shanghai") >= 12 ? 0 : 1)',
  'tier("x", p * c)', 'tier("x", fixed(1) + p)', 'tier("x", param("service_tier"))',
  'tier("x", header("authorization"))', 'process.exit(1)', 'p.constructor', 'v2:p*2', 'tier("x", p / (c - c))',
  'false ? tier("x", p*c) : tier("x", p)', '('.repeat(70)+'p'+')'.repeat(70)]) {
  assert.equal(analyzeNikoBillingExpression(expr).supported, false, expr)
  assert.equal(nikoBillingBreakdown(tokens, entry(expr), 0), null, expr)
} checks++
const time = 'hour("Asia/Shanghai") < 12 ? tier("early", p * 2) : tier("late", p * 3)'
assert.equal(nikoBillingBreakdown({ input:1e6, output:0 }, entry(time), Date.UTC(2026,10,18,3)).cost,1)
assert.equal(nikoBillingBreakdown({ input:1e6, output:0 }, entry(time), Date.UTC(2026,10,18,4)).cost,1.5); checks++
const deepseekFlashExpression = '(tier("标准计费", p * 1 + c * 4 + cr * 0.02)) * (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 && (weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") <= 5) ? 2 : 1) * (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18 && (weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") <= 5) ? 2 : 1)'
const deepseekFlashRow = { model_name: 'deepseek-v4.1-flash', quota_type: 0, model_ratio: 1, completion_ratio: 4,
  cache_ratio: 0.025, create_cache_ratio: 1.25, enable_groups: ['海外国模-openai协议'], billing_mode: 'tiered_expr', billing_expr: deepseekFlashExpression }
const deepseekFlash = normalizePricing([deepseekFlashRow], { currency: 'CNY', quotaPerUnit: 500_000,
  groupRatio: { '海外国模-openai协议': 0.05 }, candidateGroups: ['海外国模-openai协议'] }).get('deepseek-v4.1-flash')
assert.equal(deepseekFlash?.kind, 'nikoExpression', deepseekFlash?.note); checks++
const deepseekTokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }
const deepseekEntry = { billingExpr: deepseekFlash.expression, billingQuotaPerUnit: deepseekFlash.quotaPerUnit,
  billingGroupRatio: deepseekFlash.groupRatio }
// Asia/Shanghai local time. Nov 19 is a Thursday; Nov 21 is a Saturday.
for (const [day, hour, minute, factor] of [[19, 8, 59, 1], [19, 9, 0, 2], [19, 11, 59, 2], [19, 12, 0, 1],
  [19, 13, 59, 1], [19, 14, 0, 2], [19, 17, 59, 2], [19, 18, 0, 1], [21, 10, 0, 1], [21, 15, 0, 1]]) {
  const quote = nikoBillingBreakdown(deepseekTokens, deepseekEntry, Date.UTC(2026, 10, day, hour - 8, minute))
  assert.ok(quote, `Shanghai Nov ${day} ${hour}:${minute}`)
  assert.equal(quote.billingUnit, 'token')
  assert.deepEqual(quote.rows.map(row => row.bucket), ['input', 'cacheRead', 'output'])
  for (const [i, base] of [0.05, 0.001, 0.2].entries()) near(quote.rows[i].rate, base * factor)
  near(quote.cost, 0.251 * factor)
} checks++
const payload = JSON.parse(await fs.readFile(new URL('../../../evidence/public-pricing.json', import.meta.url), 'utf8'))
const expressionRows = payload.data.filter(row => row.billing_expr)
const supported = expressionRows.filter(row => analyzeNikoBillingExpression(row.billing_expr).supported)
for (const row of supported) {
  for (const length of [0,100000,200000,271999,272000,300000,1000000]) {
    const quote = nikoBillingBreakdown({ input:length, output:31, cacheRead:17, cacheWrite:0 }, entry(row.billing_expr), 0)
    assert.ok(quote && Number.isFinite(quote.cost), row.model_name)
    near(quote.rows.reduce((n,r)=>n+r.cost,0), quote.cost)
  }
} checks++
const admitted = payload.data.filter(row => {
  const kind = normalizePricing([row], { currency: 'CNY', quotaPerUnit: 500000,
    groupRatio: Object.fromEntries((row.enable_groups ?? ['test']).map(group => [group, .5])),
    candidateGroups: row.enable_groups?.slice(0, 1) ?? ['test'] }).get(row.model_name)?.kind
  return ['nikoExpression', 'nikoZero'].includes(kind)
})
console.log(JSON.stringify({ checks, snapshotRows:payload.data.length, expressionRows:expressionRows.length,
  automaticPricingModels: admitted.map(row=>row.model_name),
  distinctExpressions: new Set(expressionRows.map(r => r.billing_expr)).size,
  supportedModels: supported.map(r => r.model_name),
  zeroPolicyModels: expressionRows.filter(row => analyzeNikoBillingExpression(row.billing_expr).zeroByPolicy).map(row => ({ model: row.model_name, reason: analyzeNikoBillingExpression(row.billing_expr).reason })),
  unknownModels: expressionRows.filter(row => !supported.includes(row) && !analyzeNikoBillingExpression(row.billing_expr).zeroByPolicy).map(row => ({ model: row.model_name, reason: analyzeNikoBillingExpression(row.billing_expr).reason })) }, null, 2))
