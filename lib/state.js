/** Non-secret plugin state. Credentials are kept only in DSH's credential store. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isOwnedRoute, modelCapabilities } from './models.js'

export function statePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-nikoapi', 'state.json')
}

export function emptyState() {
  return {
    version: 4,
    selectedKeys: [],
    keyDirectory: { keys: [], total: 0, complete: false, autoGroups: [], autoGroupLimit: null, groups: [], groupDescriptions: false },
    confirmed: [],
    priceSnapshots: [],
    protocolGroups: {},
    protocolIdentity: '',
    legacyKeyId: null,
    costBinding: { enabled: true, refreshMinutes: 15, registeredCount: 0, conflicts: [], boundAt: null, lastStatus: 'waiting', lastMessage: '' },
    registration: { routes: [], ns: '', at: null, lastStatus: 'unregistered', lastMessage: '' },
    lastSyncedAt: null,
    site: null,
  }
}

/** Only a missing file means empty state; corrupt/unreadable state fails closed. */
export async function readState(path = statePath()) {
  let text
  try { text = await readFile(path, 'utf8') }
  catch (error) { if (error?.code === 'ENOENT') return emptyState(); throw new Error('NikoAPI state could not be read; the existing file was not changed') }
  let raw
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('NikoAPI state is not valid JSON; the existing file was not changed') }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('NikoAPI state has an invalid shape; the existing file was not changed')
  return mergeState(raw)
}

const writes = new Map()
/** Serialize same-file writes and capture the value before any async work. */
export function writeState(state, path = statePath()) {
  const target = resolve(path)
  const text = `${JSON.stringify(mergeState(state), null, 2)}\n`
  const next = (writes.get(target) ?? Promise.resolve()).then(async () => {
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, target)
  })
  const settled = next.catch(() => {})
  writes.set(target, settled)
  void settled.then(() => { if (writes.get(target) === settled) writes.delete(target) })
  return next
}

const strings = (value, cap = 256) => [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item !== '').map(item => item.slice(0, 512)))].slice(0, cap)
const protocols = value => [...new Set((Array.isArray(value) ? value : []).filter(item => ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(item)))]
const endpoints = value => Array.isArray(value)
  ? [...new Set(value.filter(item => ['openai', 'openai-response', 'anthropic', 'gemini', 'image-generation', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(item)))]
  : null
function protocolGroupState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 2000).map(([group, value]) => [group.slice(0, 512), protocols(value)]).filter(([, value]) => value.length))
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null
export function keyPriceIdentity(key) {
  return JSON.stringify([key?.group ?? '', key?.autoGroups ?? null, key?.crossGroupRetry === true, key?.status ?? 'unknown'])
}
function cachedPrice(row) {
  const price = row?.price
  if (!Number.isSafeInteger(row?.keyId) || row.keyId <= 0 || typeof row.modelId !== 'string' || !row.modelId || row.modelId.length > 512 || !price || typeof price !== 'object') return null
  if (price.reference === true || !['CNY', 'USD', 'EUR'].includes(price.currency)) return null
  if (price.kind === 'perMillion' && ['input', 'output', 'cacheHit', 'cacheWrite'].every(key => finite(price[key]) !== null)) {
    return { keyId: row.keyId, modelId: row.modelId, price: { kind: 'perMillion', currency: price.currency,
      input: finite(price.input), output: finite(price.output), cacheHit: finite(price.cacheHit), cacheWrite: finite(price.cacheWrite), reference: false } }
  }
  if (price.kind === 'perCall' && price.currency === 'CNY' && finite(price.perCall) !== null) {
    return { keyId: row.keyId, modelId: row.modelId, price: { kind: 'perCall', currency: 'CNY', perCall: finite(price.perCall), reference: false } }
  }
  if (['nikoExpression', 'nikoZero'].includes(price.kind) && price.currency === 'CNY'
    && typeof price.expression === 'string' && price.expression.length <= 8192
    && finite(price.groupRatio) !== null && finite(price.quotaPerUnit) > 0) {
    return { keyId: row.keyId, modelId: row.modelId, price: { kind: price.kind, currency: 'CNY', expression: price.expression,
      groupRatio: finite(price.groupRatio), quotaPerUnit: finite(price.quotaPerUnit), ...(price.kind === 'nikoZero' ? { zeroByPolicy: true } : {}) } }
  }
  return null
}

export function directoryKeyMetadata(key) {
  if (!Number.isSafeInteger(key?.id) || key.id <= 0) return null
  return {
    ...keyMetadata(key),
    maskedKey: '••••',
    unlimitedQuota: key.unlimitedQuota === true,
    remainQuota: finite(key.remainQuota),
    usedQuota: finite(key.usedQuota),
    modelLimitsEnabled: key.modelLimitsEnabled === true,
    expiresAt: finite(key.expiresAt),
  }
}

function directoryGroup(group) {
  if (typeof group?.id !== 'string' || group.id === '') return null
  return { id: group.id.slice(0, 512), name: typeof group.name === 'string' ? group.name.slice(0, 512) : group.id.slice(0, 512),
    desc: typeof group.desc === 'string' ? group.desc.slice(0, 2048) : '', ratio: finite(group.ratio) }
}

export function keyMetadata(key) {
  return {
    id: key.id,
    name: typeof key.name === 'string' ? key.name : `#${key.id}`,
    group: typeof key.group === 'string' ? key.group : '',
    autoGroups: Array.isArray(key.autoGroups) ? strings(key.autoGroups) : null,
    crossGroupRetry: key.crossGroupRetry === true,
    status: typeof key.status === 'string' ? key.status : 'unknown',
  }
}

/** Migrate the original single-key state without letting another id adopt its secret. */
export function mergeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const binding = raw.costBinding ?? {}
  const directory = raw.keyDirectory ?? {}
  const registration = raw.registration ?? {}
  const keys = new Map()
  for (const key of Array.isArray(raw.selectedKeys) ? raw.selectedKeys : []) {
    if (Number.isSafeInteger(key?.id) && key.id > 0) keys.set(key.id, keyMetadata(key))
  }
  let legacyKeyId = Number.isSafeInteger(raw.legacyKeyId) && raw.legacyKeyId > 0 ? raw.legacyKeyId : null
  if (keys.size === 0 && Number.isSafeInteger(raw.selectedKeyId) && raw.selectedKeyId > 0) {
    legacyKeyId = raw.selectedKeyId
    keys.set(raw.selectedKeyId, keyMetadata({ id: raw.selectedKeyId, name: raw.selectedKeyName }))
  }
  const selectedKeys = [...keys.values()]
  const confirmed = new Map()
  const source = Array.isArray(raw.confirmed) && raw.confirmed.length
    ? raw.confirmed
    : keys.size === 1 && Array.isArray(raw.confirmedModels)
      ? raw.confirmedModels.map(row => ({ ...row, keyId: legacyKeyId ?? selectedKeys[0]?.id, modelId: row?.id })) : []
  for (const row of source) {
    if (keys.has(row?.keyId) && typeof row?.modelId === 'string' && row.modelId !== '') {
      confirmed.set(JSON.stringify([row.keyId, row.modelId]), { keyId: row.keyId, modelId: row.modelId, name: typeof row.name === 'string' ? row.name : row.modelId,
        supportedEndpoints: endpoints(row.supportedEndpoints), protocols: raw.version >= 4 ? protocols(row.protocols) : ['openai-completions'],
        protocolIdentity: raw.version >= 4 && typeof row.protocolIdentity === 'string' ? row.protocolIdentity.slice(0, 2048) : '', ...modelCapabilities(row) })
    }
  }
  const snapshots = new Map()
  for (const row of Array.isArray(raw.priceSnapshots) ? raw.priceSnapshots.slice(0, 5000) : []) {
    const value = cachedPrice(row)
    const key = keys.get(row?.keyId)
    if (!value || !key || !confirmed.has(JSON.stringify([value.keyId, value.modelId])) || row.keyIdentity !== keyPriceIdentity(key)) continue
    snapshots.set(JSON.stringify([value.keyId, value.modelId]), { ...value, keyIdentity: row.keyIdentity,
      at: typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : null })
  }
  const legacyRoutes = registration.lastStatus === 'registered' && raw.registration?.routes === undefined ? ['nikoapi'] : []
  return {
    ...base,
    selectedKeys,
    keyDirectory: {
      keys: Array.isArray(directory.keys) ? directory.keys.filter(key => Number.isSafeInteger(key?.id) && key.id > 0).slice(0, 5000).map(directoryKeyMetadata).filter(Boolean) : [],
      total: Number.isSafeInteger(directory.total) && directory.total >= 0 ? directory.total : 0,
      complete: directory.complete === true,
      autoGroups: strings(directory.autoGroups).slice(0, 256),
      autoGroupLimit: Number.isSafeInteger(directory.autoGroupLimit) && directory.autoGroupLimit >= 0 ? directory.autoGroupLimit : null,
      groups: Array.isArray(directory.groups) ? directory.groups.slice(0, 2000).map(directoryGroup).filter(Boolean) : [],
      at: typeof directory.at === 'string' && Number.isFinite(Date.parse(directory.at)) ? directory.at : null,
      groupDescriptions: directory.groupDescriptions === true,
    },
    confirmed: [...confirmed.values()],
    priceSnapshots: [...snapshots.values()],
    protocolGroups: protocolGroupState(raw.protocolGroups),
    legacyKeyId,
    costBinding: {
      enabled: true,
      registeredCount: Number.isSafeInteger(binding.registeredCount) && binding.registeredCount >= 0 ? binding.registeredCount : 0,
      conflicts: strings(binding.conflicts, 5000),
      unavailable: strings(binding.unavailable, 5000),
      refreshMinutes: Number.isFinite(binding.refreshMinutes) && binding.refreshMinutes >= 1 ? Math.min(1440, Math.round(binding.refreshMinutes)) : 15,
      ownedPriceKeys: strings(binding.ownedPriceKeys),
      ownedUnpricedKeys: strings(binding.ownedUnpricedKeys),
      ownedPriceSnapshots: Object.fromEntries(Object.entries(binding.ownedPriceSnapshots ?? {}).filter(([key,value]) => !['__proto__','constructor','prototype'].includes(key) && typeof value === 'string' && value.length <= 32768)),
      balance: typeof binding.balance?.url === 'string' && typeof binding.balance?.credentialVar === 'string'
        ? { url: binding.balance.url, credentialVar: binding.balance.credentialVar }
        : null,
      legacyBalance: typeof binding.balance?.url !== 'string' && binding.enabled === true,
      boundAt: typeof binding.boundAt === 'string' ? binding.boundAt : null,
      lastStatus: typeof binding.lastStatus === 'string' ? binding.lastStatus : 'waiting',
      lastMessage: typeof binding.lastMessage === 'string' ? binding.lastMessage : '',
    },
    registration: {
      // The route list is the ownership ledger; keep owned stale routes so a crash during key changes cannot orphan them.
      routes: strings(Array.isArray(registration.routes) ? registration.routes : legacyRoutes)
        .filter(isOwnedRoute),
      ns: typeof registration.ns === 'string' ? registration.ns : '',
      at: typeof registration.at === 'string' ? registration.at : null,
      lastStatus: typeof registration.lastStatus === 'string' ? registration.lastStatus : 'unregistered',
      lastMessage: typeof registration.lastMessage === 'string' ? registration.lastMessage : '',
    },
    lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
    site: raw.site !== null && typeof raw.site === 'object' ? {
      version: typeof raw.site.version === 'string' ? raw.site.version : '',
      currency: typeof raw.site.currency === 'string' ? raw.site.currency : '',
      quotaPerUnit: Number.isFinite(raw.site.quotaPerUnit) && raw.site.quotaPerUnit > 0 ? raw.site.quotaPerUnit : 500_000,
      usdExchangeRate: Number.isFinite(raw.site.usdExchangeRate) && raw.site.usdExchangeRate > 0 ? raw.site.usdExchangeRate : 1,
    } : null,
  }
}
