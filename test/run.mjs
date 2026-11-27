import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockNiko, PAT_FULL, PAT_READONLY, MODEL_KEY, SECOND_MODEL_KEY, THIRD_MODEL_KEY } from './mock-niko.mjs'
import { requestJson, HttpError, requireUrl, sameOrigin } from '../lib/http.js'
import { createNikoClient, NikoPermissionError } from '../lib/niko.js'
import { normalizePricing } from '../lib/pricing.js'
import { normalizeGroups, groupSecondary } from '../lib/groups.js'
import { planBinding, planUnbind, planBalanceBinding, BALANCE_LABEL } from '../lib/costmeter.js'
import { planPriceBinding, planPriceUnbind } from '../lib/costmeter-prices.js'
import { readState, writeState, mergeState, emptyState } from '../lib/state.js'
import { buildProviderRoute, findProvidersNamespace, groupProtocolMap, isGptModel, modelCapabilities, modelProtocols, planRoutes, registrationStatus, routeEntries, keyRef, keyRoute } from '../lib/models.js'
import { isTrustedRequest, failureDiagnosticFields, formatFailureDiagnostic } from '../index.js'
import { startMockHost } from './mock-host.mjs'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`) }
  catch (error) { failures.push({ name, error }); console.error(`FAIL  ${name}\n      ${error?.stack ?? error}`) }
}
const mock = await startMockNiko()
try {
  const client = createNikoClient({ baseUrl: mock.origin })
  await test('failure diagnostics expose only safe operation and error metadata', async () => {
    const error = Object.assign(new TypeError('management-token-secret'), { code: 'EACCES' })
    const fields = failureDiagnosticFields('selectKeys', error, 'operation_failed')
    assert.deepEqual(fields, { operation: 'selectKeys', failureCode: 'operation_failed', errorName: 'TypeError', causeCode: 'EACCES', errorCode: 'EACCES' })
    const line = formatFailureDiagnostic('selectKeys', error, 'operation_failed')
    assert.equal(line, 'nikoapi: operation_failed method=selectKeys error=TypeError cause=EACCES')
    assert.equal(JSON.stringify(fields).includes('management-token-secret'), false)
    const secretCode = Object.assign(new Error('private'), { code: 'sk123456789012345678901234567890123456' })
    assert.deepEqual(failureDiagnosticFields('token=secret', secretCode, 'x'.repeat(36)),
      { operation: 'unknown', failureCode: 'operation_failed', errorName: 'Error', causeCode: 'none', errorCode: 'operation_failed' })
  })
  await test('host API returns only safe failure metadata for client diagnostics', async () => {
    const host = await startMockHost(mock.origin)
    try {
      const result = await host.call('connect', { managementToken: '' })
      assert.equal(result.body.ok, false)
      assert.deepEqual(result.body.error.diagnostic, { method: 'connect', errorType: 'Error', errorCode: 'bad_input' })
      assert.equal(JSON.stringify(result.body.error.diagnostic).includes('management token is empty'), false)
      const selection = await host.call('selectKeys', { keys: [{ id: 11 }] })
      assert.deepEqual(selection.body.error.diagnostic,
        { method: 'selectKeys', errorType: 'Error', errorCode: 'pat_missing' })
    } finally { await host.close() }
  })
  await test('exact origin fence includes scheme, host and port', async () => {
    assert.equal(sameOrigin(new URL(mock.origin), new URL(mock.origin)), true)
    assert.equal(sameOrigin(new URL(mock.trapOrigin), new URL(mock.origin)), false)
    assert.throws(() => requireUrl(`${mock.trapOrigin}/x`, mock.origin), error => error instanceof HttpError && error.code === 'CROSS_ORIGIN')
    assert.throws(() => requireUrl('http://remote.example/x', 'http://remote.example'), error => error.code === 'BAD_SCHEME')
    assert.throws(() => requireUrl('https://user:pw@nikoapi.xyz/x', 'https://nikoapi.xyz'), error => error.code === 'BAD_URL')
  })
  await test('redirect is refused without sending bearer to the decoy', async () => {
    await assert.rejects(requestJson({ url: `${mock.origin}/redirect`, origin: mock.origin, headers: { authorization: `Bearer ${PAT_FULL}` } }), error => error.code === 'REDIRECT')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(mock.seenByTrap, [])
  })
  await test('site facts and pagination are complete', async () => {
    const site = await client.status()
    assert.equal(site.version, '2026.11.06-78a1a249')
    const result = await client.allKeys(PAT_FULL)
    assert.equal(result.complete, true)
    assert.deepEqual(result.items.map(row => row.id), [11, 12, 13])
  })
  await test('key metadata never exposes upstream key field', async () => {
    const keys = await client.listKeys(PAT_FULL, { size: 100 })
    assert.equal(keys.total, 3)
    assert.ok(keys.items.every(key => key.maskedKey === '••••'))
    assert.deepEqual(keys.items[1].autoGroups, ['default', 'vip'])
  })
  await test('bad management credentials and read-only scopes are explicit', async () => {
    await assert.rejects(client.listKeys('nap_wrong'), error => error.code === 'UNAUTHORIZED')
    await assert.rejects(client.revealKey(PAT_READONLY, 11), error => error instanceof NikoPermissionError && error.scope === 'api_key:reveal')
    await assert.rejects(client.updateGroup(PAT_READONLY, 11, { group: 'vip' }), error => error instanceof NikoPermissionError && error.scope === 'api_key:write')
  })
  await test('different Keys reveal different credentials and catalogs', async () => {
    assert.equal(await client.revealKey(PAT_FULL, 11), MODEL_KEY)
    assert.equal(await client.revealKey(PAT_FULL, 12), SECOND_MODEL_KEY)
    assert.equal(await client.revealKey(PAT_FULL, 13), THIRD_MODEL_KEY)
    assert.deepEqual((await client.listModels(MODEL_KEY)).map(row => row.id), ['gpt-test', 'claude-test'])
    assert.deepEqual((await client.listModels(SECOND_MODEL_KEY)).map(row => row.id), ['gpt-test', 'gemini-test'])
    assert.deepEqual((await client.listModels(THIRD_MODEL_KEY)).map(row => row.id), [])
  })
  await test('account prices require dashboard identity instead of accepting an anonymous model-key response', async () => {
    await assert.rejects(client.pricing(MODEL_KEY, { requireIdentity: true }), error => error.code === 'UNAUTHORIZED')
    assert.equal((await client.pricing(PAT_FULL, { requireIdentity: true })).groupRatio.default, 0.5)
  })
  await test('group picker data keeps id, exact description and ratio separate', async () => {
    const rows = normalizeGroups({ usableGroup: { default: '默认分组说明', vip: '开发组说明' }, groupRatio: { default: 0.5, vip: 0.2 } })
    assert.deepEqual(rows.map(({ id, name, desc, ratio }) => ({ id, name, desc, ratio })), [
      { id: 'default', name: 'default', desc: '默认分组说明', ratio: 0.5 },
      { id: 'vip', name: 'vip', desc: '开发组说明', ratio: 0.2 },
    ])
    assert.equal(groupSecondary(rows[0]), '默认分组说明')
  })
  await test('group update mutates remote metadata only after scope check', async () => {
    const updated = await client.updateGroup(PAT_FULL, 11, { group: 'vip' })
    assert.equal(updated.group, 'vip')
    assert.equal(mock.groupUpdates.at(-1).id, 11)
    const restored = await client.updateGroup(PAT_FULL, 11, { group: 'default' })
    assert.equal(restored.group, 'default')
  })
  await test('fixed, automatic and unknown group prices are not fabricated', async () => {
    const table = await client.pricing(PAT_FULL)
    const fixed = normalizePricing(table.rows, { groupRatio: table.groupRatio, quotaPerUnit: 500_000, currency: 'CNY', candidateGroups: ['default'] })
    assert.equal(fixed.get('gpt-test').input, 1)
    assert.equal(fixed.get('gpt-test').output, 2)
    assert.equal(fixed.get('gpt-test').cacheHit, 0.1)
    const auto = normalizePricing(table.rows, { groupRatio: table.groupRatio, quotaPerUnit: 500_000, currency: 'CNY', candidateGroups: ['default', 'vip'], reference: true })
    assert.equal(auto.get('gpt-test').reference, true)
    assert.equal(auto.get('gpt-test').input, 0.4)
    const unknown = normalizePricing(table.rows, { groupRatio: table.groupRatio, quotaPerUnit: 500_000, currency: 'CNY', unknownGroup: true })
    assert.equal(unknown.get('gpt-test').kind, 'unknown')
    assert.equal(fixed.get('per-call-test').kind, 'perCall')
    assert.equal(fixed.get('tiered-test').kind, 'nikoExpression')
    assert.equal(fixed.get('tiered-test').groupRatio, 0.5)
    const svip = normalizePricing(table.rows, { groupRatio: table.groupRatio, quotaPerUnit: 500_000, currency: 'CNY', candidateGroups: ['GPT官key'] }).get('o4-mini')
    assert.equal(svip.input, 0.165); assert.equal(svip.output, 0.165); assert.equal(svip.cacheHit, 0.165); assert.equal(svip.cacheWrite, 0.165)
    assert.equal(normalizePricing([{ model_name: 'missing' }], { groupRatio: { default: 1 }, quotaPerUnit: 1, currency: 'CNY', candidateGroups: ['default'] }).get('missing').kind, 'unknown')
  })
  await test('one provider preserves one credential per Key and selects one shared protocol', async () => {
    const routeA = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['gpt-test'], label: 'dev' })
    const routeB = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(12), modelIds: ['gpt-test'], label: 'general' })
    const response = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['gpt-test'], label: 'dev', protocol: 'openai-responses' })
    assert.equal(routeA.apiKeyEnv, 'NIKOAPI_API_KEY_11')
    assert.notEqual(routeA.apiKeyEnv, routeB.apiKeyEnv)
    assert.notEqual(routeA.displayName, routeB.displayName)
    assert.equal(routeA.baseURL, `${mock.origin}/v1`)
    assert.equal(response.api, 'openai-responses')
    assert.equal(keyRoute(11), 'nikoapi-11')
  })
  await test('Anthropic route defaults disable reasoning with false and preserve explicit capabilities', () => {
    const legacy = mergeState({ version: 4, selectedKeys: [{ id: 11 }], confirmed: [{
      keyId: 11, modelId: 'claude-test', protocols: ['anthropic-messages'],
      protocolIdentity: '["default",[],false]', ...modelCapabilities(),
    }] })
    const row = legacy.confirmed[0]
    const entries = [{ keyId: 11, modelIds: [row.modelId], models: [{ ...row, id: row.modelId }] }]
    const route = planRoutes([], entries, mock.origin).routes['nikoapi-11']
    assert.equal(route.api, 'anthropic-messages')
    assert.equal(route.baseURL, mock.origin, 'Anthropic SDK appends /v1 itself')
    assert.equal(route.models[0].reasoningEfforts, false, 'off-only maps are invalid in DSH; use false')
    assert.equal(row.reasoningEffortsDeclared, false, 'legacy normalized defaults are not server declarations')
    const explicit = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11),
      modelIds: ['claude-test'], protocol: 'anthropic-messages', models: [{
        id: 'claude-test', reasoningEffortsDeclared: true, reasoningEfforts: { off: null, high: 'vendor-high' },
      }] })
    assert.deepEqual(explicit.models[0].reasoningEfforts, { off: null, high: 'vendor-high' })
    explicit.models[0].reasoningEfforts = { off: null, low: 'user-low' }
    assert.equal(registrationStatus({ providers: { 'nikoapi-11': explicit } }, entries, mock.origin).registered, true,
      'user-adjusted capabilities do not trigger route rewrites')
    const disabled = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11),
      modelIds: ['claude-test'], protocol: 'anthropic-messages', models: [{
        id: 'claude-test', reasoningEffortsDeclared: true, reasoningEfforts: false,
      }] })
    assert.equal(disabled.models[0].reasoningEfforts, false)
  })
  await test('group protocol sets are shared across models and auto groups use their intersection', () => {
    const rows = [
      { model_name: 'gpt-x', enable_groups: ['mixed'], supported_endpoint_types: ['openai', 'openai-response'] },
      { model_name: 'claude-x', enable_groups: ['mixed'], supported_endpoint_types: ['anthropic', 'openai-response'] },
      { model_name: 'image', enable_groups: ['mixed'], supported_endpoint_types: ['image-generation'] },
      { model_name: 'ignored', enable_groups: ['unknown'], supported_endpoint_types: ['not-a-dsh-protocol'] },
      { model_name: 'a', enable_groups: ['a', 'mixed'], supported_endpoint_types: ['openai', 'openai-response'] },
      { model_name: 'b', enable_groups: ['b'], supported_endpoint_types: ['openai', 'anthropic'] },
    ]
    const groups = groupProtocolMap(rows, ['mixed', 'a', 'b', 'unknown'])
    assert.deepEqual(groups.get('mixed'), ['openai-completions', 'openai-responses', 'anthropic-messages'])
    const separateGroups = groupProtocolMap([
      { enable_groups: ['default', 'vip'], supported_endpoint_types: ['openai', 'openai-response'] },
      { enable_groups: ['default'], supported_endpoint_types: ['anthropic'] },
      { enable_groups: ['vip'], supported_endpoint_types: ['gemini'] },
    ], ['default', 'vip'])
    assert.deepEqual(separateGroups.get('default'), ['openai-completions', 'openai-responses', 'anthropic-messages'])
    assert.deepEqual(separateGroups.get('vip'), ['openai-completions', 'openai-responses', 'google-generative-ai'])
    assert.equal(groups.has('unknown'), false, 'unknown endpoint strings do not establish group support')
    const key = { group: 'mixed' }
    assert.deepEqual(modelProtocols({ supportedEndpoints: ['anthropic'] }, key, groups), groups.get('mixed'), 'same-group models share the group capability set')
    assert.deepEqual(modelProtocols({ supportedEndpoints: ['image-generation'] }, key, groups), ['openai-completions'], 'image-only models stay on the legacy route')
    assert.deepEqual(modelProtocols({ supportedEndpoints: ['openai'] }, { group: 'auto', autoGroups: ['a', 'b'] }, groups), ['openai-completions'], 'auto group protocols are intersected')
    const routes = routeEntries([{ keyId: 11, modelIds: ['gpt-x', 'claude-x'], models: [
      { id: 'gpt-x', protocols: groups.get('mixed') }, { id: 'claude-x', protocols: groups.get('mixed') },
    ] }])
    assert.deepEqual(routes.map(route => [route.providerId, route.protocol, ...route.modelIds]), [
      ['nikoapi-11', 'openai-responses', 'gpt-x', 'claude-x'],
    ])
    const gptOverride = routeEntries([{ keyId: 13, modelIds: ['gpt-6.2-astra'], models: [
      { id: 'gpt-6.2-astra', protocols: ['openai-completions'] },
    ] }])
    assert.equal(gptOverride[0].protocol, 'openai-responses', 'GPT uses Responses even when the site advertises only Chat')
    assert.equal(isGptModel({ id: 'openai/gpt-6.2-astra' }), true, 'provider-prefixed GPT IDs use the explicit GPT rule')
    assert.equal(isGptModel({ id: 'gpt-image-1', supportedEndpoints: ['image-generation'] }), false, 'image generation is not forced onto Responses')
    const nonGptRoute = routeEntries([{ keyId: 14, modelIds: ['claude-x'], models: [
      { id: 'claude-x', protocols: ['openai-completions'] },
    ] }])
    assert.equal(nonGptRoute[0].protocol, 'openai-completions', 'non-GPT models continue to follow advertised protocols')
    const singleProtocol = routeEntries([{ keyId: 12, modelIds: ['gpt-x', 'claude-x'], models: [
      { id: 'gpt-x', protocols: ['openai-responses'] }, { id: 'claude-x', protocols: ['anthropic-messages'] },
    ] }])
    assert.equal(singleProtocol[0].protocol, 'openai-responses', 'a confirmed GPT selects Responses on its Key’s single Provider')
    const plan = planRoutes([], [{ keyId: 11, modelIds: ['gpt-x', 'claude-x'], models: [
      { id: 'gpt-x', protocols: groups.get('mixed') }, { id: 'claude-x', protocols: groups.get('mixed') },
    ] }], mock.origin)
    assert.deepEqual(Object.keys(plan.routes), ['nikoapi-11'])
  })
  await test('route plans remove only previously owned ids, never prefix lookalikes', async () => {
    const plan = planRoutes(['nikoapi-11', 'nikoapi-12'], [{ keyId: 11, name: 'dev', modelIds: ['gpt-test'] }], mock.origin)
    assert.deepEqual(plan.removed, ['nikoapi-12'])
    assert.deepEqual(Object.keys(plan.routes), ['nikoapi-11'])
    assert.deepEqual(plan.routes['nikoapi-11'].models, [{ id: 'gpt-test', ...modelCapabilities() }])
    assert.deepEqual(planRoutes([], [], mock.origin).removed, [])
  })
  await test('settings namespace selection rejects ambiguity without guessing', async () => {
    assert.equal(findProvidersNamespace([{ settingsNs: 'llm', settingsPath: ['providers', 'x'] }]), 'llm')
    assert.equal(findProvidersNamespace([{ settingsNs: 'llm', settingsPath: ['models'] }]), null)
    assert.equal(findProvidersNamespace([{ settingsNs: 'a', settingsPath: ['providers'] }, { settingsNs: 'b', settingsPath: ['providers'] }]), null)
    assert.equal(findProvidersNamespace([{ settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'x'] }, { settingsNs: 'other', settingsPath: ['providers', 'x'] }]), 'llm-pi-ai')
  })
  await test('route readback checks key, protocol, endpoint and exact model set', async () => {
    const entries = [{ keyId: 11, modelIds: ['gpt-test'] }]
    const section = { providers: { [keyRoute(11)]: buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['gpt-test'], protocol: 'openai-responses' }) } }
    assert.equal(registrationStatus(section, entries, mock.origin).registered, true)
    assert.equal(registrationStatus({ providers: { ...section.providers, 'nikoapi-11': { ...section.providers['nikoapi-11'], apiKeyEnv: keyRef(12) } } }, entries, mock.origin).registered, false)
    assert.equal(registrationStatus({ providers: {} }, entries, mock.origin).missing[0], keyRoute(11))
  })
  await test('legacy balance cleanup treats zero matches as already removed', async () => {
    const result = planUnbind({ customBalances: [{ label: 'Other' }], priceOverrides: {}, prices: { custom: {} } }, { legacyBalance: true, ownedPriceKeys: [] })
    assert.equal(result.legacyBalanceAmbiguous, false)
    assert.deepEqual(result.patch.customBalances, [{ label: 'Other' }])
  })
  await test('cost meter preserves foreign entries and exact ownership', async () => {
    const current = { customBalances: [{ label: 'NikoAPI', request: { url: `${mock.origin}/api/usage/token/`, headers: { Authorization: 'Bearer {{OTHER}}' } } }, { label: 'Other' }],
      priceOverrides: { 'openai:gpt-x': '__custom__' }, prices: { custom: { 'openai:gpt-x': { currency: 'USD', cacheHit: 0, cacheMiss: 1, output: 2 } } } }
    const model = { provider: 'nikoapi-11', id: 'gpt-test', price: { kind: 'perMillion', currency: 'CNY', input: 1, output: 2, cacheHit: 0.1 } }
    const first = planBinding(current, { origin: mock.origin, currency: 'CNY', quotaPerUnit: 500000, refreshMinutes: 15, credentialVar: keyRef(11), models: [model] })
    assert.equal(first.ok, true)
    assert.equal(first.patch.customBalances.length, 3, 'a same-label foreign balance is not claimed or replaced')
    assert.equal(first.patch.priceOverrides['openai:gpt-x'], '__custom__')
    assert.equal(first.patch.priceOverrides['nikoapi-11:gpt-test'], '__custom__')
    const unbound = planUnbind(first.patch, { ownedPriceKeys: ['nikoapi-11:gpt-test'], balance: first.summary.balance })
    assert.equal(unbound.patch.customBalances.length, 2)
    assert.ok(Object.hasOwn(unbound.patch.priceOverrides, 'openai:gpt-x'))
    const full = planBinding({ customBalances: Array.from({ length: 8 }, (_, i) => ({ label: `L${i}` })) }, { origin: mock.origin, currency: 'CNY', quotaPerUnit: 1, refreshMinutes: 15, models: [] })
    assert.equal(full.ok, false)
  })
  await test('dynamic Niko expression snapshots stay in cost-meter provider prices and unbind by ownership', async () => {
    const expression = 'len < 272000 ? tier("short", p * 5 + c * 30 + cr * 0.5 + cc * 6.25) : tier("long", p * 10 + c * 45 + cr * 1 + cc * 12.5)'
    const current = { customBalances: [], priceOverrides: {}, prices: {
      custom: {}, providers: { openai: { displayName: 'OpenAI', models: { 'gpt-x': { cacheHit: 0, cacheMiss: 1, output: 2 } } } },
    } }
    const plan = planPriceBinding(current, { origin: mock.origin, currency: 'CNY', quotaPerUnit: 500000, refreshMinutes: 15,
      models: [{ provider: 'nikoapi-11', id: 'gpt-test', price: { kind: 'nikoExpression', expression, groupRatio: 0.5, adapterSupported: true } }] })
    const saved = plan.patch.prices.providers['nikoapi-11'].models['gpt-test']
    assert.equal(saved.calculator.adapter, 'nikoapi-expression-v1')
    const rate = JSON.parse(saved.calculator.snapshot)
    assert.equal(rate.billingExpr, expression)
    assert.equal(rate.billingQuotaPerUnit, 500000)
    assert.equal(rate.billingGroupRatio, 0.5)
    assert.equal(Object.hasOwn(plan.patch, 'customBalances'), false)
    assert.equal(plan.summary.dynamic.length, 1)
    assert.equal(plan.patch.prices.providers.openai, undefined, 'unmodified provider tables are not replaced by the patch')
    const merged = { ...plan.patch, prices: { ...current.prices, ...plan.patch.prices,
      providers: { ...current.prices.providers, ...plan.patch.prices.providers } } }
    const unbound = planPriceUnbind(merged, { ownedPriceKeys: ['nikoapi-11:gpt-test'], ownedPriceSnapshots: plan.summary.ownedPriceSnapshots })
    assert.equal(unbound.patch.prices.providers['nikoapi-11'].models['gpt-test'], undefined)
    assert.equal(unbound.patch.prices.providers.openai, undefined, 'unbinding leaves other provider tables untouched')
  })
  await test('unsupported Niko expression remains explicitly unpriced instead of matching the official catalog', async () => {
    const plan = planPriceBinding({ customBalances: [], priceOverrides: {}, prices: { custom: {} } }, { origin: mock.origin, currency: 'CNY', quotaPerUnit: 500000,
      models: [{ provider: 'nikoapi-11', id: 'video', price: { kind: 'unknown', note: 'usage field unavailable' } }] })
    assert.equal(plan.patch.prices.providers['nikoapi-11'].models.video.unpriced, true)
    assert.equal(plan.patch.priceOverrides['nikoapi-11:video'], undefined)
    assert.equal(plan.summary.unpriced.length, 1)
  })
  await test('legacy state migrates one credential owner and exact route id', async () => {
    const migrated = mergeState({ version: 1, selectedKeyId: 11, selectedKeyName: 'dev', confirmedModels: [{ id: 'gpt-test' }], registration: { lastStatus: 'registered' } })
    assert.equal(migrated.legacyKeyId, 11)
    assert.deepEqual(migrated.selectedKeys.map(row => row.id), [11])
    assert.deepEqual(migrated.confirmed.map(row => [row.keyId, row.modelId]), [[11, 'gpt-test']])
    assert.deepEqual(migrated.registration.routes, ['nikoapi'])
    assert.deepEqual(mergeState({ version: 2, selectedKeys: [{ id: 11 }, { id: 12 }], legacyKeyId: 11 }).selectedKeys.map(row => row.id), [11, 12])
    const v3 = mergeState({ version: 3, selectedKeys: [{ id: 11 }], confirmed: [{ keyId: 11, modelId: 'gpt-test', protocols: ['anthropic-messages'], supportedEndpoints: ['anthropic'] }], registration: { routes: ['nikoapi-11'] } })
    assert.deepEqual(v3.confirmed[0].protocols, ['openai-completions'], 'legacy state keeps its established completions route')
    assert.deepEqual(v3.registration.routes, ['nikoapi-11'])
    const v4 = mergeState({ version: 4, selectedKeys: [{ id: 11 }], confirmed: [{ keyId: 11, modelId: 'claude', protocols: ['anthropic-messages'], supportedEndpoints: ['anthropic'], protocolIdentity: '["default",[],false]' }], protocolGroups: { default: ['anthropic-messages'], ignored: ['bogus'] }, registration: { routes: ['nikoapi-11', 'nikoapi-11-anthropic'] } })
    assert.deepEqual(v4.confirmed[0].protocols, ['anthropic-messages'])
    assert.deepEqual(v4.protocolGroups, { default: ['anthropic-messages'] })
    assert.deepEqual(v4.registration.routes, ['nikoapi-11', 'nikoapi-11-anthropic'], 'saved split route IDs remain owned so migration can clean them')
    const migratedRoutes = planRoutes(v4.registration.routes, [{ keyId: 11, modelIds: ['claude'], models: [{ id: 'claude', protocols: ['anthropic-messages'] }] }], mock.origin)
    assert.deepEqual(Object.keys(migratedRoutes.routes), ['nikoapi-11'])
    assert.deepEqual(migratedRoutes.removed, ['nikoapi-11-anthropic'])
  })
  await test('state roundtrip serializes concurrent writes without losing latest state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nikoapi-state-'))
    const file = join(dir, 'state.json')
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => writeState({ ...emptyState(), lastSyncedAt: String(index) }, file)))
      const stored = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(stored.lastSyncedAt, '19')
      assert.equal((await readState(file)).version, 4)
      await writeState({ selectedKeys: [{ id: 11, name: 'dev', group: 'auto', autoGroups: ['default'], crossGroupRetry: true }] }, file)
      const restored = await readState(file)
      assert.deepEqual(restored.selectedKeys[0].autoGroups, ['default'])
      assert.equal(restored.selectedKeys[0].crossGroupRetry, true)
      await import('node:fs/promises').then(fs => fs.writeFile(file, '{broken', 'utf8'))
      await assert.rejects(readState(file), /not valid JSON/)
      assert.equal(await readFile(file, 'utf8'), '{broken')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  await test('host flow keeps selected Keys isolated and safely clears all registered routes', async () => {
    const host = await startMockHost(mock.origin)
    try {
      let result = await host.call('connect', { managementToken: PAT_FULL })
      assert.equal(result.body.ok, true, JSON.stringify(result.body))
      const metadata = await host.call('listKeys')
      assert.deepEqual(metadata.body.data.keys.map(key => key.id), [11, 12, 13])
      result = await host.call('selectKeys', { keys: [{ id: 11 }, { id: 12 }, { id: 13 }] })
      assert.equal(result.body.ok, true, JSON.stringify(result.body))
      assert.equal(result.body.data.connection.keys.length, 3)
      assert.equal(host.secrets.get('NIKOAPI_API_KEY_11'), MODEL_KEY)
      assert.equal(host.secrets.get('NIKOAPI_API_KEY_12'), SECOND_MODEL_KEY)
      assert.notEqual(host.secrets.get('NIKOAPI_API_KEY_11'), host.secrets.get('NIKOAPI_API_KEY_12'))
      const preview = await host.call('previewModels', { force: true })
      assert.equal(preview.body.data.keys.find(key => key.id === 12).models.some(model => model.modelId === 'gemini-test'), true)
      const confirmed = await host.call('confirmModels', { selections: [
        { keyId: 11, modelIds: ['gpt-test', 'claude-test'] }, { keyId: 12, modelIds: ['gpt-test', 'gemini-test'] }, { keyId: 13, modelIds: [] },
      ] })
      assert.equal(confirmed.body.ok, true)
      assert.equal(confirmed.body.data.registration.registered, true, JSON.stringify(confirmed.body.data.registration))
      const confirmedForKey11 = [{ id: 'gpt-test', ...modelCapabilities() }, { id: 'claude-test', ...modelCapabilities() }]
      assert.deepEqual(host.providers['nikoapi-11'].models, confirmedForKey11)
      assert.equal(host.providers['nikoapi-11'].api, 'openai-responses', 'one Key selects one common protocol')
      assert.equal(host.providers['nikoapi-11-responses'], undefined)
      assert.equal(host.providers['nikoapi-11-anthropic'], undefined)
      assert(host.calculators.has('nikoapi-11:gpt-test'), 'gpt calculator follows the single Key route')
      assert(host.calculators.has('nikoapi-11:claude-test'), 'Claude calculator follows the single Key route')
      assert.equal(host.quote('nikoapi-11', 'gpt-test', { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 })?.currency, 'CNY')
      assert.equal(host.quote('nikoapi-11', 'claude-test', { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 })?.currency, 'CNY')
      const automatic = [{ id: 'gpt-test', ...modelCapabilities() }, { id: 'gemini-test', ...modelCapabilities() }]
      assert.deepEqual(host.providers['nikoapi-12'].models, automatic)
      assert.equal(host.providers['nikoapi-12'].api, 'openai-responses')
      assert.equal(host.providers['nikoapi-12-responses'], undefined)
      assert.equal(host.providers['nikoapi-12-gemini'], undefined, 'automatic groups still produce one common route')
      assert.equal(host.providers['nikoapi-11'].apiKeyEnv, 'NIKOAPI_API_KEY_11')
      assert.equal(host.providers['nikoapi-12'].apiKeyEnv, 'NIKOAPI_API_KEY_12')
      await host.call('setGroup', { keyId: 12, group: 'vip' })
      assert.deepEqual(host.providers['nikoapi-12'].models.map(row => row.id), ['gpt-test', 'gemini-test'], 'group changes preserve explicit choices')
      assert.equal(host.providers['nikoapi-12'].api, 'openai-responses', 'the group still has one selected protocol')
      assert.equal(host.providers['nikoapi-12-gemini'], undefined)
      assert(host.calculators.has('nikoapi-12:gemini-test'), 'Gemini calculator follows the single Key route')
      assert.equal(host.quote('nikoapi-12', 'gemini-test', { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 })?.currency, 'CNY')
      assert.equal(host.providers.openai.displayName, 'OpenAI', 'foreign providers stay intact')
      const cleared = await host.call('selectKeys', { keys: [] })
      assert.equal(cleared.body.ok, true)
      assert.equal(host.providers['nikoapi-11'], undefined)
      assert.equal(host.providers['nikoapi-13'], undefined)
      assert.equal(host.providers['nikoapi-11-responses'], undefined)
      assert.equal(host.providers['nikoapi-11-anthropic'], undefined)
      assert.equal(host.providers['nikoapi-12-responses'], undefined)
      assert.equal(host.providers['nikoapi-12-gemini'], undefined)
      assert.equal(host.providers.openai.displayName, 'OpenAI', 'foreign providers stay intact')
      assert.equal(await host.secrets.has('NIKOAPI_API_KEY_11'), false)
      assert.equal([...host.calculators.keys()].some(route => route.startsWith('nikoapi-11:')), false)
      assert.equal([...host.calculators.keys()].some(route => route.startsWith('nikoapi-12:')), false)
    } finally { await host.close() }
  })

  await test('activation consolidates only recorded protocol-suffix routes per Key', async () => {
    const selectedKey = { id: 11, name: 'dev', group: 'default', autoGroups: null, crossGroupRetry: false, status: 'enabled' }
    const previousRoutes = ['nikoapi-11', 'nikoapi-11-responses', 'nikoapi-11-anthropic', 'nikoapi-11-gemini']
    const oldRoute = (id, api) => ({ displayName: id, apiKeyEnv: keyRef(11), api, baseURL: `${mock.origin}/v1`, models: [{ id: 'gpt-test', ...modelCapabilities() }] })
    const providers = {
      openai: { displayName: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-x' }] },
      'nikoapi-11': oldRoute('nikoapi-11', 'openai-completions'),
      'nikoapi-11-responses': oldRoute('nikoapi-11-responses', 'openai-responses'),
      'nikoapi-11-anthropic': oldRoute('nikoapi-11-anthropic', 'anthropic-messages'),
      'nikoapi-11-gemini': oldRoute('nikoapi-11-gemini', 'google-generative-ai'),
      'nikoapi-99-anthropic': oldRoute('nikoapi-99-anthropic', 'anthropic-messages'),
    }
    const host = await startMockHost(mock.origin, {
      ...emptyState(),
      selectedKeys: [selectedKey],
      confirmed: [{ keyId: 11, modelId: 'gpt-test', name: 'gpt-test', supportedEndpoints: ['openai', 'openai-response', 'anthropic'],
        protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'], protocolIdentity: '["default",[],false]' }],
      registration: { routes: previousRoutes, ns: 'llm-pi-ai', lastStatus: 'registered' },
    }, { providers, secrets: [[keyRef(11), MODEL_KEY]] })
    try {
      const result = await host.call('registerModels')
      assert.equal(result.body.ok, true, JSON.stringify(result.body))
      assert.deepEqual(Object.keys(host.providers).filter(id => id.startsWith('nikoapi-')).sort(), ['nikoapi-11', 'nikoapi-99-anthropic'])
      assert.equal(host.providers['nikoapi-11'].api, 'openai-responses', 'one Key takes the preferred supported group protocol')
      assert.equal(host.providers['nikoapi-99-anthropic'].api, 'anthropic-messages', 'a prefix lookalike not in ownership state is preserved')
      const stored = await host.readState()
      assert.deepEqual(stored.registration.routes, ['nikoapi-11'], 'only the one current route remains owned')
    } finally { await host.close() }
  })

  const confirmedGpt = () => ({ keyId: 11, modelId: 'gpt-test', name: 'gpt-test',
    supportedEndpoints: ['openai'], protocols: ['openai-completions'], protocolIdentity: '["default",[],false]' })
  const boundKey = { id: 11, name: 'dev', group: 'default', autoGroups: null, crossGroupRetry: false, status: 'enabled' }

  await test('a fresh cost-meter receives the NikoAPI account balance query once', async () => {
    const host = await startMockHost(mock.origin, { ...emptyState(), selectedKeys: [boundKey], confirmed: [confirmedGpt()] }, {
      meterConfig: { billionContextEnabled: false, customBalances: [{ label: 'Other wallet', request: { url: 'https://other.example/balance' } }],
        priceOverrides: {}, prices: { custom: {}, providers: {} } },
    })
    try {
      await host.call('describe')
      assert.equal(await host.waitFor(() => host.meterConfig.customBalances.some(row => row.label === BALANCE_LABEL)), true, 'the balance entry was never created')
      const entry = host.meterConfig.customBalances.find(row => row.label === BALANCE_LABEL)
      assert.equal(entry.request.url, `${mock.origin}/api/user/self`)
      assert.equal(entry.request.headers.Authorization, 'Bearer {{NIKOAPI_MANAGEMENT_TOKEN}}')
      assert.equal(entry.unit, 'CNY')
      assert.equal(entry.convertToDisplayCurrency, false)
      assert.deepEqual(entry.extract.remaining, { op: 'divide', path: 'data.quota', by: 500_000 })
      assert.equal(host.meterConfig.customBalances[0].label, 'Other wallet', 'foreign balances are neither removed nor reordered')
      await host.flush()
      assert.equal(host.stats.configUpdates, 1, 'the entry is written once, not on every refresh')
      const stored = await host.readState()
      assert.deepEqual(stored.costBinding.balance, { url: `${mock.origin}/api/user/self`, credentialVar: 'NIKOAPI_MANAGEMENT_TOKEN' })
    } finally { await host.close() }
  })

  await test('an existing NikoAPI balance entry is reused instead of duplicated', async () => {
    const legacy = [{ label: BALANCE_LABEL, request: { url: `${mock.origin}/api/usage/token/`, method: 'GET', headers: { Authorization: 'Bearer {{OLD_TOKEN}}' } } }]
    const host = await startMockHost(mock.origin, { ...emptyState(), selectedKeys: [boundKey], confirmed: [confirmedGpt()] }, { customBalances: legacy })
    try {
      await host.call('describe')
      assert.equal(await host.waitFor(() => host.stats.localStateReads > 0), true, 'cost-meter state was never read')
      await host.flush()
      assert.deepEqual(host.meterConfig.customBalances, legacy, 'a user-entry is never rewritten')
      assert.equal(host.stats.configUpdates, 0)
      const stored = await host.readState()
      assert.equal(stored.costBinding.balance, null, 'a reused entry is not claimed as ours')
    } finally { await host.close() }
  })

  await test('a user-made account balance template is reused without ownership', async () => {
    const template = [{ label: BALANCE_LABEL, enabled: true, display: 'both', refreshMinutes: 30, unit: 'CNY', convertToDisplayCurrency: false,
      request: { url: `${mock.origin}/api/user/self`, method: 'GET', headers: { Authorization: 'Bearer {{MY_TOKEN}}' } },
      extract: { remaining: { op: 'divide', path: 'data.quota', by: 500_000 }, maxBudget: 200, spend: 'info.spend' } }]
    const host = await startMockHost(mock.origin, { ...emptyState(), selectedKeys: [boundKey], confirmed: [confirmedGpt()] }, { customBalances: template })
    try {
      await host.call('describe')
      assert.equal(await host.waitFor(() => host.stats.localStateReads > 0), true)
      await host.flush()
      assert.deepEqual(host.meterConfig.customBalances, template, 'the working template keeps its own interval and credential')
      assert.equal(host.stats.configUpdates, 0)
    } finally { await host.close() }
  })

  await test('balance planning never touches prices', async () => {
    const plan = planBalanceBinding({ customBalances: [], priceOverrides: {}, prices: { custom: {} } }, { origin: mock.origin, refreshMinutes: 15 })
    assert.equal(plan.ok, true)
    assert.deepEqual(Object.keys(plan.patch), ['customBalances'])
    assert.equal(plan.created, true)
    assert.equal(plan.patch.customBalances[0].label, BALANCE_LABEL)
    const reused = planBalanceBinding({ customBalances: plan.patch.customBalances }, { origin: mock.origin, ownedBalance: plan.balance })
    assert.equal(reused.changed, false, 'our own entry is reused when the origin is unchanged')
    const full = planBalanceBinding({ customBalances: Array.from({ length: 8 }, (_, i) => ({ label: `L${i}` })) }, { origin: mock.origin })
    assert.equal(full.ok, false)
    assert.equal(planBalanceBinding({ customBalances: [] }, { origin: 'not a url' }).ok, false)
  })

  await test('billion-context assistance is switched off once cost-meter is detected', async () => {
    const selectedKey = { id: 11, name: 'dev', group: 'default', autoGroups: null, crossGroupRetry: false, status: 'enabled' }
    const host = await startMockHost(mock.origin, { ...emptyState(), selectedKeys: [selectedKey], confirmed: [{ keyId: 11, modelId: 'gpt-test', name: 'gpt-test',
      supportedEndpoints: ['openai'], protocols: ['openai-completions'], protocolIdentity: '["default",[],false]' }] }, {
      meterConfig: { billionContextEnabled: true, customBalances: [], priceOverrides: {}, prices: { custom: {}, providers: {} } },
    })
    try {
      await host.call('describe')
      assert.equal(await host.waitFor(() => host.stats.configUpdates > 0), true, 'cost-meter config was never updated')
      assert.deepEqual(host.stats.configPatches[0], { billionContextEnabled: false })
      assert.equal(host.meterConfig.billionContextEnabled, false)
      await host.flush()
      assert.equal(host.stats.configUpdates, 2, 'the switch and the balance entry are each written once per activation')
      assert.deepEqual(host.stats.configPatches.map(patch => Object.keys(patch)), [['billionContextEnabled'], ['customBalances']])
    } finally { await host.close() }
  })

  await test('billion-context already disabled is left untouched', async () => {
    const selectedKey = { id: 11, name: 'dev', group: 'default', autoGroups: null, crossGroupRetry: false, status: 'enabled' }
    const host = await startMockHost(mock.origin, { ...emptyState(), selectedKeys: [selectedKey], confirmed: [{ keyId: 11, modelId: 'gpt-test', name: 'gpt-test',
      supportedEndpoints: ['openai'], protocols: ['openai-completions'], protocolIdentity: '["default",[],false]' }] }, {
      meterConfig: { billionContextEnabled: false, customBalances: [], priceOverrides: {}, prices: { custom: {}, providers: {} } },
    })
    try {
      await host.call('describe')
      assert.equal(await host.waitFor(() => host.stats.localStateReads > 0), true, 'cost-meter state was never read')
      await host.flush()
      assert.equal(host.meterConfig.billionContextEnabled, false)
      assert.equal(host.stats.configPatches.some(patch => Object.hasOwn(patch, 'billionContextEnabled')), false, 'an already disabled switch is never rewritten')
      assert.equal(host.stats.configUpdates, 1, 'only the balance entry is written once')
    } finally { await host.close() }
  })

  await test('stale legacy balance link does not block Key listing', async () => {
    const legacy = {
      version: 2,
      selectedKeyId: 11,
      selectedKeyName: 'legacy dev',
      confirmedModels: [{ id: 'gpt-test', name: 'gpt-test' }],
      costBinding: { enabled: true, refreshMinutes: 15, ownedPriceKeys: [], boundAt: '2026-11-17T00:00:00.000Z', lastStatus: 'bound', lastMessage: '' },
      registration: { routes: [], ns: '', at: null, lastStatus: 'unregistered', lastMessage: '' },
    }
    const host = await startMockHost(mock.origin, legacy)
    try {
      const response = await host.call('connect', { managementToken: PAT_FULL })
      assert.equal(response.body.ok, true, JSON.stringify(response.body))
      assert.deepEqual(response.body.data.keys.map(key => key.id), [11, 12, 13])
      const status = await host.call('describe')
      assert.equal(status.body.data.cost.enabled, true)
      assert.equal(status.body.data.cost.automatic, true)
      assert.equal(status.body.data.cost.registeredCount, 0, 'missing legacy credentials cannot create a calculator')
      assert.deepEqual(host.meterConfig.customBalances.map(entry => entry.label), ['Another plugin', BALANCE_LABEL], 'the foreign entry is kept and only the missing account query is added')
    } finally { await host.close() }
  })

  await test('duplicate legacy balance candidates do not block Key listing or get deleted', async () => {
    const legacy = {
      version: 2, selectedKeyId: 11, selectedKeyName: 'legacy dev', confirmedModels: [],
      costBinding: { enabled: true, refreshMinutes: 15, ownedPriceKeys: [], boundAt: null, lastStatus: 'bound', lastMessage: '' },
      registration: { routes: [], ns: '', at: null, lastStatus: 'unregistered', lastMessage: '' },
    }
    const balances = [
      { label: 'NikoAPI', request: { url: `${mock.origin}/api/usage/token/`, headers: { Authorization: 'Bearer {{OLD}}' } } },
      { label: 'NikoAPI', request: { url: `${mock.origin}/api/usage/token/`, headers: { Authorization: 'Bearer {{OLDER}}' } } },
    ]
    const host = await startMockHost(mock.origin, legacy, { customBalances: balances })
    try {
      const response = await host.call('connect', { managementToken: PAT_FULL })
      assert.equal(response.body.ok, true, JSON.stringify(response.body))
      assert.deepEqual(response.body.data.keys.map(key => key.id), [11, 12, 13])
      assert.equal((await host.call('describe')).body.data.cost.automatic, true)
      assert.deepEqual(host.meterConfig.customBalances, balances)
    } finally { await host.close() }
  })

  await test('browser fence compares transport protocol, origin and host', async () => {
    const request = (headers, encrypted = false) => ({ headers, socket: { encrypted } })
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:51882', origin: 'http://127.0.0.1:51882' })), true)
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:51882', origin: 'https://127.0.0.1:51882' })), false)
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:51882', origin: 'http://127.0.0.1:9999' })), false)
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:51882', 'sec-fetch-site': 'cross-site' })), false)
    assert.equal(isTrustedRequest(request({ host: 'evil.example', origin: 'https://evil.example' }, true)), false)
    assert.equal(isTrustedRequest(request({ host: 'desk.example', origin: 'https://desk.example' }, true), ['desk.example']), true)
  })
} finally { await mock.close() }
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
else {
  await import('./model-capabilities.mjs')
  await import('./cost-link.mjs')
}
