import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { normalizePricing } from '../lib/pricing.js'
import { calculatePrice, hasManualPrice } from '../lib/price-calculator.js'
import { startMockNiko, PAT_FULL, MODEL_KEY } from './mock-niko.mjs'
import { startMockHost } from './mock-host.mjs'

const require = createRequire(import.meta.url)
const calculatorModule = process.env.DSH_COST_METER_MODULE
let realApi
if (calculatorModule) realApi = await import(pathToFileURL(require.resolve(calculatorModule)).href)

const usage = { input: 100, output: 10, cacheRead: 5, cacheWrite: 2, reasoning: 3 }
const expression = normalizePricing([{ model_name: 'tiered-test', quota_type: 0, model_ratio: 1,
  billing_mode: 'tiered_expr', billing_expr: 'p * 2 + c * 10 + cr * 0.2 + cc * 2.5', enable_groups: ['default'] }],
  { currency: 'CNY', quotaPerUnit: 500_000, candidateGroups: ['default'], groupRatio: { default: 0.5 } }).get('tiered-test')
assert.equal(expression.kind, 'nikoExpression')
const exprQuote = calculatePrice(expression, usage, Date.UTC(2026, 0, 1))
assert.equal(exprQuote.currency, 'CNY')
assert(Math.abs(Object.values(exprQuote.breakdown).reduce((a, b) => a + b, 0) - exprQuote.total) <= 1e-12)
assert.equal(exprQuote.breakdown.reasoning, 0, 'reasoning is already counted in output')
assert.equal(calculatePrice({ kind: 'perMillion', currency: 'EUR', input: 1, output: 2, cacheHit: .1 }, usage, 0).currency, 'EUR')
assert.equal(calculatePrice({ kind: 'perMillion', currency: 'USD', input: 1, output: 2, cacheHit: .1, reference: true }, usage, 0), null)
assert.equal(calculatePrice({ kind: 'unknown', currency: 'CNY' }, usage, 0), null)
const requestQuote = calculatePrice({ kind: 'perCall', currency: 'CNY', perCall: 0.1 }, usage, 0)
assert.equal(requestQuote.total, 0.1)
assert.equal(requestQuote.breakdown, undefined, 'request prices have no legal token-bucket breakdown')

const mock = await startMockNiko({ expressionModel: true })
mock.setExpression('p * 2 + c * 10 + cr * 0.2 + cc * 2.5')
try {
  let host = await startMockHost(mock.origin, null, { calculatorApi: realApi })
  try {
    const noNetwork = await host.call('describe')
    assert.equal(noNetwork.body.ok, true)
    assert.equal(mock.requests.get('/api/token/'), undefined, 'describe does not list Keys')
    assert.equal(host.stats.localStateReads, 0, 'page describe does not invoke cost-meter balance refresh')
    const connected = await host.call('connect', { managementToken: PAT_FULL })
    assert.equal(connected.body.ok, true, JSON.stringify(connected.body))
    assert.equal(mock.requests.get('/api/token/'), 2, 'connect validates then loads the Key directory')
    assert.equal((await host.call('selectKeys', { keys: [{ id: 11 }] })).body.ok, true)
    const preview = await host.call('previewModels', { force: true })
    assert.equal(preview.body.ok, true, JSON.stringify(preview.body))
    assert(preview.body.data.keys[0].models.some(row => row.modelId === 'tiered-test'))
    const confirmed = await host.call('confirmModels', { selections: [{ keyId: 11, modelIds: ['tiered-test'] }] })
    assert.equal(confirmed.body.ok, true, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.data.cost.registeredCount, 1)
    const quoted = host.quote('nikoapi-11', 'tiered-test', usage, Date.UTC(2026, 0, 1))
    assert.equal(quoted.currency, 'CNY')
    assert.equal(quoted.total, exprQuote.total)
    assert.deepEqual(quoted.usage, usage)
    assert(quoted.fx.USD > 0)
    assert.equal(host.stats.registrations, 1)
    assert.equal(host.stats.localStateReads, 1, 'only automatic synchronization reads local config')

    mock.setExpression('p * 4 + c * 20 + cr * 0.4 + cc * 5')
    const refreshed = await host.call('previewModels', { force: true })
    assert.equal(refreshed.body.ok, true, JSON.stringify(refreshed.body))
    const next = host.quote('nikoapi-11', 'tiered-test', usage, Date.UTC(2026, 0, 1))
    assert(next.total > quoted.total, 'refresh updates the registered quote without duplicate route registration')
    assert.equal(host.stats.registrations, 1)

    const keyListRequests = mock.requests.get('/api/token/')
    await host.call('describe')
    await host.call('describe')
    assert.equal(mock.requests.get('/api/token/'), keyListRequests, 'cached Settings describe never refreshes remote Keys')

    const stored = await host.readState()
    const savedProviders = structuredClone(host.providers)
    const savedSecrets = [...host.secrets]
    await host.close()
    host = null
    host = await startMockHost(mock.origin, stored, { calculatorApi: realApi, providers: savedProviders, secrets: savedSecrets })
    const restarted = await host.call('describe')
    assert.equal(restarted.body.data.keyDirectory.keys.length > 0, true, 'restart has a safe Key cache')
    assert.equal(mock.requests.get('/api/token/'), keyListRequests, 'cached page entry does not make a network call after restart')
    assert.equal(await host.waitFor(() => host.stats.registrations === 1), true, 'startup sync completes without a user save action')
    assert.equal((await host.call('describe')).body.data.cost.registeredCount, 1, 'saved confirmed model is auto-linked after restart')
    assert(host.quote('nikoapi-11', 'tiered-test', usage), 'the refreshed, confirmed model has an active quote after restart')

    const manualConfig = structuredClone(host.meterConfig)
    manualConfig.prices.providers['nikoapi-11'] = { models: { 'tiered-test': { input: 99, output: 99 } } }
    host.setMeterConfig(manualConfig)
    host.emitSettingsUpdated()
    await host.flush()
    assert.equal(host.stats.disposals, 1, 'settings conflict releases the Niko calculator')
    assert.equal(host.quote('nikoapi-11', 'tiered-test', usage), null)
    assert.equal(host.meterConfig.prices.providers['nikoapi-11'].models['tiered-test'].input, 99, 'manual price remains untouched')
    assert.equal(hasManualPrice(manualConfig, 'nikoapi-11', 'tiered-test'), true)

    host.setMeterConfig({ customBalances: [{ label: 'Other wallet' }], priceOverrides: {}, prices: { custom: {}, providers: {} } })
    host.emitSettingsUpdated()
    await host.flush()
    assert.equal(host.stats.registrations, 2, 'removed manual conflict permits re-registration at the next sync')
    assert.deepEqual(host.meterConfig.customBalances, [{ label: 'Other wallet' }])

    host.setCostMeterAvailable(false)
    assert.equal(host.stats.disposals, 2, 'service unload disposes all calculator callbacks')
    assert.equal(host.quote('nikoapi-11', 'tiered-test', usage), null)
    host.setCostMeterAvailable(true)
    await host.flush()
    assert.equal(host.stats.registrations, 3, 'service arrival re-links confirmed models without confirmation')

    mock.setModels(MODEL_KEY, [{ id: 'gpt-test', object: 'model' }, { id: 'claude-test', object: 'model' }])
    await host.call('previewModels', { force: true })
    assert.equal(host.stats.disposals, 3, 'a removed upstream model is unregistered on preview')
    assert.equal(host.quote('nikoapi-11', 'tiered-test', usage), null)
    const finalState = await host.readState()
    assert.equal(finalState.confirmed.some(row => row.modelId === 'tiered-test'), true, 'the user confirmation is retained; only the absent route is not priced')
    await host.close()
    host = null
    const restart = await startMockHost(mock.origin, finalState, { calculatorApi: realApi })
    try {
      const entry = await restart.call('describe')
      assert.equal(entry.body.data.keyDirectory.keys.length > 0, true, 'restart has a safe Key cache')
      assert.equal(mock.requests.get('/api/token/'), keyListRequests, 'cached page entry does not make a network call after restart')
      assert.equal(restart.quote('nikoapi-11', 'tiered-test', usage), null, 'stale prices never quote before an upstream refresh')
    } finally { await restart.close() }
  } finally { await host?.close() }
} finally { await mock.close() }

if (realApi) {
  const ledger = { days: {} }
  const dispose = realApi.registerPriceCalculator(ledger, { provider: 'nikoapi-test', model: 'fixture', calculate: () => exprQuote })
  assert.throws(() => realApi.registerPriceCalculator(ledger, { provider: 'nikoapi-test', model: 'fixture', calculate: () => exprQuote }), /already owns/)
  const quote = realApi.quoteUsage(ledger, 'nikoapi-test', 'fixture', usage, Date.UTC(2026, 0, 1), { currency: 'CNY', exchangeRate: 7.2 })
  assert.equal(quote.total, exprQuote.total)
  assert.deepEqual(quote.breakdown, exprQuote.breakdown)
  assert.deepEqual(quote.usage, usage)
  assert.equal(quote.fx.CNY, 7.2)
  assert.deepEqual(realApi.quoteUsage(ledger, 'nikoapi-test', 'missing', usage, 0, {}), null)
  dispose()
  assert.equal(realApi.quoteUsage(ledger, 'nikoapi-test', 'fixture', usage, Date.UTC(2026, 0, 1), {}), null)
}

const ui = await readFile(new URL('../client.js', import.meta.url), 'utf8')
assert(ui.includes("costAutomatic: '检测到 cost-meter 后自动联动"))
assert(ui.includes("costAutomatic: 'Automatically linked when cost-meter is detected"))
assert(ui.includes("setInfo(await call('describe'))"))
console.log(realApi ? 'Niko official calculator lifecycle, 1.9.78 Host contract, cache and UI regressions passed' : 'Niko calculator lifecycle, cache and UI regressions passed; set DSH_COST_METER_MODULE to exercise installed 1.9.78 API')
