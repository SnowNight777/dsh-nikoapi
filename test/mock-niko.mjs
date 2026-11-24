import { createServer } from 'node:http'

export const PAT_FULL = 'nap_full_access'
export const PAT_READONLY = 'nap_read_only'
export const MODEL_KEY = 'sk-niko-secret-value'
export const SECOND_MODEL_KEY = 'sk-niko-second-value'
export const THIRD_MODEL_KEY = 'sk-niko-third-value'
export const TRAP_KEY_HEADER = 'authorization'
const initialKeys = [
  { id: 11, name: '开发专用 Key', key: 'DO_NOT_RETURN_sk-niko-deve****9f2c', group: 'default', auto_groups: null, status: 1, unlimited_quota: true, remain_quota: 0, used_quota: 1200, model_limits_enabled: false, expired_time: -1, cross_group_retry: false },
  { id: 12, name: '通用 Key · 名称很长用于验证换行显示不会撑破设置页', key: 'DO_NOT_RETURN_sk-niko-gen****71ab', group: 'auto', auto_groups: ['default', 'vip'], status: 1, unlimited_quota: false, remain_quota: 480000, used_quota: 20000, model_limits_enabled: true, expired_time: -1, cross_group_retry: true },
  { id: 13, name: '单独模型 Key', key: 'DO_NOT_RETURN_sk-niko-extra****f0ad', group: 'vip', auto_groups: null, status: 1, unlimited_quota: false, remain_quota: 250000, used_quota: 500, model_limits_enabled: false, expired_time: -1, cross_group_retry: false },
]
const initialKeySecrets = new Map([[11, MODEL_KEY], [12, SECOND_MODEL_KEY], [13, THIRD_MODEL_KEY]])
const initialCatalogs = new Map([[MODEL_KEY, ['gpt-test', 'claude-test']], [SECOND_MODEL_KEY, ['gpt-test', 'gemini-test']], [THIRD_MODEL_KEY, ['llama-test']]])
const initialModels = new Map([
  [MODEL_KEY, [
    { id: 'gpt-test', object: 'model', supported_endpoint_types: ['openai', 'openai-response'] },
    { id: 'claude-test', object: 'model', supported_endpoint_types: ['anthropic'] },
  ]],
  [SECOND_MODEL_KEY, [
    { id: 'gpt-test', object: 'model', supported_endpoint_types: ['openai'] },
    { id: 'gemini-test', object: 'model', supported_endpoint_types: ['gemini'] },
  ]],
  [THIRD_MODEL_KEY, [{ id: 'llama-test', object: 'model' }]],
])
function send(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}
function bearer(req) { const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? '').trim()); return match?.[1] ?? '' }
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); const text = Buffer.concat(chunks).toString('utf8'); return text.trim() ? JSON.parse(text) : {} }

export async function startMockNiko(options = {}) {
  const keys = structuredClone(initialKeys)
  const keySecrets = new Map(initialKeySecrets)
  const modelCatalogs = new Map([...initialCatalogs].map(([key, ids]) => [key, [...ids]]))
  const models = new Map([...initialModels].map(([key, rows]) => [key, structuredClone(rows)]))
  if (options.expressionModel) {
    models.set(MODEL_KEY, [...models.get(MODEL_KEY).filter(row => row.id !== 'tiered-test'), { id: 'tiered-test', object: 'model', supported_endpoint_types: ['openai'] }])
    modelCatalogs.set(MODEL_KEY, [...new Set([...modelCatalogs.get(MODEL_KEY), 'tiered-test'])])
  }
  const requests = new Map()
  const failures = new Set()
  let expression = 'p * 2'
  const seenByTrap = []
  const groupUpdates = []
  const trap = createServer((req, res) => { if (typeof req.headers[TRAP_KEY_HEADER] === 'string') seenByTrap.push(req.headers[TRAP_KEY_HEADER]); send(res, 403, { success: false, message: 'forbidden' }) })
  await listen(trap)
  const trapPort = trap.address().port
  const site = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1)
    if (failures.has(url.pathname)) return send(res, 503, { success: false, message: 'synthetic upstream unavailable' })
    const token = bearer(req)
    if (url.pathname === '/api/status') return send(res, 200, { success: true, data: { version: '2026.11.06-78a1a249', quota_per_unit: 500000, quota_display_type: 'CNY', system_name: 'NikoAPI' } })
    if (url.pathname === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${trapPort}/stolen` }); res.end(); return }
    if (url.pathname === '/api/token/') {
      if (![PAT_FULL, PAT_READONLY].includes(token)) return send(res, 401, { success: false, message: 'Unauthorized, invalid access token' })
      const size = Math.max(1, Number(url.searchParams.get('size') ?? 100))
      const page = Math.max(1, Number(url.searchParams.get('p') ?? 1))
      return send(res, 200, { success: true, data: { page, page_size: size, total: keys.length, items: keys.slice((page - 1) * size, page * size) } })
    }
    if (url.pathname === '/api/token/auto-groups') return send(res, 200, { success: true, data: { groups: ['default', 'vip'], max_count: 2 } })
    const reveal = /^\/api\/token\/(\d+)\/key$/.exec(url.pathname)
    if (reveal) {
      if (token !== PAT_FULL) return send(res, 403, { success: false, code: 'ACCESS_TOKEN_SCOPE_DENIED', message: 'The access token lacks the required permission: api_key:reveal' })
      const key = keySecrets.get(Number(reveal[1]))
      return key ? send(res, 200, { success: true, data: { key } }) : send(res, 404, { success: false, message: 'not found' })
    }
    const group = /^\/api\/token\/(\d+)\/group$/.exec(url.pathname)
    if (group) {
      if (req.method !== 'PUT') return send(res, 405, { success: false, message: 'method not allowed' })
      if (token !== PAT_FULL) return send(res, 403, { success: false, code: 'ACCESS_TOKEN_SCOPE_DENIED', message: 'The access token lacks the required permission: api_key:write' })
      const body = await readBody(req)
      const key = keys.find(row => row.id === Number(group[1]))
      if (!key) return send(res, 404, { success: false, message: 'not found' })
      if (typeof body.group !== 'string' || !body.group) return send(res, 400, { success: false, message: 'Group is required' })
      key.group = body.group
      if (Array.isArray(body.auto_groups)) key.auto_groups = body.auto_groups
      if (typeof body.cross_group_retry === 'boolean') key.cross_group_retry = body.cross_group_retry
      groupUpdates.push({ id: key.id, ...body })
      return send(res, 200, { success: true, data: key })
    }
    if (url.pathname === '/v1/models') {
      const rows = models.get(token)
      return rows ? send(res, 200, { object: 'list', data: rows }) : send(res, 401, { success: false, message: 'invalid token' })
    }
    if (url.pathname === '/api/usage/token/') {
      if (!modelCatalogs.has(token)) return send(res, 401, { success: false, message: 'Invalid Bearer token' })
      return send(res, 200, { code: true, data: { total_granted: 500000, total_used: 20000, total_available: 480000, unlimited_quota: false, model_limits_enabled: true, model_limits: modelCatalogs.get(token), expires_at: 0, user_quota: { total_available: 9000000, total_used: 1000000 } } })
    }
    if (url.pathname === '/api/pricing') return send(res, 200, { success: true, data: [
      { model_name: 'gpt-test', quota_type: 0, model_ratio: 1, completion_ratio: 2, cache_ratio: 0.1, create_cache_ratio: 0.15, enable_groups: ['default', 'vip'], supported_endpoint_types: ['openai', 'openai-response'] },
      { model_name: 'o4-mini', quota_type: 0, model_ratio: 0.55, completion_ratio: 1, enable_groups: ['GPT官key'], supported_endpoint_types: ['openai-response'] },
      { model_name: 'claude-test', quota_type: 0, model_ratio: 2, completion_ratio: 3, cache_ratio: 0.2, create_cache_ratio: 0.3, enable_groups: ['default'], supported_endpoint_types: ['anthropic'] },
      { model_name: 'gemini-test', quota_type: 0, model_ratio: 1, completion_ratio: 1.5, cache_ratio: 0.2, create_cache_ratio: 0.2, enable_groups: ['vip'], supported_endpoint_types: ['openai-response', 'gemini'] },
      { model_name: 'llama-test', quota_type: 0, model_ratio: 1, completion_ratio: 1, cache_ratio: 0.1, create_cache_ratio: 0.1, enable_groups: ['vip'] },
      { model_name: 'per-call-test', quota_type: 1, model_price: 0.02, enable_groups: ['default'] },
      { model_name: 'tiered-test', quota_type: 0, model_ratio: 1, billing_mode: 'tiered_expr', billing_expr: expression, enable_groups: ['default'] },
      { model_name: 'missing-ratio-test', quota_type: 0, model_ratio: 1, enable_groups: ['default'] },
    ], group_ratio: { default: 0.5, vip: 0.2, 'GPT官key': 0.15 }, usable_group: { default: '默认分组说明', vip: '开发分组说明', 'GPT官key': 'SVIP有效价' }, auto_groups: ['default', 'vip'] }, [PAT_FULL, PAT_READONLY].includes(token) ? { 'auth-version': 'synthetic-account-identity' } : {})
    return send(res, 404, { success: false, message: 'not found' })
  })
  await listen(site)
  return { origin: `http://127.0.0.1:${site.address().port}`, trapOrigin: `http://127.0.0.1:${trapPort}`, seenByTrap, groupUpdates, requests, failures, keys, models, modelCatalogs,
    setExpression(value) { expression = value },
    setModels(key, rows) { models.set(key, structuredClone(rows)); modelCatalogs.set(key, rows.map(row => row.id)) },
    async close() { await Promise.all([close(site), close(trap)]) } }
}
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }) }
function close(server) { return new Promise(resolve => server.close(resolve)) }
