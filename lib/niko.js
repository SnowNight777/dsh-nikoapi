/**
 * NikoAPI (New API fork) client.
 *
 * Two credential kinds never mix: a dashboard management token (PAT) reads and
 * edits key metadata, while one selected model key reads its own model catalog
 * and usage. Nothing here returns a secret to a caller that renders it; the
 * only method that produces a full key is `revealKey`, and its result goes
 * straight into the credential store.
 */
import { HttpError, requestJson } from './http.js'

/** Marker for a permission the management token did not carry. */
export class NikoPermissionError extends Error {
  /**
   * @param {string} message safe, user-facing reason
   * @param {string} scope the missing scope, e.g. `api_key:write`
   */
  constructor(message, scope) {
    super(message)
    this.name = 'NikoPermissionError'
    this.scope = scope
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl site origin, e.g. `https://nikoapi.xyz`
 * @param {typeof fetch} [options.fetch]
 * @param {AbortSignal} [options.signal]
 */
export function createNikoClient({ baseUrl, fetch: fetchImpl, signal }) {
  const origin = new URL(baseUrl).origin

  /** @param {string} path @param {object} [extra] */
  const call = async (path, extra = {}) => {
    const response = await requestJson({ url: origin + path, origin, fetch: fetchImpl, signal, ...extra })
    const body = response.body ?? {}
    if (response.status === 401) {
      throw new HttpError('credential rejected (401)', { status: 401, code: 'UNAUTHORIZED' })
    }
    if (response.status === 403) {
      const scope = scopeFromBody(body)
      throw new NikoPermissionError(`permission denied (403); required scope: ${scope}`, scope)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(`upstream status ${response.status}`, { status: response.status, code: 'UPSTREAM' })
    }
    if (body.success === false) throw new HttpError('upstream refused the request', { code: 'UPSTREAM' })
    if (extra.requireIdentity === true && response.authenticated !== true) throw new HttpError('account pricing identity was not confirmed', { code: 'UNAUTHORIZED' })
    return body
  }

  const auth = token => ({ authorization: `Bearer ${token}` })

  return {
    origin,

    /** Public site facts: version, quota unit, display currency. */
    async status() {
      const body = await call('/api/status')
      const data = body.data ?? {}
      return {
        version: typeof data.version === 'string' ? data.version : '',
        quotaPerUnit: positive(data.quota_per_unit) ?? 500_000,
        displayCurrency: typeof data.quota_display_type === 'string' && data.quota_display_type !== '' ? data.quota_display_type : 'USD',
        usdExchangeRate: positive(data.usd_exchange_rate) ?? 1,
        systemName: typeof data.system_name === 'string' ? data.system_name : 'NikoAPI',
      }
    },

    /**
     * Key metadata for the account, masked by the server.
     * @param {string} pat management token
     * @param {{ page?: number, size?: number }} [page]
     */
    async listKeys(pat, page = {}) {
      const pageNumber = Number.isInteger(page.page) && page.page > 0 ? page.page : 1
      const pageSize = Number.isInteger(page.size) && page.size > 0 ? Math.min(page.size, 100) : 100
      const query = `?p=${pageNumber}&size=${pageSize}`
      const body = await call(`/api/token/${query}`, { headers: auth(pat) })
      const data = body.data ?? {}
      const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []
      return {
        total: Number.isFinite(data.total) ? data.total : items.length,
        items: items.map(normalizeKey).filter(item => item !== null),
      }
    },

    /** Paginate all metadata. Refuse repeated/partial pages instead of pretending they are complete. */
    async allKeys(pat) {
      const items = new Map()
      let total = 0
      for (let page = 1; page <= 1000; page += 1) {
        const result = await this.listKeys(pat, { page, size: 100 })
        total = result.total
        const before = items.size
        for (const item of result.items) items.set(item.id, item)
        if (items.size >= total) return { items: [...items.values()], total, complete: true }
        if (items.size === before) throw new HttpError('key listing was incomplete; refresh and retry', { code: 'INCOMPLETE' })
      }
      throw new HttpError('key listing exceeded the page safety limit', { code: 'INCOMPLETE' })
    },

    /** Optional auto groups plus the per-key limit the site enforces. */
    async autoGroups(pat) {
      const body = await call('/api/token/auto-groups', { headers: auth(pat) })
      const data = body.data ?? {}
      return {
        groups: Array.isArray(data.groups) ? data.groups.filter(group => typeof group === 'string') : [],
        maxCount: Number.isFinite(data.max_count) ? data.max_count : null,
      }
    },

    /**
     * Read one key's full value. The caller stores it; it is never rendered.
     * @param {string} pat management token
     * @param {number} id key id
     */
    async revealKey(pat, id) {
      const body = await call(`/api/token/${id}/key`, { method: 'POST', headers: auth(pat), json: {} })
      const key = body.data?.key
      if (typeof key !== 'string' || key.trim() === '') throw new HttpError('upstream returned no key value', { code: 'UPSTREAM' })
      return key.trim()
    },

    /**
     * Change one key's group on the server.
     * @param {string} pat management token carrying `api_key:write`
     * @param {number} id key id
     * @param {{ group: string, autoGroups?: string[], crossGroupRetry?: boolean }} selection
     */
    async updateGroup(pat, id, selection) {
      const json = { group: selection.group }
      if (selection.group === 'auto') {
        if (Array.isArray(selection.autoGroups)) json.auto_groups = selection.autoGroups
        if (typeof selection.crossGroupRetry === 'boolean') json.cross_group_retry = selection.crossGroupRetry
      }
      const body = await call(`/api/token/${id}/group`, { method: 'PUT', headers: auth(pat), json })
      return normalizeKey(body.data ?? {})
    },

    /**
     * Models one selected model key can actually use.
     * @param {string} modelKey full `sk-` style key
     */
    async listModels(modelKey) {
      const body = await call('/v1/models', { headers: auth(modelKey) })
      const rows = Array.isArray(body.data) ? body.data : []
      return rows
        .map(row => {
          if (typeof row?.id !== 'string' || row.id === '') return null
          const supportedEndpoints = Array.isArray(row.supported_endpoint_types)
            ? [...new Set(row.supported_endpoint_types.filter(type => typeof type === 'string'))]
            : null
          return {
            id: row.id,
            name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
            supportedEndpoints,
            inputModalities: Array.isArray(row.input_modalities) ? row.input_modalities.filter(type => typeof type === 'string') : null,
            reasoningEfforts: row.reasoning_efforts === false ? false
              : Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts.filter(value => typeof value === 'string')
                : row.reasoning_efforts && typeof row.reasoning_efforts === 'object'
                  ? Object.fromEntries(Object.entries(row.reasoning_efforts).filter(([, value]) => value === null || typeof value === 'string')) : null,
            contextWindow: positive(row.context_window),
            maxTokens: positive(row.max_tokens),
          }
        })
        .filter(Boolean)
    },

    /**
     * The selected key's own quota and limits.
     * @param {string} modelKey full key
     */
    async usage(modelKey) {
      const body = await call('/api/usage/token/', { headers: auth(modelKey) })
      const data = body.data ?? {}
      const userQuota = data.user_quota ?? null
      return {
        totalGranted: finite(data.total_granted),
        totalUsed: finite(data.total_used),
        totalAvailable: finite(data.total_available),
        unlimitedQuota: data.unlimited_quota === true,
        expiresAt: finite(data.expires_at),
        modelLimitsEnabled: data.model_limits_enabled === true,
        modelLimits: Array.isArray(data.model_limits) ? data.model_limits.filter(v => typeof v === 'string') : [],
        accountQuota: userQuota === null ? null : { available: finite(userQuota.total_available), used: finite(userQuota.total_used) },
      }
    },

    /**
     * Public price table, optionally authenticated (an identity can change the
     * ratios that come back).
     * @param {string} [credential] management or model token
     */
    async pricing(credential, { requireIdentity = false } = {}) {
      const body = await call('/api/pricing', credential === undefined ? {} : { headers: auth(credential), requireIdentity })
      return {
        rows: Array.isArray(body.data) ? body.data : [],
        groupRatio: body.group_ratio ?? {},
        usableGroup: body.usable_group ?? {},
        autoGroups: Array.isArray(body.auto_groups) ? body.auto_groups.filter(group => typeof group === 'string') : [],
      }
    },
  }
}

/** Masked key row, reduced to what a settings surface may show. */
function normalizeKey(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = finite(raw.id)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const status = finite(raw.status)
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : `#${id}`,
    maskedKey: '••••', // never trust upstream masking to exclude a full secret
    group: typeof raw.group === 'string' ? raw.group : '',
    autoGroups: Array.isArray(raw.auto_groups) ? raw.auto_groups.filter(group => typeof group === 'string') : null,
    crossGroupRetry: raw.cross_group_retry === true,
    status: status === 1 ? 'enabled' : status === 2 ? 'disabled' : status === 3 ? 'expired' : status === 4 ? 'exhausted' : 'unknown',
    unlimitedQuota: raw.unlimited_quota === true,
    remainQuota: finite(raw.remain_quota),
    usedQuota: finite(raw.used_quota),
    modelLimitsEnabled: raw.model_limits_enabled === true,
    expiresAt: finite(raw.expired_time),
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function messageFromBody(body) {
  const message = body?.message
  if (typeof message === 'string' && message.trim() !== '') return message.trim().slice(0, 300)
  return null
}

/** The scope a 403 names, when the site reports one. */
function scopeFromBody(body) {
  // The message carries the actionable scope (`api_key:write`); the code only
  // says a scope was denied, so the message wins when both are present.
  const message = messageFromBody(body) ?? ''
  const match = /api_key:\w+/.exec(message)
  if (match !== null) return match[0]
  return 'api_key'
}
