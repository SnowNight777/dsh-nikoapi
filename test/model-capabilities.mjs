/** Focused regressions for the user-authorized model defaults. Does not invoke cost binding. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildProviderRoute, isGptModel, isLlmModel, modelCapabilities, planRoutes, registrationStatus, keyRef } from '../lib/models.js'
import { mergeState } from '../lib/state.js'
import { createNikoClient } from '../lib/niko.js'
import { startMockNiko, PAT_FULL } from './mock-niko.mjs'
import { startMockHost } from './mock-host.mjs'

const defaults = { input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
const mock = await startMockNiko()
try {
  await test('missing metadata uses precisely the user-selected capabilities', () => {
    assert.deepEqual(modelCapabilities(), defaults)
    assert.deepEqual(modelCapabilities({ input: null, reasoningEfforts: null }), defaults)
    assert.deepEqual(buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['test'] }).models, [{ id: 'test', ...defaults }])
  })
  await test('explicit server capabilities override defaults and do not grow extra levels', () => {
    assert.deepEqual(modelCapabilities({ input: ['text'], reasoningEfforts: false }), { input: ['text'], reasoningEfforts: false })
    assert.deepEqual(modelCapabilities({ input: ['image', 'text', 'image'], reasoningEfforts: ['off', 'high'] }), {
      input: ['image', 'text'], reasoningEfforts: { off: null, high: 'high' },
    })
    assert.deepEqual(modelCapabilities({ reasoningEfforts: { off: null, high: 'vendor-high' } }).reasoningEfforts, { off: null, high: 'vendor-high' })
  })
  await test('state migration and route plans retain capabilities', () => {
    const state = mergeState({ selectedKeys: [{ id: 11 }], confirmed: [{ keyId: 11, modelId: 'test', input: ['text'], reasoningEfforts: false }] })
    assert.deepEqual(state.confirmed[0].input, ['text'])
    assert.equal(state.confirmed[0].reasoningEfforts, false)
    const old = mergeState({ selectedKeys: [{ id: 11 }], confirmed: [{ keyId: 11, modelId: 'test' }] })
    assert.deepEqual(old.confirmed[0].reasoningEfforts, defaults.reasoningEfforts)
    const plan = planRoutes([], [{ keyId: 11, modelIds: ['test'], models: [{ id: 'test', input: ['text'], reasoningEfforts: false }] }], mock.origin)
    assert.equal(plan.routes['nikoapi-11'].models[0].reasoningEfforts, false)
  })
  await test('readback rejects missing capability writes and accepts unordered maps', () => {
    const entries = [{ keyId: 11, modelIds: ['test'] }]
    const route = buildProviderRoute({ origin: mock.origin, apiKeyEnv: keyRef(11), modelIds: ['test'] })
    assert.equal(registrationStatus({ providers: { 'nikoapi-11': route } }, entries, mock.origin).registered, true)
    route.models[0].reasoningEfforts = { max: 'max', high: 'high', low: 'low', off: null }
    assert.equal(registrationStatus({ providers: { 'nikoapi-11': route } }, entries, mock.origin).registered, true)
    delete route.models[0].input
    assert.equal(registrationStatus({ providers: { 'nikoapi-11': route } }, entries, mock.origin).registered, false)
  })
  await test('Niko reader admits only declared LLM models plus the explicit GPT rule', async () => {
    const payload = { data: [
      { id: 'explicit', supported_endpoint_types: ['openai'], input_modalities: ['text'], reasoning_efforts: false },
      { id: 'gpt-6.2-astra' },
      { id: 'image-only', supported_endpoint_types: ['image-generation'] },
      { id: 'unknown-protocol', supported_endpoint_types: ['vendor-unknown'] },
      { id: 'no-protocol' },
    ] }
    const client = createNikoClient({ baseUrl: mock.origin, fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) })
    const models = await client.listModels('synthetic-key')
    assert.deepEqual(models.map(row => row.id), ['explicit', 'gpt-6.2-astra'])
    assert.equal(models[0].inputModalities[0], 'text')
    assert.equal(models[0].reasoningEfforts, false)
    assert.equal(isLlmModel(models[1]), true)
    assert.equal(isGptModel(models[1]), true)
    assert.equal(isLlmModel({ id: 'gpt-image-1', supportedEndpoints: ['image-generation'] }), false)
  })
  await test('Host preview, confirm, persistence and reregistration use the same defaults', async () => {
    const host = await startMockHost(mock.origin)
    try {
      assert.equal((await host.call('connect', { managementToken: PAT_FULL })).body.ok, true)
      assert.equal((await host.call('selectKeys', { keys: [{ id: 11 }] })).body.ok, true)
      const preview = await host.call('previewModels', { force: true })
      assert.equal(preview.body.ok, true)
      assert.deepEqual(preview.body.data.keys[0].models[0].input, defaults.input)
      assert.deepEqual(preview.body.data.keys[0].models[0].reasoningEfforts, defaults.reasoningEfforts)
      const confirmed = await host.call('confirmModels', { selections: [{ keyId: 11, modelIds: ['gpt-test'] }] })
      assert.equal(confirmed.body.data.registration.registered, true, JSON.stringify(confirmed.body))
      assert.deepEqual(host.providers['nikoapi-11'].models, [{ id: 'gpt-test', ...defaults }])
      const disk = JSON.parse(await readFile(join(process.env.DSH_HOME, 'storages', 'dsh-nikoapi', 'state.json'), 'utf8'))
      assert.deepEqual(disk.confirmed[0].input, defaults.input)
      assert.deepEqual(disk.confirmed[0].reasoningEfforts, defaults.reasoningEfforts)
      assert.equal((await host.call('registerModels')).body.data.registered, true)
      assert.deepEqual(host.meterConfig.customBalances.map(row => row.label), ['Another plugin'])
      assert.deepEqual(host.meterConfig.priceOverrides, {})
    } finally { await host.close() }
  })
} finally { await mock.close() }
console.log(`\n${passed} focused model capability checks passed`)
