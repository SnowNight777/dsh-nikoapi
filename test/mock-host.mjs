import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** Isolated Cordis/settings host. Credentials, provider config and ledger are synthetic. */
export async function startMockHost(baseUrl, initialState, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'nikoapi-host-state-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const file = join(home, 'storages', 'dsh-nikoapi', 'state.json')
  if (initialState) {
    await mkdir(join(home, 'storages', 'dsh-nikoapi'), { recursive: true })
    await writeFile(file, `${JSON.stringify(initialState)}\n`, 'utf8')
  }
  const secrets = new Map(options.secrets ?? [])
  let meterConfig = structuredClone(options.meterConfig ?? {
    customBalances: options.customBalances ?? [{ label: 'Another plugin', request: { url: 'https://other.example/balance' } }],
    priceOverrides: {}, prices: { custom: {}, providers: {} },
  })
  const ledger = { config: meterConfig, days: {} }
  const calculators = new Map()
  const stats = { localStateReads: 0, registrations: 0, disposals: 0 }
  const costMeter = {
    async getLocalState() {
      stats.localStateReads++
      await options.beforeLocalState?.()
      return { config: structuredClone(meterConfig) }
    },
    registerPriceCalculator({ provider, model, calculate }) {
      if (!provider || provider.includes(':') || !model || typeof calculate !== 'function') throw new Error('invalid route')
      const key = `${provider}:${model}`
      if (calculators.has(key)) throw new Error('A price calculator already owns this route')
      const dispose = options.calculatorApi?.registerPriceCalculator(ledger, { provider, model, calculate })
      const entry = { provider, model, calculate }
      calculators.set(key, entry); stats.registrations++
      return () => {
        if (calculators.get(key) !== entry) return
        dispose?.(); calculators.delete(key); stats.disposals++
      }
    },
  }
  const providerConfig = { providers: structuredClone(options.providers ?? {
    openai: { displayName: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', api: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-x' }] },
  }) }
  let revision = 0, handler
  let costMeterAvailable = options.costMeterAvailable !== false
  const costEffects = new Set(), events = new Map(), cleanup = []
  function emit(name, ...args) { for (const listener of events.get(name) ?? []) listener(...args) }
  const settings = {
    describe() { return [{ ns: 'llm-pi-ai', revision, value: structuredClone(providerConfig) }] },
    async mutate(ns, ops, expected) {
      if (ns !== 'llm-pi-ai' || expected !== revision) throw new Error('stale settings revision')
      for (const edit of ops) {
        if (edit.path[0] !== 'providers' || edit.path.length !== 2) throw new Error('unexpected settings path')
        if (edit.op === 'unset') delete providerConfig.providers[edit.path[1]]
        else providerConfig.providers[edit.path[1]] = structuredClone(edit.value)
      }
      emit('settings/document-updated', ns, ++revision)
    },
  }
  const credentials = {
    async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref) } : undefined },
    async set(ref, value) { secrets.set(ref, value) },
    async unset(ref) { secrets.delete(ref) },
    async describe(ref) { return { configured: secrets.has(ref), writable: true } },
  }
  const ctx = {
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'settings') return settings
      if (name === 'costMeter') return costMeterAvailable ? costMeter : undefined
      if (name === 'webStartup') return { trustedHosts: [] }
      if (name === 'llm') return { listConfigurableProviders: () => Object.keys(providerConfig.providers).map(provider => ({ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })) }
      return undefined
    },
    inject(services, callback) {
      if (services.includes('costMeter')) callback({
        get: name => name === 'costMeter' && costMeterAvailable ? costMeter : undefined,
        effect(fn) {
          const record = { fn, dispose: costMeterAvailable ? fn() : undefined }
          costEffects.add(record)
          cleanup.push(() => { record.dispose?.(); costEffects.delete(record) })
        },
      })
      else if (services.includes('webServer')) callback({
        webServer: { register(record) { handler = record.handler; return () => {} } },
        effect(fn) { const dispose = fn(); if (dispose) cleanup.push(dispose); return dispose },
      })
    },
    on(name, listener) {
      if (!events.has(name)) events.set(name, new Set())
      events.get(name).add(listener)
      const dispose = () => events.get(name)?.delete(listener)
      cleanup.push(dispose)
      return dispose
    },
    effect(fn) { const dispose = fn(); if (dispose) cleanup.push(dispose); return dispose },
    logger: { warn() {} },
  }
  apply(ctx, { baseUrl })
  if (!handler) throw new Error('mock host did not register NikoAPI endpoint')
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/nikoapi/api`
  async function call(method, params = {}) {
    const response = await fetch(url, {
      method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  let stopped = false
  let closed = false
  function stopPlugin() {
    if (stopped) return
    stopped = true
    for (const dispose of cleanup.reverse()) dispose?.()
  }
  return {
    url, home, providers: providerConfig.providers, secrets, calculators, stats, ledger, call,
    get meterConfig() { return meterConfig },
    setMeterConfig(value) { meterConfig = structuredClone(value); ledger.config = meterConfig },
    setCostMeterAvailable(value) {
      if (costMeterAvailable === value) return
      costMeterAvailable = value
      for (const record of costEffects) {
        record.dispose?.()
        record.dispose = value ? record.fn() : undefined
      }
    },
    emitSettingsUpdated() { emit('settings/document-updated', 'llm-pi-ai', revision) },
    async flush() {
      const result = await call('saveCostBinding')
      if (!result.body.ok) throw new Error(JSON.stringify(result.body))
    },
    async waitFor(predicate, attempts = 100) {
      for (let i = 0; i < attempts; i++) {
        if (predicate()) return true
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return predicate()
    },
    async readState() { return JSON.parse(await readFile(file, 'utf8')) },
    quote(provider, model, usage, atMs = Date.now()) {
      if (options.calculatorApi) return options.calculatorApi.quoteUsage(ledger, provider, model, usage, atMs, meterConfig)
      return calculators.get(`${provider}:${model}`)?.calculate({ provider, model, usage, atMs }) ?? null
    },
    stopPlugin,
    async close() {
      if (closed) return
      closed = true
      if (!stopped) stopPlugin()
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
      await rm(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}
