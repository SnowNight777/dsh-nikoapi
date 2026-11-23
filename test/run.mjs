import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockNiko, PAT_FULL, PAT_READONLY, MODEL_KEY, SECOND_MODEL_KEY, THIRD_MODEL_KEY } from './mock-niko.mjs'
import { requestJson, HttpError, requireUrl, sameOrigin } from '../lib/http.js'
import { createNikoClient, NikoPermissionError } from '../lib/niko.js'
import { normalizePricing } from '../lib/pricing.js'
import { normalizeGroups, groupSecondary } from '../lib/groups.js'
import { planBinding, planUnbind, BALANCE_LABEL } from '../lib/costmeter.js'
import { planPriceBinding, planPriceUnbind } from '../lib/costmeter-prices.js'
import { readState, writeState, mergeState, emptyState } from '../lib/state.js'
import { buildProviderRoute, findProvidersNamespace, modelCapabilities, planRoutes, registrationStatus, keyRef, keyRoute } from '../lib/models.js'
import { isTrustedRequest } from '../index.js'
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
    assert.deepEqual((await client.listModels(THIRD_MODEL_KEY)).map(row => row.id), ['llama-test'])
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
  await test('provider routes preserve distinct credentials even for duplicate model ids', async () => {
    const routeA = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['gpt-test'], label: 'dev' })
    const routeB = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(12), modelIds: ['gpt-test'], label: 'general' })
    assert.equal(routeA.apiKeyEnv, 'NIKOAPI_API_KEY_11')
    assert.notEqual(routeA.apiKeyEnv, routeB.apiKeyEnv)
    assert.notEqual(routeA.displayName, routeB.displayName)
    assert.equal(routeA.baseURL, `${mock.origin}/v1`)
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
    const section = { providers: { [keyRoute(11)]: buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['gpt-test'] }) } }
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
  })
  await test('state roundtrip serializes concurrent writes without losing latest state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nikoapi-state-'))
    const file = join(dir, 'state.json')
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => writeState({ ...emptyState(), lastSyncedAt: String(index) }, file)))
      const stored = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(stored.lastSyncedAt, '19')
      assert.equal((await readState(file)).version, 3)
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
        { keyId: 11, modelIds: ['gpt-test'] }, { keyId: 12, modelIds: ['gpt-test', 'gemini-test'] }, { keyId: 13, modelIds: ['llama-test'] },
      ] })
      assert.equal(confirmed.body.ok, true)
      assert.equal(confirmed.body.data.registration.registered, true, JSON.stringify(confirmed.body.data.registration))
      assert.deepEqual(host.providers['nikoapi-11'].models, [{ id: 'gpt-test', ...modelCapabilities() }])
      assert.deepEqual(host.providers['nikoapi-12'].models, [{ id: 'gpt-test', ...modelCapabilities() }, { id: 'gemini-test', ...modelCapabilities() }])
      assert.equal(host.providers['nikoapi-11'].apiKeyEnv, 'NIKOAPI_API_KEY_11')
      assert.equal(host.providers['nikoapi-12'].apiKeyEnv, 'NIKOAPI_API_KEY_12')
      await host.call('setGroup', { keyId: 12, group: 'vip' })
      assert.deepEqual(host.providers['nikoapi-12'].models.map(row => row.id), ['gpt-test', 'gemini-test'], 'group changes preserve the explicit model choices and refresh rates')
      assert.equal(host.providers.openai.displayName, 'OpenAI', 'foreign providers stay intact')
      const cleared = await host.call('selectKeys', { keys: [] })
      assert.equal(cleared.body.ok, true)
      assert.equal(host.providers['nikoapi-11'], undefined)
      assert.equal(host.providers['nikoapi-13'], undefined)
      assert.equal(host.providers.openai.displayName, 'OpenAI')
      assert.equal(await host.secrets.has('NIKOAPI_API_KEY_11'), false)
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
      assert.deepEqual(host.meterConfig.customBalances.map(entry => entry.label), ['Another plugin'])
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
