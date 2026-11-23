const DYNAMIC = 'nikoapi-expression-v1'
const UNKNOWN_NOTE = 'dsh-nikoapi: unavailable rate; '
const safe = name => typeof name === 'string' && name.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(name)
const keyOf = (provider, model) => `${provider}:${model}`
const splitKey = key => { const i = typeof key === 'string' ? key.indexOf(':') : -1; return i > 0 ? [key.slice(0,i), key.slice(i+1)] : [] }
const stable = value => JSON.stringify(value, (key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))) : child)
const exactPrice = price => price?.kind === 'perMillion' && price.reference !== true && ['USD','CNY'].includes(price.currency)
  && ['input','output','cacheHit'].every(key => Number.isFinite(price[key]) && price[key] >= 0)

/** Compare the fields the cost-meter normalizer retains; manual edits revoke ownership. */
export function priceSignature(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (entry.calculator) return stable({ calculator: entry.calculator })
  if (entry.unpriced === true) return stable({ unpriced:true, notes:entry.notes, sourceUrl:entry.sourceUrl })
  return stable({ ...Object.fromEntries(['currency','cacheMiss','cacheHit','output','cacheWrite','reasoning'].filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]])), billingMode:entry.billingMode??'flat' })
}
function currentPrice(config, key) {
  const [provider, model] = splitKey(key)
  if (!safe(provider) || !safe(model)) return undefined
  return config.priceOverrides?.[key] === '__custom__' ? config.prices?.custom?.[key] : config.prices?.providers?.[provider]?.models?.[model]
}
const ownedNow = (config, options, key) => typeof options.ownedPriceSnapshots?.[key] === 'string'
  && priceSignature(currentPrice(config,key)) === options.ownedPriceSnapshots[key]
function mutableModels(config, changes, provider) {
  if (!Object.hasOwn(changes,provider)) changes[provider] = { ...(config.prices?.providers?.[provider]??{}), models:{...(config.prices?.providers?.[provider]?.models??{})} }
  return changes[provider].models
}
function removeOwned(config, overrides, custom, changes, key) {
  if (overrides[key] === '__custom__') { delete overrides[key]; delete custom[key] }
  else {
    const [provider,model] = splitKey(key)
    if (safe(provider) && safe(model)) delete mutableModels(config,changes,provider)[model]
  }
}
function dynamicEntry(price, options) {
  if (price?.kind === 'perCall' && price.currency === 'CNY' && Number.isFinite(price.perCall) && price.perCall >= 0) {
    return { calculator: { adapter: DYNAMIC, currency: 'CNY', snapshot: JSON.stringify({ requestPriceCny: price.perCall }) } }
  }
  if (!['nikoExpression', 'nikoZero'].includes(price?.kind) || price.adapterSupported !== true || typeof price.expression !== 'string') return null
  const quota = Number(options.quotaPerUnit ?? price.quotaPerUnit), ratio = Number(price.groupRatio)
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(ratio) || ratio < 0) return null
  return { calculator: { adapter: DYNAMIC, currency: 'CNY', snapshot: JSON.stringify({
    billingExpr: price.expression, billingQuotaPerUnit: quota, billingGroupRatio: ratio,
    ...(price.kind === 'nikoZero' ? { zeroByPolicy: true } : {}),
  }) } }
}

/** Only prices: balance sources are never inspected or included in this patch. */
export function planPriceBinding(current, options) {
  const config = current??{}, overrides={...(config.priceOverrides??{})}, custom={...(config.prices?.custom??{})}, changes={}
  const models = Array.isArray(options.models)?options.models:[]
  const prior = new Set([...(options.ownedPriceKeys??[]),...(options.ownedUnpricedKeys??[])])
  const expected = new Set(models.map(model=>keyOf(model.provider??'nikoapi',model.id)))
  for (const key of prior) if (!expected.has(key)&&ownedNow(config,options,key)) removeOwned(config,overrides,custom,changes,key)
  const priced = [], dynamic = [], zeroPolicy = [], unpriced = [], conflicts = [], ownedPriceKeys = [], ownedUnpricedKeys = [], ownedPriceSnapshots = {}
  for (const model of models) {
    const provider=model.provider??'nikoapi', id=model.id, key=keyOf(provider,id)
    if (!/^nikoapi(?:-[1-9]\d*)?$/.test(provider)||!safe(id)) { conflicts.push({key,reason:'invalid Niko price identity'}); continue }
    const table=config.prices?.providers?.[provider]?.models??{}
    const hasExisting = Object.hasOwn(config.priceOverrides??{},key)||Object.hasOwn(custom,key)||Object.hasOwn(table,id)
    const stillOwned = prior.has(key)&&ownedNow(config,options,key)
    if (hasExisting&&!stillOwned) { conflicts.push({key,reason:'existing or manually edited user price kept'}); continue }
    if (stillOwned) removeOwned(config,overrides,custom,changes,key)
    const dynamicRate=dynamicEntry(model.price,options)
    let written
    if (dynamicRate) {
      written = dynamicRate
      mutableModels(config, changes, provider)[id] = written
      ownedPriceKeys.push(key)
      dynamic.push({ provider, id, key })
      if (model.price?.kind === 'nikoZero') zeroPolicy.push({ provider, id, key, note: model.price.note ?? '' })
    } else if (exactPrice(model.price)) {
      overrides[key]='__custom__'
      written={currency:model.price.currency,cacheMiss:model.price.input,cacheHit:model.price.cacheHit,output:model.price.output,
        ...(Number.isFinite(model.price.cacheWrite)?{cacheWrite:model.price.cacheWrite}:{})}
      custom[key]=written; ownedPriceKeys.push(key); priced.push({provider,id,key})
    } else {
      written={unpriced:true,notes:UNKNOWN_NOTE+(model.price?.note??'exact price unavailable'),sourceUrl:`${new URL(options.origin).origin}/api/pricing`}
      mutableModels(config,changes,provider)[id]=written; ownedUnpricedKeys.push(key)
      unpriced.push({provider,id,key,kind:model.price?.kind??'unknown',note:model.price?.note??''})
    }
    ownedPriceSnapshots[key]=priceSignature(written)
  }
  return {patch:{priceOverrides:overrides,prices:{custom,...(Object.keys(changes).length?{providers:changes}:{})}},
    summary: { priced, dynamic, zeroPolicy, unpriced, conflicts, ownedPriceKeys, ownedUnpricedKeys, ownedPriceSnapshots } }
}

export function planPriceUnbind(current, ownership={}) {
  const config=current??{},overrides={...(config.priceOverrides??{})},custom={...(config.prices?.custom??{})},changes={},removed=[],retained=[]
  for (const key of new Set([...(ownership.ownedPriceKeys??[]),...(ownership.ownedUnpricedKeys??[])])) {
    if (ownedNow(config,ownership,key)) { removeOwned(config,overrides,custom,changes,key); removed.push(key) }
    else retained.push(key)
  }
  return {patch:{priceOverrides:overrides,prices:{custom,...(Object.keys(changes).length?{providers:changes}:{})}},removed,retained,balanceSourcesChanged:false}
}
